import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAgentRunner,
  buildCodexArgs,
} from "../../src/adapters/codex/codex-runner.js";
import type {
  CodexChildProcess,
  CodexSpawnFunction,
} from "../../src/adapters/codex/codex-types.js";
import type {
  CodexLaunchStrategy,
  ResolvedCodexExecutable,
} from "../../src/adapters/codex/codex-executable.js";
import { LocalSessionRepository } from "../../src/repository/local-session-repository.js";
import { createEmptySession } from "../../src/core/session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function lines(stdout: readonly string[]): Readable {
  const stream = new Readable({ read() {} });
  for (const line of stdout) stream.push(`${line}\n`);
  stream.push(null);
  return stream;
}

function fakeSpawn(stdout: readonly string[]): {
  spawn: CodexSpawnFunction;
  seen: {
    binary: string;
    args: readonly string[];
    launcher: CodexLaunchStrategy | undefined;
  }[];
} {
  const seen: {
    binary: string;
    args: readonly string[];
    launcher: CodexLaunchStrategy | undefined;
  }[] = [];
  const listeners = new Map<string, ((code: number | null) => void)[]>();
  const fake: CodexChildProcess = {
    stdout: lines(stdout),
    stderr: lines([]),
    stdin: null,
    kill: () => true,
    once: (
      event: "close" | "error",
      listener:
        | ((code: number | null, _signal: string | null) => void)
        | ((error: Error) => void),
    ) => {
      if (event !== "close") return;
      const closeListener = listener as (
        code: number | null,
        _signal: string | null,
      ) => void;
      const list = listeners.get(event) ?? [];
      list.push((code: number | null) => closeListener(code, null));
      listeners.set(event, list);
    },
  };
  const spawn: CodexSpawnFunction = (binary, args, options) => {
    seen.push({ binary, args, launcher: options.launcher });
    queueMicrotask(() => {
      for (const listener of listeners.get("close") ?? []) {
        listener(0);
      }
    });
    void options;
    return fake;
  };
  return { spawn, seen };
}

describe("CodexAgentRunner", () => {
  it("records a Codex JSONL run with incremental persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-codex-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const { spawn } = fakeSpawn([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "a1", type: "agent_message", text: "fix applied" },
      }),
    ]);
    const runner = new CodexAgentRunner({ repository, spawn });
    const run = await runner.start({
      prompt: "Fix the bug",
      cwd: process.cwd(),
    });
    const outcome = await run.wait();
    expect(outcome).toEqual({ status: "completed" });
    const session = await repository.get(run.sessionId);
    expect(session).not.toBeNull();
    expect(run.providerSessionId).toBe("thread-1");
    expect(
      session?.conversation.some((m) =>
        m.content.some(
          (p) => p.type === "text" && p.text?.includes("fix applied"),
        ),
      ),
    ).toBe(true);
    expect(session?.extensions).toMatchObject({
      codex: { providerSessionId: "thread-1" },
    });
  });

  it("survives provider failure with usable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-codex-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const { spawn } = fakeSpawn([
      JSON.stringify({ type: "thread.started", thread_id: "thread-2" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "a1", type: "agent_message", text: "partial work" },
      }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "boom" },
      }),
    ]);
    const runner = new CodexAgentRunner({ repository, spawn });
    const run = await runner.start({ prompt: "Do work", cwd: process.cwd() });
    await run.wait();
    const session = await repository.get(run.sessionId);
    expect(session?.conversation.length).toBeGreaterThan(1);
    expect(session?.errors.length).toBeGreaterThan(0);
  });

  it("appends continuation events to the existing Spider session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-codex-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const source = createEmptySession("Implement authentication", {
      sourceAgent: "claude-code",
    });
    await repository.create(source);
    const { spawn } = fakeSpawn([
      JSON.stringify({ type: "thread.started", thread_id: "thread-next" }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ]);
    const runner = new CodexAgentRunner({ repository, spawn });

    const run = await runner.start(
      { prompt: "Continue the pending work", cwd: process.cwd() },
      { session: source },
    );
    const outcome = await run.wait();
    const session = await repository.get(source.session.id);

    expect(outcome.status).toBe("completed");
    expect(run.sessionId).toBe(source.session.id);
    expect(session?.session.source_agent).toBe("claude-code");
    expect(session?.extensions.codex).toMatchObject({
      providerSessionId: "thread-next",
    });
    expect(session?.conversation.length).toBeGreaterThan(0);
  });

  it("rejects dangerous bypass without an explicit flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-codex-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const { spawn } = fakeSpawn([]);
    const runner = new CodexAgentRunner({ repository, spawn });
    await expect(
      runner.start(
        {
          prompt: "x",
          cwd: process.cwd(),
          permissionMode: "bypass-permissions",
        },
        {},
      ),
    ).rejects.toThrow("allowDangerousBypass");
  });

  it("passes a Windows shim launch strategy to the process seam", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-codex-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const { spawn, seen } = fakeSpawn([
      JSON.stringify({ type: "thread.started", thread_id: "thread-shim" }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ]);
    const resolved: ResolvedCodexExecutable = {
      binary: "C:\\fake\\npm\\codex.cmd",
      launcher: "windows-command-shim",
    };
    const runner = new CodexAgentRunner({
      repository,
      spawn,
      resolveExecutable: () => resolved,
    });
    const prompt = 'Fix "a && b", $(echo bad), & whoami';
    await (await runner.start({ prompt, cwd: process.cwd() })).wait();
    expect(seen[0]).toMatchObject({
      binary: resolved.binary,
      launcher: "windows-command-shim",
    });
    expect(seen[0]?.args.at(-1)).toBe(prompt);
  });

  it("rejects an invalid working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-codex-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const runner = new CodexAgentRunner({
      repository,
      spawn: fakeSpawn([]).spawn,
    });
    await expect(
      runner.start({
        prompt: "x",
        cwd: join(directory, "missing"),
      }),
    ).rejects.toThrow("Working directory does not exist");
  });
});

