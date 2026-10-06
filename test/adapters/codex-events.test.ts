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
      { kind: "ignored", count: 0 },
      { kind: "ignored", count: 0 },
      { kind: "ignored", count: 0 },
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
});
