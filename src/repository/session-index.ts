import { readdir, readFile, stat } from "node:fs/promises";
import { canonicalJson, parseStrictJson } from "../core/json.js";
import type { SpiderSession } from "../core/session.js";
import { parseSessionJson } from "../core/session-serialization.js";
import { writeFileAtomically } from "./atomic-write.js";
import {
  isValidSessionId,
  sessionFile,
  type SessionStorePaths,
} from "./session-store-paths.js";
import {
  SessionStoreError,
  type SessionStatus,
  type SessionSummary,
} from "./session-repository.js";

export const SESSION_INDEX_VERSION = 1;

const KNOWN_STATUSES: readonly SessionStatus[] = [
  "in_progress",
  "blocked",
  "completed",
  "unknown",
];

/**
 * One discovery entry in the local index. The index is a rebuildable
 * cache over the canonical `sessions/<id>/session.json` files; it
 * never stores conversation or tool content. `session_file_mtime_ms`
 * is internal consistency metadata used to detect a stale index.
 */
export interface SessionIndexEntry {
  readonly id: string;
  readonly status: SessionStatus;
  readonly source_agent: string;
  readonly title: string;
  readonly project_name: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly session_file_mtime_ms: number;
}

export interface SessionIndex {
  readonly index_version: number;
  readonly sessions: readonly SessionIndexEntry[];
}

