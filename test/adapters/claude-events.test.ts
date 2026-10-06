import { describe, expect, it } from "vitest";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeEventNormalizer } from "../../src/adapters/claude/claude-events.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const UUID_A = "22222222-2222-4222-8222-222222222222";
const UUID_B = "33333333-3333-4333-8333-333333333333";

function initMessage(
  overrides: Partial<SDKSystemMessage> = {},
): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "1.0.93",
    cwd: "/work",
    tools: ["Read", "Edit", "Write", "Bash"],
    mcp_servers: [],
    model: "claude-sonnet-4-5",
    permissionMode: "default",
    uuid: UUID_A,
    session_id: SESSION_ID,
    ...overrides,
  } as unknown as SDKSystemMessage;
}

function assistantMessage(
  content: readonly unknown[],
  overrides: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_01ABC",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    parent_tool_use_id: null,
    uuid: UUID_B,
    session_id: SESSION_ID,
    ...overrides,
  } as unknown as SDKAssistantMessage;
}

function userMessage(
  content: SDKUserMessage["message"]["content"],
  overrides: Partial<SDKUserMessage> = {},
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...overrides,
  };
}

function successResult(
  overrides: Partial<SDKResultMessage> = {},
): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    result: "Task completed",
    num_turns: 2,
    duration_ms: 1_500,
    duration_api_ms: 1_400,
    is_error: false,
    session_id: SESSION_ID,
    uuid: UUID_A,
    total_cost_usd: 0.02,
    permission_denials: [],
    ...overrides,
  } as unknown as SDKResultMessage;
}

function errorResult(
  subtype: SDKResultMessage["subtype"],
  errors: readonly string[],
): SDKResultMessage {
  return {
    type: "result",
    subtype,
    errors: [...errors],
    num_turns: 1,
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: true,
    session_id: SESSION_ID,
    uuid: UUID_A,
    total_cost_usd: 0,
    permission_denials: [],
  } as unknown as SDKResultMessage;
}

function rateLimitEvent(
  status: SDKRateLimitEvent["rate_limit_info"]["status"],
  overrides: Partial<SDKRateLimitEvent["rate_limit_info"]> = {},
): SDKRateLimitEvent {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status, ...overrides },
    uuid: UUID_A,
    session_id: SESSION_ID,
  };
}

function normalize(
  messages: readonly SDKMessage[],
  cwd = "/work",
): {
  events: ReturnType<ClaudeEventNormalizer["push"]>;
  normalizer: ClaudeEventNormalizer;
} {
  const normalizer = new ClaudeEventNormalizer({ cwd });
  const events: ReturnType<ClaudeEventNormalizer["push"]> = [];
  for (const message of messages) {
    events.push(...normalizer.push(message));
  }
  return { events, normalizer };
}

