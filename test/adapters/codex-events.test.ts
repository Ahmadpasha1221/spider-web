import { describe, expect, it } from "vitest";
import {
  CodexEventNormalizer,
  classifyCodexMessage,
} from "../../src/adapters/codex/codex-events.js";

function normalizeEvents(
  records: readonly unknown[],
  cwd = "/work",
): {
  kind: string;
  count: number;
}[] {
  const normalizer = new CodexEventNormalizer({ cwd });
  return records.map((record) => {
    const outcome = normalizer.push(record);
    if (outcome.kind === "events") {
      return { kind: "events", count: outcome.events.length };
    }
    return { kind: outcome.kind, count: 0 };
  });
}

describe("CodexEventNormalizer", () => {
  it("maps thread.started to session_started", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const outcome = normalizer.push({
      type: "thread.started",
      thread_id: "thread-1",
    });
    expect(outcome).toEqual({
      kind: "events",
      events: [
        {
          type: "session_started",
          provider: "codex",
          providerSessionId: "thread-1",
          metadata: {},
        },
      ],
    });
  });

  it("maps agent messages and ignores reasoning", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const message = normalizer.push({
      type: "item.completed",
      item: { id: "a1", type: "agent_message", text: "done" },
    });
    expect(message.kind).toBe("events");
    const started = normalizer.push({
      type: "item.started",
      item: { id: "r1", type: "reasoning", text: "thinking" },
    });
    expect(started).toEqual({ kind: "ignored" });
  });

  it("maps command execution start and finish", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const started = normalizer.push({
      type: "item.started",
      item: { id: "c1", type: "command_execution", command: "npm test" },
    });
    expect(started.kind).toBe("events");
    const finished = normalizer.push({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "npm test",
        status: "completed",
        exit_code: 0,
        aggregated_output: "ok",
      },
    });
    expect(finished.kind).toBe("events");
    if (finished.kind === "events") {
      expect(finished.events.map((e) => e.type)).toEqual([
        "tool_result",
        "command_finished",
      ]);
    }
  });

  it("maps file changes and tool activity", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    normalizer.push({
      type: "item.started",
      item: { id: "f1", type: "file_change", path: "/work/src/a.ts" },
    });
    const finished = normalizer.push({
      type: "item.completed",
      item: { id: "f1", type: "file_change", path: "/work/src/a.ts" },
    });
    expect(finished.kind).toBe("events");
    if (finished.kind === "events") {
      expect(finished.events.some((e) => e.type === "file_changed")).toBe(true);
    }
  });

  it("maps errors and turn failures", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const failed = normalizer.push({
      type: "turn.failed",
      error: { message: "unauthorized" },
    });
    expect(failed.kind).toBe("events");
    const streamError = normalizer.push({
      type: "error",
      message: "rate limit exceeded",
    });
    expect(streamError.kind).toBe("events");
  });

  it("ignores unknown events without crashing", () => {
    const outcomes = normalizeEvents([
      { type: "something.new", data: 1 },
      { type: "item.updated", item: { id: "x", type: "reasoning" } },
      { type: "future.event", data: {} },
    ]);
    expect(outcomes).toEqual([
      { kind: "unsupported", count: 0 },
      { kind: "ignored", count: 0 },
      { kind: "unsupported", count: 0 },
    ]);
  });

  it("maps turn completion into a terminal Spider event", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const outcome = normalizer.push({ type: "turn.completed", usage: {} });
    expect(outcome.kind).toBe("events");
    if (outcome.kind === "events") {
      expect(outcome.events[0]?.type).toBe("session_completed");
    }
  });

  it("reports malformed events without throwing", () => {
    const outcomes = normalizeEvents([
      null,
      { noType: true },
      { type: "thread.started" },
      { type: "item.started" },
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);
  });

  it("classifies failure kinds", () => {
    expect(classifyCodexMessage("401 unauthorized")).toBe("authentication");
    expect(classifyCodexMessage("rate limit 429")).toBe("rate_limit");
    expect(classifyCodexMessage("billing402")).toBe("billing");
    expect(classifyCodexMessage("mystery")).toBe("provider");
  });

  it("intentionally ignores turn.started without producing unsupported diagnostic", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const outcome = normalizer.push({ type: "turn.started" });
    expect(outcome).toEqual({ kind: "ignored" });
  });

  it("normalizes realistic Codex 0.160.0 file_change events with changes array", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const started = normalizer.push({
      type: "item.started",
      item: {
        id: "item_2",
        type: "file_change",
        changes: [{ path: "/work/calculator.py", kind: "update" }],
        status: "in_progress",
      },
    });
    expect(started.kind).toBe("events");
    if (started.kind === "events") {
      const toolCall = started.events[0];
      expect(toolCall?.type).toBe("tool_call");
      if (toolCall?.type === "tool_call") {
        expect(toolCall.tool).toBe("Edit");
        expect(toolCall.input).toEqual({
          file_path: "calculator.py",
          path: "calculator.py",
        });
        expect(toolCall.description).toBe("Edit: calculator.py");
      }
    }

    const completed = normalizer.push({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "file_change",
        changes: [{ path: "/work/calculator.py", kind: "update" }],
        status: "completed",
      },
    });
    expect(completed.kind).toBe("events");
    if (completed.kind === "events") {
      const toolResult = completed.events.find((e) => e.type === "tool_result");
      const fileChange = completed.events.find(
        (e) => e.type === "file_changed",
      );
      expect(toolResult).toBeDefined();
      expect(fileChange).toEqual({
        type: "file_changed",
        path: "calculator.py",
        change: "modified",
      });
    }
  });

  it("normalizes file creation and deletion kinds", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const addOutcome = normalizer.push({
      type: "item.completed",
      item: {
        id: "item_new",
        type: "file_change",
        changes: [{ path: "/work/new_file.py", kind: "add" }],
        status: "completed",
      },
    });
    if (addOutcome.kind === "events") {
      expect(addOutcome.events.find((e) => e.type === "file_changed")).toEqual({
        type: "file_changed",
        path: "new_file.py",
        change: "created",
      });
    }

    const delOutcome = normalizer.push({
      type: "item.completed",
      item: {
        id: "item_del",
        type: "file_change",
        changes: [{ path: "/work/old_file.py", kind: "delete" }],
        status: "completed",
      },
    });
    if (delOutcome.kind === "events") {
      expect(delOutcome.events.find((e) => e.type === "file_changed")).toEqual({
        type: "file_changed",
        path: "old_file.py",
        change: "deleted",
      });
    }
  });

  it("rejects path traversal in file_change events and records an omission note", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const outcome = normalizer.push({
      type: "item.completed",
      item: {
        id: "item_bad",
        type: "file_change",
        changes: [{ path: "/work/../../outside.txt", kind: "update" }],
        status: "completed",
      },
    });
    expect(outcome.kind).toBe("events");
    if (outcome.kind === "events") {
      expect(outcome.events.some((e) => e.type === "file_changed")).toBe(false);
      const note = outcome.events.find((e) => e.type === "capture_note");
      expect(note).toBeDefined();
      if (note?.type === "capture_note") {
        expect(note.kind).toBe("omission");
        expect(note.note).toContain("escapes workspace directory");
      }
    }
  });

  it("extracts test evidence from completed unittest command executions", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const completed = normalizer.push({
      type: "item.completed",
      item: {
        id: "item_test",
        type: "command_execution",
        command: "python -m unittest discover -v",
        status: "completed",
        exit_code: 0,
        aggregated_output:
          "test_add (test_calc.TestCalc) ... ok\nRan 1 test in 0.001s\n\nOK",
      },
    });
    expect(completed.kind).toBe("events");
    if (completed.kind === "events") {
      const testEvent = completed.events.find((e) => e.type === "test");
      expect(testEvent).toEqual({
        type: "test",
        name: "unittest",
        status: "passed",
        evidenceSource: "transcript",
      });
      const cmdEvent = completed.events.find(
        (e) => e.type === "command_finished",
      );
      expect(cmdEvent).toEqual({
        type: "command_finished",
        toolCallId: "item_test",
        command: "python -m unittest discover -v",
        exitCode: 0,
        status: "succeeded",
      });
    }
  });

  it("does not generate test events for non-test commands", () => {
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const completed = normalizer.push({
      type: "item.completed",
      item: {
        id: "item_calc",
        type: "command_execution",
        command: "python calculator.py",
        status: "completed",
        exit_code: 0,
        aggregated_output: "1 + 1 = 2",
      },
    });
    expect(completed.kind).toBe("events");
    if (completed.kind === "events") {
      expect(completed.events.some((e) => e.type === "test")).toBe(false);
    }
  });
});
