import { describe, expect, it } from "vitest";
import { createEmptySession, validateSession } from "../src/core/session.js";
import {
  parseSessionJson,
  serializeSession,
} from "../src/core/session-serialization.js";

describe("Spider Session", () => {
  it("creates, validates, and deterministically serializes an empty session", () => {
    const session = createEmptySession("Make a portable handoff", {
      projectName: "demo",
    });
    expect(parseSessionJson(serializeSession(session))).toEqual(session);
    expect(serializeSession(session)).toBe(serializeSession(session));
  });

  it("rejects non-unique or misordered event identities and broken tool links", () => {
    const session = createEmptySession("goal");
    session.conversation.push({
      id: "e1",
      sequence: 1,
      role: "user",
      content: [{ type: "text", text: "go" }],
    });
    session.tool_calls.push({
      id: "e2",
      sequence: 2,
      name: "read",
      status: "completed",
    });
    session.tool_results.push({
      id: "e3",
      sequence: 3,
      tool_call_id: "missing",
      status: "completed",
    });
    expect(() => validateSession(session)).toThrow(/missing tool call/);
    session.tool_results[0]!.tool_call_id = "e2";
    session.commands.push({
      id: "e2",
      sequence: 4,
      command: "npm test",
      status: "succeeded",
      evidence: { source: "user", confidence: "observed" },
    });
    expect(() => validateSession(session)).toThrow(/Duplicate event id/);
  });
});
