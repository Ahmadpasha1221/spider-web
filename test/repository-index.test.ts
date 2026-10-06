import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/core/json.js";
import { createEmptySession, type SpiderSession } from "../src/core/session.js";
import { serializeSession } from "../src/core/session-serialization.js";
import {
  loadSessionIndex,
  rebuildSessionIndex,
  writeSessionIndex,
  type SessionIndex,
  type SessionIndexEntry,
} from "../src/repository/session-index.js";
import {
  createSessionStorePaths,
  sessionDirectory,
  sessionFile,
  type SessionStorePaths,
} from "../src/repository/session-store-paths.js";
import { SessionStoreError } from "../src/repository/session-repository.js";

const ID_A = "spw_550e8400-e29b-4166-a716-446655440000";
const ID_B = "spw_6ba7b810-9dad-4166-8096-000000000000";
const ID_C = "spw_7c9e6679-3a4f-4166-9a0b-111111111111";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
  directories.length = 0;
});

async function createStore(): Promise<SessionStorePaths> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "spider-web-index-"));
  directories.push(dataDirectory);
  return createSessionStorePaths(dataDirectory);
}

function createSession(
  sessionId: string,
  goal: string,
  status: SpiderSession["objective"]["status"],
): SpiderSession {
  const session = createEmptySession(goal, {
    projectName: "test-project",
    sourceAgent: "claude-code",
  });
  session.session.id = sessionId;
  session.objective.status = status;
  return session;
}

async function writeSessionFile(
  paths: SessionStorePaths,
  session: SpiderSession,
): Promise<void> {
  await mkdir(sessionDirectory(paths, session.session.id), {
    recursive: true,
  });
  await writeFile(
    sessionFile(paths, session.session.id),
    serializeSession(session),
    "utf8",
  );
}

function entryOf(session: SpiderSession, mtimeMs: number): SessionIndexEntry {
  return {
    id: session.session.id,
    status: session.objective.status,
    source_agent: session.session.source_agent,
    title: session.objective.goal,
    project_name: session.session.project.name,
    created_at: session.session.created_at,
    updated_at: session.session.updated_at,
    session_file_mtime_ms: mtimeMs,
  };
}

describe("session index persistence", () => {
  it("round-trips an index through canonical JSON", async () => {
    const paths = await createStore();
    const session = createSession(ID_A, "goal", "in_progress");
    await writeSessionFile(paths, session);
    const mtimeMs = (await stat(sessionFile(paths, ID_A))).mtimeMs;
    const index: SessionIndex = {
      index_version: 1,
      sessions: [entryOf(session, mtimeMs)],
    };
    await writeSessionIndex(paths, index);
    const text = await readFile(paths.indexFile, "utf8");
    expect(text).toBe(canonicalJson(index));
    expect(text.endsWith("\n")).toBe(false);
    expect(await loadSessionIndex(paths)).toEqual(index);
  });

  it("rejects invalid index shapes and duplicate entries", async () => {
    const paths = await createStore();
    const session = createSession(ID_A, "goal", "in_progress");
    const base = entryOf(session, 1);
    const invalid: SessionIndex = {
      index_version: 99,
      sessions: [base],
    };
    await expect(writeSessionIndex(paths, invalid)).rejects.toThrow(
      SessionStoreError,
    );
    await expect(
      writeSessionIndex(paths, {
        index_version: 1,
        sessions: [base, { ...base }],
      }),
    ).rejects.toThrow(SessionStoreError);
    await expect(
      writeSessionIndex(paths, {
        index_version: 1,
        sessions: [{ ...base, status: "active" as never }],
      }),
    ).rejects.toThrow(SessionStoreError);
  });
});

describe("session index recovery", () => {
  it("returns an empty index when nothing is stored", async () => {
    const paths = await createStore();
    expect((await loadSessionIndex(paths)).sessions).toEqual([]);
    expect((await rebuildSessionIndex(paths)).sessions).toEqual([]);
  });

  it("rebuilds a missing index from the stored sessions", async () => {
    const paths = await createStore();
    await writeSessionFile(paths, createSession(ID_A, "goal a", "in_progress"));
    await writeSessionFile(paths, createSession(ID_B, "goal b", "blocked"));
    const index = await loadSessionIndex(paths);
    expect(index.sessions.map((entry) => entry.id)).toEqual([ID_A, ID_B]);
    expect(index.sessions[0]?.title).toBe("goal a");
    expect(index.sessions[0]?.status).toBe("in_progress");
    expect(index.sessions[0]?.source_agent).toBe("claude-code");
    expect(index.sessions[0]?.project_name).toBe("test-project");
    // The rebuilt index is persisted for later loads.
    expect((await loadSessionIndex(paths)).sessions).toHaveLength(2);
  });

  it("rebuilds when index.json is corrupted", async () => {
    const paths = await createStore();
    await writeSessionFile(paths, createSession(ID_A, "goal", "in_progress"));
    await loadSessionIndex(paths);
    await writeFile(paths.indexFile, "not json {{{", "utf8");
    const index = await loadSessionIndex(paths);
    expect(index.sessions.map((entry) => entry.id)).toEqual([ID_A]);
  });

  it("rebuilds when a stored session changed after the index was written", async () => {
    const paths = await createStore();
    await writeSessionFile(
      paths,
      createSession(ID_A, "old goal", "in_progress"),
    );
    await loadSessionIndex(paths);
    // The session file changes without the index being updated.
    await writeSessionFile(paths, createSession(ID_A, "new goal", "blocked"));
    const summaries = await loadSessionIndex(paths);
    expect(summaries.sessions[0]?.title).toBe("new goal");
    expect(summaries.sessions[0]?.status).toBe("blocked");
  });

  it("rebuilds when a session directory is removed directly", async () => {
    const paths = await createStore();
    await writeSessionFile(paths, createSession(ID_A, "goal a", "in_progress"));
    await writeSessionFile(paths, createSession(ID_B, "goal b", "in_progress"));
    await loadSessionIndex(paths);
    await rm(sessionDirectory(paths, ID_A), {
      recursive: true,
      force: true,
    });
    const index = await loadSessionIndex(paths);
    expect(index.sessions.map((entry) => entry.id)).toEqual([ID_B]);
  });

  it("detects a malformed stored session instead of hiding it", async () => {
    const paths = await createStore();
    await mkdir(sessionDirectory(paths, ID_A), { recursive: true });
    await writeFile(sessionFile(paths, ID_A), "garbage", "utf8");
    await expect(loadSessionIndex(paths)).rejects.toThrow(SessionStoreError);
    await expect(rebuildSessionIndex(paths)).rejects.toThrow(SessionStoreError);
  });

  it("ignores entries that are not stored sessions", async () => {
    const paths = await createStore();
    await mkdir(paths.sessionsDirectory, { recursive: true });
    // A plain file and a non-ID directory are not sessions.
    await writeFile(
      join(paths.sessionsDirectory, "temp.txt"),
      "file, not directory",
      "utf8",
    );
    await mkdir(join(paths.sessionsDirectory, "not-a-session-id"), {
      recursive: true,
    });
    // A valid session ID directory without a session.json is a
    // crash remnant from an interrupted create, not a session.
    await mkdir(sessionDirectory(paths, ID_C), { recursive: true });
    const index = await loadSessionIndex(paths);
    expect(index.sessions).toEqual([]);
  });
});
