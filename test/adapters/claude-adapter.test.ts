import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeAgentRunner,
  type ClaudeQueryFunction,
} from "../../src/adapters/claude/claude-adapter.js";
import { LocalSessionRepository } from "../../src/repository/local-session-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sdkMessages(sessionId: string): SDKMessage[] {
  return [
    {
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      claude_code_version: "1.0.0",
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
      model: "claude-test",
      permissionMode: "default",
      uuid: "system-1",
      session_id: sessionId,
    } as unknown as SDKMessage,
    {
      type: "assistant",
      message: {
        id: "assistant-1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "The task is complete." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: "assistant-1",
    } as unknown as SDKMessage,
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 10,
      duration_api_ms: 8,
      num_turns: 1,
      result: "The task is complete.",
      session_id: sessionId,
      total_cost_usd: 0,
      usage: {},
      permission_denials: [],
      uuid: "result-1",
    } as unknown as SDKMessage,
  ];
}

function fakeQuery(messages: SDKMessage[]): ClaudeQueryFunction {
  return (() => {
    const generator = (async function* () {
      yield* messages;
    })();
    return Object.assign(generator, {
      interrupt: async () => undefined,
    });
  }) as ClaudeQueryFunction;
}

describe("ClaudeAgentRunner", () => {
  it("records a successful SDK run into the local session repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-claude-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const runner = new ClaudeAgentRunner({
      repository,
      query: fakeQuery(sdkMessages("claude-session-1")),
    });

    const run = await runner.start({
      prompt: "Finish the implementation",
      cwd: process.cwd(),
      projectName: "fixture",
    });
    const outcome = await run.wait();
    const session = await repository.get(run.sessionId);
    expect(session).not.toBeNull();
    if (session === null) throw new Error("session was not persisted");

    expect(outcome).toEqual({ status: "completed" });
    expect(run.providerSessionId).toBe("claude-session-1");
    expect(session.objective.status).toBe("completed");
    expect(
      session.conversation.flatMap((message) =>
        message.content.map((part) => (part.type === "text" ? part.text : "")),
      ),
    ).toContain("The task is complete.");
    expect(session.extensions).toMatchObject({
      "claude-code": { providerSessionId: "claude-session-1" },
    });
  });

  it("reports an incomplete stream as a process failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-claude-"));
    temporaryDirectories.push(directory);
    const repository = new LocalSessionRepository({ dataDirectory: directory });
    const runner = new ClaudeAgentRunner({
      repository,
      query: fakeQuery(sdkMessages("claude-session-2").slice(0, 1)),
    });

    const run = await runner.start({ prompt: "Continue", cwd: process.cwd() });
    const outcome = await run.wait();
    const session = await repository.get(run.sessionId);
    expect(session).not.toBeNull();
    if (session === null) throw new Error("session was not persisted");

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("process");
    expect(session.errors.at(-1)?.description).toContain(
      "without a completion result",
    );
  });
});
