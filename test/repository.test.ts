import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractValidationError } from "../src/core/schema.js";
import { createEmptySession, type SpiderSession } from "../src/core/session.js";
import { writeFileAtomically } from "../src/repository/atomic-write.js";
import { LocalSessionRepository } from "../src/repository/local-session-repository.js";
import {
  createSessionStorePaths,
  sessionDirectory,
  sessionFile,
} from "../src/repository/session-store-paths.js";
import {
  SessionAlreadyExistsError,
  SessionNotFoundError,
  SessionStoreError,
  type SessionStatus,
} from "../src/repository/session-repository.js";

const ID_A = "spw_550e8400-e29b-4166-a716-446655440000";
const ID_B = "spw_6ba7b810-9dad-4166-8096-000000000000";
const ID_C = "spw_7c9e6679-3a4f-4166-9a0b-111111111111";
const ID_D = "spw_8d5f9500-1234-4166-b234-222222222222";

const atomicWriteState = vi.hoisted(() => ({ failWrites: false }));

vi.mock("../src/repository/atomic-write.js", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../src/repository/atomic-write.js");
  return {
    ...actual,
    writeFileAtomically: async (
      target: string,
      data: Uint8Array | string,
      options?: { readonly mode?: number },
    ): Promise<void> => {
      if (atomicWriteState.failWrites)
        throw new Error("injected write failure");
      await actual.writeFileAtomically(target, data, options);
    },
  };
});

const dataDirectories: string[] = [];