export function toSessionSummary(entry: SessionIndexEntry): SessionSummary {
  return {
    id: entry.id,
    status: entry.status,
    source_agent: entry.source_agent,
    title: entry.title,
    project_name: entry.project_name,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

export function toSessionIndexEntry(
  session: SpiderSession,
  sessionFileMtimeMs: number,
): SessionIndexEntry {
  return {
    id: session.session.id,
    status: session.objective.status,
    source_agent: session.session.source_agent,
    title: session.objective.goal,
    project_name: session.session.project.name,
    created_at: session.session.created_at,
    updated_at: session.session.updated_at,
    session_file_mtime_ms: sessionFileMtimeMs,
  };
}

export function validateSessionIndex(
  value: unknown,
): asserts value is SessionIndex {
  if (typeof value !== "object" || value === null)
    throw new SessionStoreError("Session index is not an object");
  const candidate = value as Partial<SessionIndex>;
  if (candidate.index_version !== SESSION_INDEX_VERSION)
    throw new SessionStoreError(
      `Unsupported session index version: ${String(candidate.index_version)}`,
    );
  if (!Array.isArray(candidate.sessions))
    throw new SessionStoreError("Session index sessions is not a list");
  const ids = new Set<string>();
  for (const entry of candidate.sessions) {
    if (typeof entry !== "object" || entry === null)
      throw new SessionStoreError("Session index entry is not an object");
    const item = entry as Partial<SessionIndexEntry>;
    if (
      typeof item.id !== "string" ||
      typeof item.status !== "string" ||
      typeof item.source_agent !== "string" ||
      typeof item.title !== "string" ||
      (item.project_name !== null && typeof item.project_name !== "string") ||
      typeof item.created_at !== "string" ||
      typeof item.updated_at !== "string" ||
      typeof item.session_file_mtime_ms !== "number" ||
      !Number.isFinite(item.session_file_mtime_ms)
    ) {
      throw new SessionStoreError("Session index entry has invalid fields");
    }
    if (!KNOWN_STATUSES.includes(item.status as SessionStatus))
      throw new SessionStoreError(
        `Session index entry has an unknown status: ${item.status}`,
      );
    if (item.source_agent.length === 0)
      throw new SessionStoreError("Session index entry has an empty agent");
    if (ids.has(item.id))
      throw new SessionStoreError(`Duplicate session index entry: ${item.id}`);
    ids.add(item.id);
  }
}

/** Read and fully validate a stored session. Returns null when absent. */
export async function readStoredSession(
  paths: SessionStorePaths,
  sessionId: string,
): Promise<SpiderSession | null> {
  const file = sessionFile(paths, sessionId);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw new SessionStoreError(`Could not read stored session ${sessionId}`, {
      cause: error,
    });
  }
  try {
    return parseSessionJson(text);
  } catch (error) {
    throw new SessionStoreError(
      `Stored session ${sessionId} is not a valid Spider Session`,
      { cause: error },
    );
  }
}

async function sessionFileMtime(
  paths: SessionStorePaths,
  sessionId: string,
): Promise<number> {
  const metadata = await stat(sessionFile(paths, sessionId));
  return metadata.mtimeMs;
}

interface ScannedSession {
  readonly id: string;
  readonly mtimeMs: number;
}

/**
 * List stored session IDs with their file mtimes, without reading
 * session content. Directories that are not valid session IDs
 * (crash remnants, unrelated files) and symlinks are skipped.
 */
async function scanSessionStore(
  paths: SessionStorePaths,
): Promise<ScannedSession[]> {
  let entries;
  try {
    entries = await readdir(paths.sessionsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw new SessionStoreError("Could not read the session store", {
      cause: error,
    });
  }
  const scanned: ScannedSession[] = [];
  for (const entry of entries) {
    // Dirent checks do not follow symlinks, so planted symlinks are skipped.
    if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
    const id = entry.name;
    try {
      scanned.push({ id, mtimeMs: await sessionFileMtime(paths, id) });
    } catch (error) {
      // A directory without a readable session.json is not a session.
      if (isFileNotFound(error)) continue;
      throw error;
    }
  }
  return scanned;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isIndexFresh(index: SessionIndex, scanned: ScannedSession[]): boolean {
  if (scanned.length !== index.sessions.length) return false;
  const mtimes = new Map(scanned.map((item) => [item.id, item.mtimeMs]));
  for (const entry of index.sessions) {
    const mtimeMs = mtimes.get(entry.id);
    if (mtimeMs === undefined) return false;
    if (mtimeMs !== entry.session_file_mtime_ms) return false;
  }
  return true;
}

function compareEntriesById(
  a: SessionIndexEntry,
  b: SessionIndexEntry,
): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Rebuild the index from the canonical session files. Throws when a
 * stored session is malformed, so corruption is detected rather than
 * silently hidden. Directories without a `session.json` are skipped.
 */
export async function rebuildSessionIndex(
  paths: SessionStorePaths,
): Promise<SessionIndex> {
  const scanned = await scanSessionStore(paths);
  const entries: SessionIndexEntry[] = [];
  for (const { id, mtimeMs } of scanned) {
    const session = await readStoredSession(paths, id);
    if (session === null) continue;
    entries.push(toSessionIndexEntry(session, mtimeMs));
  }
  entries.sort(compareEntriesById);
  return { index_version: SESSION_INDEX_VERSION, sessions: entries };
}

/** Persist the index atomically. */
export async function writeSessionIndex(
  paths: SessionStorePaths,
  index: SessionIndex,
): Promise<void> {
  validateSessionIndex(index);
  await writeFileAtomically(paths.indexFile, canonicalJson(index));
}

/**
 * Load the index, recovering when it is missing, malformed, or stale.
 *
 * The stored index is only trusted when its session IDs and recorded
 * file mtimes match the session store; otherwise the index is rebuilt
 * from the canonical session files. This heals the case where a
 * session file was written but the index update failed. A rebuilt
 * index is persisted best-effort: reads never fail because the cache
 * could not be refreshed, and the next operation retries.
 */
export async function loadSessionIndex(
  paths: SessionStorePaths,
): Promise<SessionIndex> {
  const scanned = await scanSessionStore(paths);
  let stored: SessionIndex | null = null;
  try {
    const text = await readFile(paths.indexFile, "utf8");
    const value = parseStrictJson(text);
    validateSessionIndex(value);
    stored = value;
  } catch {
    // A missing, unreadable, malformed, or invalid index is stale.
    stored = null;
  }
  if (stored && isIndexFresh(stored, scanned)) return stored;
  const rebuilt = await rebuildSessionIndex(paths);
  try {
    await writeSessionIndex(paths, rebuilt);
  } catch {
    // The index is a cache; the rebuilt index is still correct.
  }
  return rebuilt;
}