describe("buildCodexArgs", () => {
  it("does not include --ask-for-approval in default arguments", () => {
    const args = buildCodexArgs(
      { prompt: "Fix the bug", cwd: "." },
      {},
      "read-only",
    );
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("on-request");
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args.slice(0, 4)).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
    ]);
    expect(args).toEqual(expect.arrayContaining(["--cd", resolve(".")]));
    expect(args.at(-1)).toBe("Fix the bug");
  });

  it("does not generate unsupported CLI argument when approvalPolicy is on-request", () => {
    const args = buildCodexArgs(
      { prompt: "Run task", cwd: "." },
      { approvalPolicy: "on-request" },
      "workspace-write",
    );
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("on-request");
    expect(args).not.toContain("--approve-for-me");
  });

  it("does not generate unsafe bypass flag when approvalPolicy is never", () => {
    const args = buildCodexArgs(
      { prompt: "Run task", cwd: "." },
      { approvalPolicy: "never" },
      "read-only",
    );
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("never");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--approve-for-me");
  });

  it("preserves sandbox configuration for all sandbox modes", () => {
    const readOnlyArgs = buildCodexArgs(
      { prompt: "inspect", cwd: "." },
      {},
      "read-only",
    );
    expect(readOnlyArgs).toContain("--sandbox");
    expect(readOnlyArgs[readOnlyArgs.indexOf("--sandbox") + 1]).toBe(
      "read-only",
    );

    const writeArgs = buildCodexArgs(
      { prompt: "edit", cwd: "." },
      {},
      "workspace-write",
    );
    expect(writeArgs).toContain("--sandbox");
    expect(writeArgs[writeArgs.indexOf("--sandbox") + 1]).toBe(
      "workspace-write",
    );

    const dangerArgs = buildCodexArgs(
      { prompt: "danger", cwd: "." },
      {},
      "danger-full-access",
    );
    expect(dangerArgs).toContain("--sandbox");
    expect(dangerArgs[dangerArgs.indexOf("--sandbox") + 1]).toBe(
      "danger-full-access",
    );
  });

  it("always includes --json flag", () => {
    const args = buildCodexArgs(
      { prompt: "json output", cwd: "." },
      {},
      "read-only",
    );
    expect(args).toContain("--json");
  });

  it("includes --cd with the resolved working directory", () => {
    const testDir = join(".", "some", "path");
    const args = buildCodexArgs(
      { prompt: "cd test", cwd: testDir },
      {},
      "read-only",
    );
    const cdIndex = args.indexOf("--cd");
    expect(cdIndex).toBeGreaterThanOrEqual(0);
    expect(args[cdIndex + 1]).toBe(resolve(testDir));
  });

  it("preserves model option when specified", () => {
    const argsWithModel = buildCodexArgs(
      { prompt: "with model", cwd: ".", model: "o3-mini" },
      {},
      "read-only",
    );
    expect(argsWithModel).toContain("--model");
    expect(argsWithModel[argsWithModel.indexOf("--model") + 1]).toBe("o3-mini");

    const argsWithoutModel = buildCodexArgs(
      { prompt: "no model", cwd: "." },
      {},
      "read-only",
    );
    expect(argsWithoutModel).not.toContain("--model");
  });

  it("preserves resume-thread option when configured", () => {
    const args = buildCodexArgs(
      { prompt: "resume task", cwd: "." },
      { resumeThreadId: "th-abc-123" },
      "read-only",
    );
    const resumeIndex = args.indexOf("resume");
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(args[resumeIndex + 1]).toBe("th-abc-123");
  });

  it("preserves ephemeral option when configured", () => {
    const args = buildCodexArgs(
      { prompt: "ephemeral run", cwd: "." },
      { ephemeral: true },
      "read-only",
    );
    expect(args).toContain("--ephemeral");

    const defaultArgs = buildCodexArgs(
      { prompt: "persistent run", cwd: "." },
      {},
      "read-only",
    );
    expect(defaultArgs).not.toContain("--ephemeral");
  });

  it("preserves skipGitRepoCheck option when configured", () => {
    const args = buildCodexArgs(
      { prompt: "skip git check", cwd: "." },
      { skipGitRepoCheck: true },
      "read-only",
    );
    expect(args).toContain("--skip-git-repo-check");
  });

  it("preserves extra arguments before the prompt", () => {
    const args = buildCodexArgs(
      { prompt: "extra args task", cwd: "." },
      { extraArgs: ["--color", "never"] },
      "read-only",
    );
    const promptIndex = args.indexOf("extra args task");
    const colorIndex = args.indexOf("--color");
    expect(colorIndex).toBeGreaterThanOrEqual(0);
    expect(args[colorIndex + 1]).toBe("never");
    expect(colorIndex).toBeLessThan(promptIndex);
  });

  it("ensures prompt remains the final positional argument", () => {
    const args = buildCodexArgs(
      { prompt: "final positional prompt", cwd: ".", model: "o3" },
      {
        resumeThreadId: "th-xyz",
        ephemeral: true,
        skipGitRepoCheck: true,
        extraArgs: ["--custom-flag"],
      },
      "workspace-write",
    );
    expect(args.at(-1)).toBe("final positional prompt");
  });

  it("regression: does not pass unsupported --ask-for-approval to Codex 0.160.0 CLI", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "spider-web-codex-regression-"),
    );
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const { spawn, seen } = fakeSpawn([
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread-regression",
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ]);
    const runner = new CodexAgentRunner({ repository, spawn });

    await (
      await runner.start(
        {
          prompt: "Inspect this project and run tests",
          cwd: process.cwd(),
        },
        {
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
        },
      )
    ).wait();

    expect(seen.length).toBe(1);
    const spawnedArgs = seen[0]!.args;
    // Codex 0.160.0 rejects `--ask-for-approval` with:
    // "error: unexpected argument '--ask-for-approval' found"
    expect(spawnedArgs).not.toContain("--ask-for-approval");
    expect(spawnedArgs).not.toContain("on-request");
    expect(spawnedArgs).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--cd",
      resolve(process.cwd()),
      "Inspect this project and run tests",
    ]);
  });
});