describe("ClaudeEventNormalizer", () => {
  it("translates the init record into session_started", () => {
    const { events } = normalize([initMessage()]);
    expect(events).toEqual([
      {
        type: "session_started",
        provider: "claude-code",
        providerSessionId: SESSION_ID,
        metadata: {
          model: "claude-sonnet-4-5",
          claudeCodeVersion: "1.0.93",
          permissionMode: "default",
        },
      },
    ]);
  });

  it("ignores non-init system records", () => {
    const { events } = normalize([
      {
        type: "system",
        subtype: "status",
        status: "compacting",
      } as unknown as SDKMessage,
      {
        type: "system",
        subtype: "hook_started",
      } as unknown as SDKMessage,
    ]);
    expect(events).toEqual([]);
  });

  it("translates assistant text blocks into assistant_message events", () => {
    const { events } = normalize([
      assistantMessage([{ type: "text", text: "I will read the file." }]),
    ]);
    expect(events).toEqual([
      {
        type: "assistant_message",
        text: "I will read the file.",
        timestamp: null,
        providerEventId: UUID_B,
      },
    ]);
  });

  it("skips empty assistant text and thinking blocks", () => {
    const { events } = normalize([
      assistantMessage([
        { type: "thinking", thinking: "secret reasoning", signature: "sig" },
        { type: "text", text: "   " },
      ]),
    ]);
    expect(events).toEqual([]);
  });

  it("translates tool_use blocks into tool_call events with descriptions", () => {
    const { events } = normalize([
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Read",
          input: { file_path: "/work/src/auth.ts" },
        },
        {
          type: "tool_use",
          id: "toolu_02",
          name: "Bash",
          input: { command: "npm test\n", description: "Run tests" },
        },
      ]),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "tool_call",
      "tool_call",
      "command_started",
    ]);
    const readCall = events[0];
    expect(readCall).toEqual({
      type: "tool_call",
      toolCallId: "toolu_01",
      tool: "Read",
      input: { file_path: "/work/src/auth.ts" },
      description: "Read: src/auth.ts",
      timestamp: null,
      providerEventId: UUID_B,
    });
    expect(events[1]).toMatchObject({
      type: "tool_call",
      toolCallId: "toolu_02",
      tool: "Bash",
      description: "Bash: npm test",
    });
    expect(events[2]).toEqual({
      type: "command_started",
      toolCallId: "toolu_02",
      command: "npm test\n",
    });
  });

  it("keeps raw paths while making file descriptions relative", () => {
    const { events } = normalize(
      [
        assistantMessage([
          {
            type: "tool_use",
            id: "toolu_windows",
            name: "Read",
            input: { file_path: "C:\\work\\src\\auth.ts" },
          },
          {
            type: "tool_use",
            id: "toolu_relative",
            name: "Read",
            input: { file_path: "src\\routes.ts" },
          },
        ]),
      ],
      "C:\\work",
    );
    expect(events[0]).toMatchObject({
      type: "tool_call",
      input: { file_path: "C:\\work\\src\\auth.ts" },
      description: "Read: src/auth.ts",
    });
    expect(events[1]).toMatchObject({
      type: "tool_call",
      input: { file_path: "src\\routes.ts" },
      description: "Read: src/routes.ts",
    });
  });

  it("translates assistant error codes into classified error events", () => {
    const { events } = normalize([
      assistantMessage([{ type: "text", text: "x" }], {
        error: "authentication_failed",
      }),
      assistantMessage([{ type: "text", text: "y" }], {
        error: "rate_limit",
      }),
    ]);
    expect(events[0]).toMatchObject({
      type: "error",
      kind: "authentication",
      providerDetail: "authentication_failed",
    });
    expect(events[2]).toMatchObject({
      type: "error",
      kind: "rate_limit",
    });
  });

  it("translates tool_result blocks into tool_result events", () => {
    const { events } = normalize([
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Read",
          input: { file_path: "/work/src/auth.ts" },
        },
      ]),
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "file contents",
        },
      ]),
    ]);
    expect(events[1]).toEqual({
      type: "tool_result",
      toolCallId: "toolu_01",
      tool: "Read",
      output: "file contents",
      isError: false,
      timestamp: null,
      providerEventId: undefined,
    });
  });

  it("joins text blocks of a tool result", () => {
    const { events } = normalize([
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
      ]),
    ]);
    expect(events[0]).toMatchObject({
      type: "tool_result",
      tool: "unknown",
      output: "part one\npart two",
    });
  });

  it("falls back to structured tool output for results", () => {
    const { events } = normalize([
      userMessage(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: [],
          },
        ],
        { tool_use_result: { stdout: "ok", exitCode: 0 } },
      ),
    ]);
    expect(events[0]).toMatchObject({
      output: '{"stdout":"ok","exitCode":0}',
    });
  });

  it("marks tool results with is_error as failed", () => {
    const { events } = normalize([
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Bash",
          input: { command: "npm test" },
        },
      ]),
      userMessage(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: "Test failed",
            is_error: true,
          },
        ],
        { tool_use_result: { exitCode: 1 } },
      ),
    ]);
    expect(events[2]).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    expect(events[3]).toEqual({
      type: "command_finished",
      toolCallId: "toolu_01",
      command: "npm test",
      exitCode: 1,
      status: "failed",
    });
  });

  it("extracts best-effort exit codes for Bash commands", () => {
    const { events } = normalize([
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Bash",
          input: { command: "true" },
        },
      ]),
      userMessage(
        [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: "",
          },
        ],
        { tool_use_result: { exitCode: 0 } },
      ),
    ]);
    expect(events[2]).toMatchObject({
      type: "tool_result",
      toolCallId: "toolu_01",
      isError: false,
    });
    expect(events[3]).toEqual({
      type: "command_finished",
      toolCallId: "toolu_01",
      command: "true",
      exitCode: 0,
      status: "succeeded",
    });
  });

  it("derives file claims from successful file-editing tool results", () => {
    const { events } = normalize([
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Edit",
          input: {
            file_path: "/work/src/auth.ts",
            old_string: "a",
            new_string: "b",
          },
        },
      ]),
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "The file has been updated.",
        },
      ]),
    ]);
    expect(events[2]).toEqual({
      type: "file_changed",
      path: "src/auth.ts",
      change: "modified",
    });
  });

  it("derives file claims for Write and NotebookEdit tools", () => {
    const { events } = normalize([
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Write",
          input: { file_path: "/work/new-file.ts", content: "x" },
        },
      ]),
      userMessage([
        { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
      ]),
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_02",
          name: "NotebookEdit",
          input: { notebook_path: "/work/nb.ipynb", cell_id: "1" },
        },
      ]),
      userMessage([
        { type: "tool_result", tool_use_id: "toolu_02", content: "ok" },
      ]),
    ]);
    expect(events[2]).toEqual({
      type: "file_changed",
      path: "new-file.ts",
      change: "modified",
    });
    expect(events[5]).toEqual({
      type: "file_changed",
      path: "nb.ipynb",
      change: "modified",
    });
  });

  it("records no file claim when the edit failed", () => {
    const { events } = normalize([
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Edit",
          input: { file_path: "/work/src/auth.ts" },
        },
      ]),
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "old_string not found",
          is_error: true,
        },
      ]),
    ]);
    expect(events.filter((event) => event.type === "file_changed")).toEqual([]);
  });

  it("records an omission for file edits outside the working directory", () => {
    const { events } = normalize(
      [
        assistantMessage([
          {
            type: "tool_use",
            id: "toolu_01",
            name: "Edit",
            input: { file_path: "/elsewhere/secret.txt" },
          },
        ]),
        userMessage([
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: "updated",
          },
        ]),
      ],
      "/work",
    );
    expect(events[2]).toEqual({
      type: "capture_note",
      kind: "omission",
      note: "A file change outside the working directory was not recorded",
    });
  });

  it("records non-synthetic user text turns", () => {
    const { events } = normalize([
      userMessage("follow up", { uuid: UUID_A }),
      userMessage("harness note", { isSynthetic: true }),
    ]);
    expect(events).toEqual([
      {
        type: "user_message",
        text: "follow up",
        timestamp: null,
        providerEventId: UUID_A,
      },
    ]);
  });

  it("translates success results into session_completed", () => {
    const { events } = normalize([successResult()]);
    expect(events).toEqual([
      {
        type: "session_completed",
        result: "Task completed",
        turns: 2,
        totalCostUsd: 0.02,
        durationMs: 1_500,
      },
    ]);
  });

  it("translates is_error success results into session_failed", () => {
    const { events } = normalize([
      successResult({ is_error: true, result: "Not logged in" }),
    ]);
    expect(events).toEqual([
      {
        type: "session_failed",
        message: "Not logged in",
        kind: "provider",
        providerDetail: "Not logged in",
      },
    ]);
  });

  it("uses a preceding assistant error kind for is_error results", () => {
    const { events } = normalize([
      assistantMessage([{ type: "text", text: "x" }], {
        error: "rate_limit",
      }),
      successResult({ is_error: true, result: "rate limited" }),
    ]);
    expect(events[2]).toMatchObject({
      type: "session_failed",
      kind: "rate_limit",
    });
  });

  it("translates error result subtypes into session_failed", () => {
    const { events } = normalize([
      errorResult("error_max_turns", ["turn limit reached"]),
    ]);
    expect(events).toEqual([
      {
        type: "session_failed",
        message: "turn limit reached",
        kind: "limit",
        providerDetail: "turn limit reached",
      },
    ]);
  });

  it("falls back to the subtype when the error result has no messages", () => {
    const { events } = normalize([errorResult("error_during_execution", [])]);
    expect(events[0]).toMatchObject({
      type: "session_failed",
      message: "Claude run ended with error_during_execution",
      kind: "provider",
    });
  });

  it("translates rejected rate limit events into rate_limit errors", () => {
    const { events } = normalize([
      rateLimitEvent("rejected", {
        rateLimitType: "five_hour",
        utilization: 1,
      }),
    ]);
    expect(events[0]).toMatchObject({
      type: "error",
      kind: "rate_limit",
      message: expect.stringContaining("five_hour"),
    });
  });

  it("translates rate limit warnings into rate_limit errors", () => {
    const { events } = normalize([
      rateLimitEvent("allowed_warning", { utilization: 0.9 }),
    ]);
    expect(events[0]).toMatchObject({
      type: "error",
      kind: "rate_limit",
    });
  });

  it("ignores allowed rate limit events", () => {
    const { events } = normalize([rateLimitEvent("allowed")]);
    expect(events).toEqual([]);
  });

  it("ignores unknown message types safely", () => {
    const { events } = normalize([
      {
        type: "task_notification",
        task_id: "t1",
        description: "background task",
        uuid: UUID_A,
        session_id: SESSION_ID,
      } as unknown as SDKMessage,
    ]);
    expect(events).toEqual([]);
  });
});
