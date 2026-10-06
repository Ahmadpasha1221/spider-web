import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/adapters/agent-runner.js";
import { SessionRecorder } from "../../src/adapters/agent-session.js";
import {
  createEmptySession,
  validateSession,
  type SpiderSession,
} from "../../src/core/session.js";

function recorder(
  session: SpiderSession = createEmptySession("goal"),
): SessionRecorder {
  return new SessionRecorder(session);
}

function userText(text: string): AgentEvent {
  return { type: "user_message", text, timestamp: null };
}

function assistantText(text: string): AgentEvent {
  return { type: "assistant_message", text, timestamp: null };
}

function toolCall(
  toolCallId: string,
  tool: string,
  input: unknown = {},
): AgentEvent {
  return {
    type: "tool_call",
    toolCallId,
    tool,
    input,
    description: `${tool}: ${toolCallId}`,
    timestamp: null,
  };
}

function toolResult(
  toolCallId: string,
  output: string,
  isError = false,
): AgentEvent {
  return {
    type: "tool_result",
    toolCallId,
    tool: "Bash",
    output,
    isError,
    timestamp: null,
  };
}

describe("SessionRecorder", () => {
  it("records conversation events with evidence and sequences", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply(userText("do the thing"));
    recorderInstance.apply(assistantText("on it"));
    expect(session.conversation).toEqual([
      {
        id: "e1",
        sequence: 1,
        role: "user",
        content: [{ type: "text", text: "do the thing" }],
        timestamp: null,
        handoff_relevant: true,
        evidence: {
          source: "user",
          confidence: "observed",
          event_id: null,
        },
      },
      {
        id: "e2",
        sequence: 2,
        role: "assistant",
        content: [{ type: "text", text: "on it" }],
        timestamp: null,
        handoff_relevant: true,
        evidence: {
          source: "transcript",
          confidence: "observed",
          event_id: null,
        },
      },
    ]);
    validateSession(session);
  });

  it("records provider metadata on session_started", () => {
    const session = createEmptySession("goal");
    recorder(session).apply({
      type: "session_started",
      provider: "claude-code",
      providerSessionId: SESSION_ID,
      metadata: { model: "claude-sonnet-4-5" },
    });
    expect(session.extensions["claude-code"]).toEqual({
      providerSessionId: SESSION_ID,
      model: "claude-sonnet-4-5",
    });
  });

  it("records tool calls and correlates their results", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply(toolCall("toolu_01", "Bash", { command: "ls" }));
    recorderInstance.apply(toolResult("toolu_01", "file.txt"));
    expect(session.tool_calls).toHaveLength(1);
    expect(session.tool_calls[0]?.status).toBe("completed");
    expect(session.tool_results).toEqual([
      {
        id: "e2",
        sequence: 2,
        tool_call_id: "e1",
        status: "completed",
        output: "file.txt",
        timestamp: null,
        evidence: {
          source: "transcript",
          confidence: "observed",
          event_id: null,
        },
      },
    ]);
    validateSession(session);
  });

  it("marks tool calls failed when the result is an error", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply(toolCall("toolu_01", "Bash"));
    recorderInstance.apply(toolResult("toolu_01", "boom", true));
    expect(session.tool_calls[0]?.status).toBe("failed");
    expect(session.tool_results[0]?.status).toBe("failed");
  });

  it("records an omission for results without a matching call", () => {
    const session = createEmptySession("goal");
    recorder(session).apply(toolResult("toolu_missing", "orphan"));
    expect(session.tool_results).toEqual([]);
    expect(session.capture.omissions).toEqual([
      "tool result for tool use toolu_missing was not recorded because its tool call was not captured",
    ]);
  });

  it("tracks the current task from tool calls", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply(toolCall("toolu_01", "Read", {}));
    expect(session.state.current_task).toBe("Read: toolu_01");
    recorderInstance.apply({
      type: "session_completed",
      result: "done",
      turns: 1,
      totalCostUsd: null,
      durationMs: 10,
    });
    expect(session.state.current_task).toBeNull();
  });

  it("records file claims by change kind", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply({
      type: "file_changed",
      path: "src/new.ts",
      change: "created",
    });
    recorderInstance.apply({
      type: "file_changed",
      path: "src/edit.ts",
      change: "modified",
    });
    recorderInstance.apply({
      type: "file_changed",
      path: "src/gone.ts",
      change: "deleted",
    });
    expect(session.files.created.map((claim) => claim.path)).toEqual([
      "src/new.ts",
    ]);
    expect(session.files.modified.map((claim) => claim.path)).toEqual([
      "src/edit.ts",
    ]);
    expect(session.files.deleted.map((claim) => claim.path)).toEqual([
      "src/gone.ts",
    ]);
    for (const claim of session.files.created) {
      expect(claim.evidence.source).toBe("adapter-derived");
    }
  });

  it("records command pairs for command activity", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply({
      type: "command_started",
      toolCallId: "toolu_01",
      command: "npm test",
    });
    recorderInstance.apply({
      type: "command_finished",
      toolCallId: "toolu_01",
      command: "npm test",
      exitCode: 1,
      status: "failed",
    });
    expect(session.commands.map((command) => command.status)).toEqual([
      "running",
      "failed",
    ]);
    expect(session.commands[1]?.exit_code).toBe(1);
    validateSession(session);
  });

  it("records errors with their evidence source", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply({
      type: "error",
      message: "provider failure",
      kind: "provider",
      evidenceSource: "transcript",
    });
    recorderInstance.apply({
      type: "error",
      message: "stopped by request",
      kind: "cancellation",
      evidenceSource: "adapter-derived",
    });
    expect(session.errors.map((error) => error.description)).toEqual([
      "provider failure",
      "stopped by request",
    ]);
    expect(session.errors[0]?.evidence.source).toBe("transcript");
    expect(session.errors[1]?.evidence.source).toBe("adapter-derived");
  });

  it("records completion state and provider run summary", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply({
      type: "session_started",
      provider: "claude-code",
      providerSessionId: SESSION_ID,
      metadata: {},
    });
    recorderInstance.apply({
      type: "session_completed",
      result: "all done",
      turns: 3,
      totalCostUsd: 0.05,
      durationMs: 1_000,
    });
    expect(session.objective.status).toBe("completed");
    expect(session.next_action).toBeNull();
    expect(session.state.completed).toHaveLength(1);
    expect(session.state.completed[0]?.description).toBe("all done");
    expect(session.extensions["claude-code"]).toEqual({
      providerSessionId: SESSION_ID,
      run: {
        completedAt: expect.any(String),
        turns: 3,
        totalCostUsd: 0.05,
        durationMs: 1_000,
      },
    });
  });

  it("records failure state with a blocked item and next action", () => {
    const session = createEmptySession("goal");
    recorder(session).apply({
      type: "session_failed",
      message: "rate limited",
      kind: "rate_limit",
    });
    expect(session.objective.status).toBe("blocked");
    expect(session.state.blocked).toHaveLength(1);
    expect(session.state.blocked[0]?.description).toBe("rate limited");
    expect(session.errors).toHaveLength(1);
    expect(session.next_action?.description).toBe(
      "Resolve the recorded failure, then resume the session.",
    );
    validateSession(session);
  });

  it("records unexpected process exits as blocked sessions", () => {
    const session = createEmptySession("goal");
    recorder(session).apply({ type: "process_exited", code: null });
    expect(session.objective.status).toBe("blocked");
    expect(session.errors[0]?.description).toBe(
      "Agent process ended without a completion result",
    );
    expect(session.state.blocked).toHaveLength(1);
    expect(session.next_action?.description).toBe(
      "Resume the session to continue the work.",
    );
  });

  it("routes capture notes to omissions and truncations", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    recorderInstance.apply({
      type: "capture_note",
      kind: "omission",
      note: "omitted detail",
    });
    recorderInstance.apply({
      type: "capture_note",
      kind: "truncation",
      note: "truncated detail",
    });
    expect(session.capture.omissions).toEqual(["omitted detail"]);
    expect(session.capture.truncations).toEqual(["truncated detail"]);
  });

  it("bounds oversized tool inputs and outputs", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    const largeInput = { file_path: "a".repeat(10_000) };
    recorderInstance.apply(toolCall("toolu_01", "Write", largeInput));
    recorderInstance.apply(toolResult("toolu_01", "b".repeat(20_000)));
    const callInput = session.tool_calls[0]?.input;
    expect(typeof callInput).toBe("string");
    expect(String(callInput)).toContain("[truncated]");
    expect(session.tool_results[0]?.output).toContain("[truncated]");
    expect(session.capture.truncations).toEqual([
      "tool call e1 input truncated to 4096 bytes",
      "tool result e2 output truncated to 16384 bytes",
    ]);
    validateSession(session);
  });

  it("continues sequences from a pre-populated session", () => {
    const session = createEmptySession("goal");
    const first = recorder(session);
    first.apply(userText("one"));
    const second = recorder(session);
    second.apply(assistantText("two"));
    expect(session.conversation.map((event) => event.sequence)).toEqual([1, 2]);
    expect(session.conversation.map((event) => event.id)).toEqual(["e1", "e2"]);
  });

  it("keeps the session valid after every applied event", () => {
    const session = createEmptySession("goal");
    const recorderInstance = recorder(session);
    const events: AgentEvent[] = [
      userText("goal"),
      assistantText("working"),
      toolCall("toolu_01", "Bash", { command: "ls" }),
      {
        type: "command_started",
        toolCallId: "toolu_01",
        command: "ls",
      },
      toolResult("toolu_01", "a\nb"),
      {
        type: "command_finished",
        toolCallId: "toolu_01",
        command: "ls",
        exitCode: 0,
        status: "succeeded",
      },
      {
        type: "file_changed",
        path: "src/a.ts",
        change: "modified",
      },
      {
        type: "error",
        message: "transient",
        kind: "provider",
        evidenceSource: "transcript",
      },
      {
        type: "session_completed",
        result: "done",
        turns: 1,
        totalCostUsd: null,
        durationMs: 1,
      },
    ];
    for (const event of events) {
      recorderInstance.apply(event);
      validateSession(session);
    }
  });

  it("refreshes updated_at when touched", () => {
    const session = createEmptySession("goal");
    const before = session.session.updated_at;
    recorder(session).touch();
    expect(session.session.updated_at >= before).toBe(true);
  });
});

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
