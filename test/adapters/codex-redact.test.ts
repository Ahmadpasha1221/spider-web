import { describe, expect, it } from "vitest";
import {
  redactSecrets,
  redactValue,
} from "../../src/adapters/codex/codex-redact.js";

describe("codex redaction", () => {
  it("redacts OpenAI-style keys", () => {
    const text = "using sk-proj-Abc123Def456Ghi789Jkl012 here";
    const out = redactSecrets(text);
    expect(out).not.toContain("sk-proj-Abc123Def456");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts assignment-style env secrets", () => {
    const out = redactSecrets('export OPENAI_API_KEY="sk-abc123def456ghi789"');
    expect(out).not.toContain("sk-abc123def456ghi789");
    expect(out).toContain("OPENAI_API_KEY=");
  });

  it("redacts bearer tokens and authorization headers", () => {
    const out = redactSecrets(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N99I9",
    );
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    const text = "Run `npm test` then commit src/auth.ts";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts sensitive keys inside structured tool payloads", () => {
    const value = redactValue({
      api_key: "sk-secretvalue123456",
      nested: { refreshToken: "rt-abcdef123456", command: "ls" },
      list: ["OPENAI_API_KEY=sk-alphabeta123456"],
    }) as Record<string, unknown>;
    expect(value.api_key).toBe("[REDACTED]");
    const nested = value.nested as Record<string, unknown>;
    expect(nested.refreshToken).toBe("[REDACTED]");
    expect(nested.command).toBe("ls");
    expect(JSON.stringify(value)).not.toContain("sk-alphabeta123456");
  });
});
