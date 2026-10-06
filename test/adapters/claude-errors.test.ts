import { describe, expect, it } from "vitest";
import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import {
  classifyAssistantError,
  classifyResultError,
  classifyThrownError,
} from "../../src/adapters/claude/claude-errors.js";

describe("classifyAssistantError", () => {
  it("classifies authentication failures", () => {
    for (const error of [
      "authentication_failed",
      "oauth_org_not_allowed",
      "account_on_hold",
      "verification_required",
      "cloud_credential_error",
    ] as const) {
      expect(classifyAssistantError(error)).toBe("authentication");
    }
  });

  it("classifies billing, rate limit, and overload separately", () => {
    expect(classifyAssistantError("billing_error")).toBe("billing");
    expect(classifyAssistantError("rate_limit")).toBe("rate_limit");
    expect(classifyAssistantError("overloaded")).toBe("overloaded");
  });

  it("classifies remaining provider errors as provider failures", () => {
    for (const error of [
      "invalid_request",
      "model_not_found",
      "max_output_tokens",
      "server_error",
      "unknown",
    ] as const) {
      expect(classifyAssistantError(error)).toBe("provider");
    }
  });
});

describe("classifyResultError", () => {
  it("prefers a structured assistant error observed earlier", () => {
    expect(classifyResultError("error_during_execution", "rate_limit")).toBe(
      "rate_limit",
    );
    expect(classifyResultError("error_max_budget_usd", "authentication")).toBe(
      "authentication",
    );
  });

  it("classifies caller-configured limits as limit failures", () => {
    expect(classifyResultError("error_max_budget_usd", null)).toBe("limit");
    expect(classifyResultError("error_max_turns", null)).toBe("limit");
  });

  it("classifies other error results as provider failures", () => {
    expect(classifyResultError("error_during_execution", null)).toBe(
      "provider",
    );
    expect(
      classifyResultError("error_max_structured_output_retries", null),
    ).toBe("provider");
  });
});

describe("classifyThrownError", () => {
  it("classifies SDK abort errors as cancellation", () => {
    const error = classifyThrownError(new AbortError("aborted"));
    expect(error).toEqual({ kind: "cancellation", message: "aborted" });
  });

  it("classifies other Errors as process failures", () => {
    const error = classifyThrownError(new Error("CLI crashed"));
    expect(error).toEqual({ kind: "process", message: "CLI crashed" });
  });

  it("classifies non-Error throws as unknown", () => {
    expect(classifyThrownError("boom")).toEqual({
      kind: "unknown",
      message: "boom",
    });
  });
});
