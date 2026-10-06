import { lstat, mkdir, rm, stat } from "node:fs/promises";
import { validateSession, type SpiderSession } from "../core/session.js";
import {
  serializeSession,
  writeSessionJsonFile,
} from "../core/session-serialization.js";
import { writeFileAtomically } from "./atomic-write.js";
import {
  SESSION_INDEX_VERSION,
  loadSessionIndex,
  readStoredSession,
  toSessionIndexEntry,
  toSessionSummary,
  writeSessionIndex,
  type SessionIndex,
  type SessionIndexEntry,
} from "./session-index.js";
import {
  createSessionStorePaths,
  isValidSessionId,
  resolveSpiderDataDirectory,
  sessionDirectory,
  sessionFile,
  type SessionStorePaths,
} from "./session-store-paths.js";
import {
  SessionAlreadyExistsError,
  SessionNotFoundError,
  SessionStoreError,
  type SessionRepository,
  type SessionSummary,
} from "./session-repository.js";

export interface LocalSessionRepositoryOptions {
  /**
   * Data directory to use. Defaults to the platform-appropriate
   * Spider Web data directory. Injectable for tests and isolated
   * environments.
   */
  readonly dataDirectory?: string;
}

const SESSION_DIRECTORY_MODE = 0o700;

function compareSummaries(a: SessionSummary, b: SessionSummary): number {
  if (a.updated_at !== b.updated_at)
    return a.updated_at > b.updated_at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function compareEntriesById(
  a: SessionIndexEntry,
  b: SessionIndexEntry,
): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

async function storedSessionMtime(
  paths: SessionStorePaths,
  sessionId: string,
): Promise<number> {
  try {
    const metadata = await stat(sessionFile(paths, sessionId));
    return metadata.mtimeMs;
  } catch (error) {
    throw new SessionStoreError(
      `Could not inspect stored session ${sessionId}`,
      { cause: error },
    );
  }
}

/**
 * Filesystem-backed, provider-neutral local session repository.
 *
 * Each session is stored as the canonical Spider Session at
 * `sessions/<id>/session.json`. `index.json` is a rebuildable
 * discovery cache. Creation writes the session file exclusively
 * (existing files are never overwritten); updates replace the
 * session file atomically, so a failed update always leaves the
 * previous valid session intact.
 *
 * Concurrency: writes to the same session are last-write-wins at
 * the file level; per-file atomic writes prevent corruption, and
 * there is no cross-process locking in this phase.
 */
export class LocalSessionRepository implements SessionRepository {
  private readonly paths: SessionStorePaths;

  constructor(options: LocalSessionRepositoryOptions = {}) {
    const dataDirectory = options.dataDirectory ?? resolveSpiderDataDirectory();
    this.paths = createSessionStorePaths(dataDirectory);
  }

  async create(session: SpiderSession): Promise<void> {
    validateSession(session);
    const sessionId = session.session.id;
    if (await this.exists(sessionId)) {
      throw new SessionAlreadyExistsError(
        `Session already exists: ${sessionId}`,
      );
    }
    // mkdir is recursive so an interrupted create that left an
    // empty session directory does not block a retry; the
    // exclusive session-file write below is the real guard.
    const directory = sessionDirectory(this.paths, sessionId);
    try {
      await mkdir(directory, {
        recursive: true,
        mode: SESSION_DIRECTORY_MODE,
      });
      await writeSessionJsonFile(sessionFile(this.paths, sessionId), session);
    } catch (error) {
      throw new SessionStoreError(`Could not persist session ${sessionId}`, {
        cause: error,
      });
    }
    await this.refreshIndex(session.session.id);
  }

  async get(sessionId: string): Promise<SpiderSession | null> {
    // IDs that cannot match the schema never name a session.
    if (!isValidSessionId(sessionId)) return null;
    return readStoredSession(this.paths, sessionId);
  }

  async update(session: SpiderSession): Promise<void> {
    validateSession(session);
    const sessionId = session.session.id;
    if (!(await this.exists(sessionId))) {
      throw new SessionNotFoundError(`Session not found: ${sessionId}`);
    }
    try {
      await writeFileAtomically(
        sessionFile(this.paths, sessionId),
        serializeSession(session),
      );
    } catch (error) {
      throw new SessionStoreError(`Could not persist session ${sessionId}`, {
        cause: error,
      });
    }
    await this.refreshIndex(session.session.id);
  }

  async delete(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId) || !(await this.exists(sessionId))) {
      throw new SessionNotFoundError(`Session not found: ${sessionId}`);
    }
    const directory = sessionDirectory(this.paths, sessionId);
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory()) {
        throw new SessionStoreError(
          `Session store entry ${sessionId} is not a directory`,
        );
      }
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError(`Could not delete session ${sessionId}`, {
        cause: error,
      });
    }
    const index = await loadSessionIndex(this.paths);
    const updated: SessionIndex = {
      index_version: SESSION_INDEX_VERSION,
      sessions: index.sessions.filter((entry) => entry.id !== sessionId),
    };
    await writeSessionIndex(this.paths, updated);
  }

  async list(): Promise<SessionSummary[]> {
    const index = await loadSessionIndex(this.paths);
    return index.sessions
      .map((entry) => toSessionSummary(entry))
      .sort(compareSummaries);
  }

  async exists(sessionId: string): Promise<boolean> {
    if (!isValidSessionId(sessionId)) return false;
    try {
      const metadata = await stat(sessionFile(this.paths, sessionId));
      return metadata.isFile();
    } catch {
      return false;
    }
  }

  async findActive(): Promise<SessionSummary[]> {
    const sessions = await this.list();
    return sessions.filter(
      (session) =>
        session.status === "in_progress" || session.status === "blocked",
    );
  }

  async import(session: SpiderSession): Promise<void> {
    // Importing stores a validated canonical session. It refuses
    // duplicate IDs so importing never silently overwrites work.
    await this.create(session);
  }

  /**
   * Refresh the index entry for a stored session.
   *
   * The entry is derived from the canonical session file, not
   * from the caller's in-memory copy, and the file is stat'd
   * before it is read. When a concurrent write replaces the
   * session file between the stat and the read, the recorded
   * mtime is older than the file's current mtime, so the next
   * index load detects staleness and rebuilds from the file
   * instead of serving mismatched metadata.
   */
  private async refreshIndex(sessionId: string): Promise<void> {
    const mtimeMs = await storedSessionMtime(this.paths, sessionId);
    const stored = await readStoredSession(this.paths, sessionId);
    const index = await loadSessionIndex(this.paths);
    const entries = index.sessions.filter((entry) => entry.id !== sessionId);
    if (stored !== null) {
      entries.push(toSessionIndexEntry(stored, mtimeMs));
    }
    entries.sort(compareEntriesById);
    const updated: SessionIndex = {
      index_version: SESSION_INDEX_VERSION,
      sessions: entries,
    };
    await writeSessionIndex(this.paths, updated);
  }
}
