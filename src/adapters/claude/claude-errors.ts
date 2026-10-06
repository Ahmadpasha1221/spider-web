import { AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { AgentError, AgentErrorKind } from "../agent-runner.js";
import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

/**
 * Map an error code carried on an SDK assistant message onto the
 * provider-neutral failure taxonomy. These codes are the SDK's
 * documented structured error surface for API-side failures.
 */
export function classifyAssistantError(
  error: SDKAssistantMessageError,
): AgentErrorKind {
  switch (error) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
    case "cloud_credential_error":
      return "authentication";
    case "billing_error":
      return "billing";
    case "rate_limit":
      return "rate_limit";
    case "overloaded":
      return "overloaded";
    case "invalid_request":
    case "model_not_found":
    case "max_output_tokens":
    case "server_error":
    case "unknown":
    default:
      return "provider";
  }
}

/**
 * Map a terminal SDK error result onto the neutral taxonomy.
 * A structured assistant error observed earlier in the run is
 * more precise than the result subtype, so it takes precedence
 * when present.
 */
export function classifyResultError(
  resultSubtype: string,
  lastAssistantErrorKind: AgentErrorKind | null,
): AgentErrorKind {
  if (lastAssistantErrorKind !== null) return lastAssistantErrorKind;
  switch (resultSubtype) {
    case "error_max_budget_usd":
    case "error_max_turns":
      return "limit";
    case "error_max_structured_output_retries":
    case "error_during_execution":
    default:
      return "provider";
  }
}

/** Classify an exception thrown while driving the agent SDK. */
export function classifyThrownError(error: unknown): AgentError {
  if (error instanceof AbortError) {
    return {
      kind: "cancellation",
      message:
        typeof error.message === "string" && error.message.length > 0
          ? error.message
          : "Run aborted",
    };
  }
  if (error instanceof Error) {
    return { kind: "process", message: error.message };
  }
  return { kind: "unknown", message: String(error) };
}
