import { describe, expect, it } from "vitest";
import { createEmptySession } from "../src/core/session.js";
import { SessionRecorder } from "../src/adapters/agent-session.js";
import {
  buildContinuationContext,
  renderContinuationPrompt,
} from "../src/continuation/continuation.js";
import { CodexEventNormalizer } from "../src/adapters/codex/codex-events.js";

describe("cross-provider continuation", () => {
  it("builds a structured continuation context from a Claude session", () => {
    const session = createEmptySession("Implement authentication", {
      sourceAgent: "claude-code",
    });
    session.state.completed.push({
      description: "Created auth service",
      rationale: null,
      evidence: { source: "user", confidence: "observed", event_id: null },
    });
    session.state.in_progress.push({
      description: "Add tests",
      rationale: null,
      evidence: { source: "user", confidence: "observed", event_id: null },
    });
    const recorder = new SessionRecorder(session);
    recorder.apply({
      type: "user_message",
      text: "Implement authentication",
      timestamp: null,
    });
    recorder.apply({
      type: "assistant_message",
      text: "Created the auth service",
      timestamp: null,
    });
    recorder.apply({
      type: "tool_call",
      toolCallId: "call-1",
      tool: "Write",
      input: { file_path: "src/auth.ts" },
      description: "Write: src/auth.ts",
      timestamp: null,
    });
    recorder.apply({
      type: "tool_result",
      toolCallId: "call-1",
      tool: "Write",
      output: "created",
      isError: false,
      timestamp: null,
    });
    recorder.apply({
      type: "file_changed",
      path: "src/auth.ts",
      change: "created",
    });
    recorder.apply({
      type: "file_changed",
      path: "src/routes.ts",
      change: "modified",
    });

    const context = buildContinuationContext(session);
    expect(context.objective).toBe("Implement authentication");
    expect(context.sourceAgent).toBe("claude-code");
    expect(context.filesChanged).toEqual([
      { path: "src/auth.ts", change: "created" },
      { path: "src/routes.ts", change: "modified" },
    ]);
    const prompt = renderContinuationPrompt(context);
    expect(prompt).toContain("Original objective: Implement authentication");
    expect(prompt).toContain("Already completed");
    expect(prompt).toContain("Continue the existing work");
    expect(prompt).toContain("src/auth.ts");
  });

  it("feeds Codex events into the same session without Claude types", () => {
    const session = createEmptySession("Implement authentication", {
      sourceAgent: "claude-code",
    });
    const recorder = new SessionRecorder(session);
    recorder.apply({
      type: "user_message",
      text: "Implement authentication",
      timestamp: null,
    });
    const normalizer = new CodexEventNormalizer({ cwd: "/work" });
    const records = [
      { type: "thread.started", thread_id: "thread-9" },
      {
        type: "item.completed",
        item: { id: "a1", type: "agent_message", text: "adding tests" },
      },
    ];
    for (const record of records) {
      const outcome = normalizer.push(record);
      if (outcome.kind === "events") {
        for (const event of outcome.events) recorder.apply(event);
      }
    }
    expect(session.conversation.length).toBe(2);
    expect(JSON.stringify(session)).not.toContain("claude-agent-sdk");
    expect(session.extensions.codex).toMatchObject({
      providerSessionId: "thread-9",
    });
  });
});