afterEach(async () => {
  atomicWriteState.failWrites = false;
  for (const directory of dataDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  dataDirectories.length = 0;
});

function createRepository(): {
  repository: LocalSessionRepository;
  paths: ReturnType<typeof createSessionStorePaths>;
} {
  const dataDirectory = join(
    tmpdir(),
    `spider-web-repository-${dataDirectories.length}-${Math.random().toString(36).slice(2)}`,
  );
  dataDirectories.push(dataDirectory);
  return {
    repository: new LocalSessionRepository({ dataDirectory }),
    paths: createSessionStorePaths(dataDirectory),
  };
}

function createSession(
  sessionId: string,
  goal: string,
  status: SessionStatus,
  options: { readonly updatedAt?: string } = {},
): SpiderSession {
  const session = createEmptySession(goal, {
    projectName: "test-project",
    sourceAgent: "claude-code",
  });
  session.session.id = sessionId;
  session.objective.status = status;
  if (options.updatedAt) session.session.updated_at = options.updatedAt;
  return session;
}

describe("session repository create and get", () => {
  it("stores the canonical session under sessions/<id>/", async () => {
    const { repository, paths } = createRepository();
    const session = createSession(ID_A, "carry work forward", "in_progress");
    await repository.create(session);
    const stored = await readFile(sessionFile(paths, ID_A), "utf8");
    expect(stored.length).toBeGreaterThan(0);
    expect(await repository.get(ID_A)).toEqual(session);
    expect(await repository.exists(ID_A)).toBe(true);
  });

  it("rejects duplicate session IDs", async () => {
    const { repository } = createRepository();
    await repository.create(createSession(ID_A, "goal", "in_progress"));
    await expect(
      repository.create(createSession(ID_A, "goal", "in_progress")),
    ).rejects.toThrow(SessionAlreadyExistsError);
  });

  it("rejects invalid sessions before persisting them", async () => {
    const { repository } = createRepository();
    const invalid = createSession(ID_A, "goal", "in_progress");
    (invalid.objective as { status: string }).status = "active";
    await expect(repository.create(invalid)).rejects.toThrow(
      ContractValidationError,
    );
    expect(await repository.exists(ID_A)).toBe(false);
  });

  it("returns null for unknown or malformed session IDs", async () => {
    const { repository } = createRepository();
    expect(await repository.get("spw_missing")).toBeNull();
    expect(await repository.get("../escape")).toBeNull();
    expect(await repository.get("")).toBeNull();
    expect(await repository.exists("spw_missing")).toBe(false);
  });

  it("detects a malformed stored session", async () => {
    const { repository, paths } = createRepository();
    await repository.create(createSession(ID_A, "goal", "in_progress"));
    await writeFile(sessionFile(paths, ID_A), "{ not a session", "utf8");
    await expect(repository.get(ID_A)).rejects.toThrow(SessionStoreError);
  });
});

describe("session repository update", () => {
  it("replaces a stored session and refreshes discovery metadata", async () => {
    const { repository } = createRepository();
    await repository.create(
      createSession(ID_A, "original goal", "in_progress"),
    );
    const updated = createSession(ID_A, "revised goal", "blocked");
    await repository.update(updated);
    expect(await repository.get(ID_A)).toEqual(updated);
    const summaries = await repository.list();
    expect(summaries[0]).toMatchObject({
      id: ID_A,
      title: "revised goal",
      status: "blocked",
    });
  });

  it("rejects updates to unknown sessions", async () => {
    const { repository } = createRepository();
    await expect(
      repository.update(createSession(ID_A, "goal", "in_progress")),
    ).rejects.toThrow(SessionNotFoundError);
  });

  it("rejects invalid updates and keeps the stored session", async () => {
    const { repository } = createRepository();
    const stored = createSession(ID_A, "stored goal", "in_progress");
    await repository.create(stored);
    const invalid = createSession(ID_A, "bad", "in_progress");
    (invalid.objective as { status: string }).status = "active";
    await expect(repository.update(invalid)).rejects.toThrow(
      ContractValidationError,
    );
    expect(await repository.get(ID_A)).toEqual(stored);
  });

  it("preserves the previous session when a write fails", async () => {
    const { repository, paths } = createRepository();
    const stored = createSession(ID_A, "original goal", "in_progress");
    await repository.create(stored);
    const updated = createSession(ID_A, "updated goal", "in_progress");
    atomicWriteState.failWrites = true;
    try {
      await expect(repository.update(updated)).rejects.toThrow(
        SessionStoreError,
      );
    } finally {
      atomicWriteState.failWrites = false;
    }
    expect(await repository.get(ID_A)).toEqual(stored);
    const remaining = await readdir(sessionDirectory(paths, ID_A));
    expect(remaining).toEqual(["session.json"]);
  });
});

describe("session repository delete", () => {
  it("removes the session, its directory, and its index entry", async () => {
    const { repository, paths } = createRepository();
    await repository.create(createSession(ID_A, "goal a", "in_progress"));
    await repository.create(createSession(ID_B, "goal b", "in_progress"));
    await repository.delete(ID_A);
    expect(await repository.get(ID_A)).toBeNull();
    expect(await repository.exists(ID_A)).toBe(false);
    expect((await repository.list()).map((item) => item.id)).toEqual([ID_B]);
    await expect(stat(sessionDirectory(paths, ID_A))).rejects.toThrow();
  });

  it("rejects deleting unknown or malformed session IDs", async () => {
    const { repository } = createRepository();
    await expect(repository.delete(ID_A)).rejects.toThrow(SessionNotFoundError);
    await expect(repository.delete("../escape")).rejects.toThrow(
      SessionNotFoundError,
    );
  });
});

describe("session repository listing", () => {
  it("lists summaries most recently updated first", async () => {
    const { repository } = createRepository();
    await repository.create(
      createSession(ID_A, "older", "in_progress", {
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await repository.create(
      createSession(ID_B, "newer", "blocked", {
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await repository.create(
      createSession(ID_C, "middle", "completed", {
        updatedAt: "2026-01-01T12:00:00.000Z",
      }),
    );
    expect((await repository.list()).map((item) => item.id)).toEqual([
      ID_B,
      ID_C,
      ID_A,
    ]);
  });

  it("breaks update time ties by session ID", async () => {
    const { repository } = createRepository();
    const sameTime = "2026-01-01T00:00:00.000Z";
    await repository.create(
      createSession(ID_B, "goal b", "in_progress", {
        updatedAt: sameTime,
      }),
    );
    await repository.create(
      createSession(ID_A, "goal a", "in_progress", {
        updatedAt: sameTime,
      }),
    );
    expect((await repository.list()).map((item) => item.id)).toEqual([
      ID_A,
      ID_B,
    ]);
  });

  it("returns no summaries for an empty repository", async () => {
    const { repository } = createRepository();
    expect(await repository.list()).toEqual([]);
  });

  it("finds active sessions and excludes terminal or unknown state", async () => {
    const { repository } = createRepository();
    await repository.create(
      createSession(ID_A, "active", "in_progress", {
        updatedAt: "2026-01-04T00:00:00.000Z",
      }),
    );
    await repository.create(
      createSession(ID_B, "blocked work", "blocked", {
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
    );
    await repository.create(
      createSession(ID_C, "done", "completed", {
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await repository.create(
      createSession(ID_D, "unclear", "unknown", {
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect((await repository.findActive()).map((item) => item.id)).toEqual([
      ID_A,
      ID_B,
    ]);
  });
});

describe("session repository import", () => {
  it("imports a canonical session from an Egg", async () => {
    const { repository } = createRepository();
    const session = createSession(ID_A, "recovered work", "in_progress");
    await repository.import(session);
    expect(await repository.get(ID_A)).toEqual(session);
    expect((await repository.list()).map((item) => item.id)).toEqual([ID_A]);
  });

  it("rejects duplicate and invalid imports", async () => {
    const { repository } = createRepository();
    const session = createSession(ID_A, "goal", "in_progress");
    await repository.import(session);
    await expect(repository.import(session)).rejects.toThrow(
      SessionAlreadyExistsError,
    );
    const invalid = createSession(ID_B, "bad", "in_progress");
    (invalid.objective as { status: string }).status = "active";
    await expect(repository.import(invalid)).rejects.toThrow(
      ContractValidationError,
    );
  });
});

describe("session repository index recovery", () => {
  it("recovers the index when index.json is missing or corrupted", async () => {
    const { repository, paths } = createRepository();
    await repository.create(createSession(ID_A, "goal a", "in_progress"));
    await repository.create(createSession(ID_B, "goal b", "blocked"));
    await rm(paths.indexFile);
    expect((await repository.list()).map((item) => item.id)).toEqual([
      ID_B,
      ID_A,
    ]);
    await writeFile(paths.indexFile, "corrupt {{", "utf8");
    expect((await repository.list()).map((item) => item.id)).toEqual([
      ID_B,
      ID_A,
    ]);
  });
});

describe("session repository concurrency", () => {
  it("keeps stored sessions valid when updates race", async () => {
    const { repository, paths } = createRepository();
    const base = createSession(ID_A, "base goal", "in_progress");
    await repository.create(base);
    const first = createSession(ID_A, "first goal", "in_progress");
    const second = createSession(ID_A, "second goal", "blocked");
    await Promise.all([repository.update(first), repository.update(second)]);
    const stored = await repository.get(ID_A);
    expect(["first goal", "second goal"]).toContain(stored?.objective.goal);
    // The index self-heals from the canonical session file.
    const summaries = await repository.list();
    expect(summaries[0]?.title).toBe(stored?.objective.goal);
    expect(summaries[0]?.status).toBe(stored?.objective.status);
    const remaining = await readdir(sessionDirectory(paths, ID_A));
    expect(remaining).toEqual(["session.json"]);
  });
});

describe("atomic file writes", () => {
  it("replaces file content atomically", async () => {
    const { paths } = createRepository();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.dataDirectory, { recursive: true });
    const target = join(paths.dataDirectory, "target.json");
    await writeFile(target, "previous", "utf8");
    await writeFileAtomically(target, "current");
    expect(await readFile(target, "utf8")).toBe("current");
  });

  it("cleans up the temporary file when the rename fails", async () => {
    const { paths } = createRepository();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.dataDirectory, { recursive: true });
    const blocked = join(paths.dataDirectory, "blocked");
    await mkdir(blocked);
    await expect(writeFileAtomically(blocked, "data")).rejects.toThrow();
    expect(await readdir(paths.dataDirectory)).toEqual(["blocked"]);
  });
});
