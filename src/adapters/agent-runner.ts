/**
 * Provider-neutral interface for driving a live agent session.
 *
 * This is the *live runner* role of the adapter boundary: start an
 * agent process, feed it prompts, observe normalized events, and stop
 * it. It is deliberately separate from the read-only `AgentAdapter`
 * capture role in capabilities.ts (detect / capture / import existing
 * agent sessions). A provider adapter may implement either or both
 * roles; the canonical core depends only on these neutral shapes.
 */

/**
 * Provider-neutral failure taxonomy. Adapters map provider-specific
 * error codes onto these kinds so callers can reason about failures
 * without knowing the provider.
 */
export type AgentErrorKind =
  /** Credentials rejected, organization not allowed, account on hold. */
  | "authentication"
  /** Billing failure on the provider side. */
  | "billing"
  /** Provider rate or usage quota hit. */
  | "rate_limit"
  /** Provider reports it is overloaded. */
  | "overloaded"
  /** Caller-configured run limit reached (turns, budget). */
  | "limit"
  /** Other provider-side failure. */
  | "provider"
  /** Voluntary stop requested through the adapter. */
  | "cancellation"
  /** Agent process failed, exited, or could not be controlled. */
  | "process"
  /** Failure cause could not be classified. */
  | "unknown";

export type AgentRunStatus =
  "starting" | "running" | "completed" | "failed" | "cancelled";

/**
 * Permission posture for a run. The adapter maps these onto the
 * provider's own permission modes. `bypass-permissions` skips all
 * permission checks and is only ever used when the caller requests
 * it explicitly; Spider never escalates permissions on its own.
 */
export type AgentPermissionMode =
  "default" | "accept-edits" | "plan" | "bypass-permissions";

export interface AgentError {
  readonly kind: AgentErrorKind;
  readonly message: string;
  /** Raw provider-side detail, when the provider exposed one. */
  readonly providerDetail?: string;
}

export interface AgentStartOptions {
  readonly prompt: string;
  /** Absolute working directory for the agent process. */
  readonly cwd: string;
  readonly projectName?: string | null;
  readonly permissionMode?: AgentPermissionMode;
  readonly model?: string;
  /** Maximum turns for the run, when the provider supports it. */
  readonly maxTurns?: number;
  /** Maximum spend in USD for the run, when the provider supports it. */
  readonly maxBudgetUsd?: number;
  /**
   * Keep the agent process alive after the initial prompt so further
   * prompts can be sent with {@link AgentRun.send}.
   */
  readonly interactive?: boolean;
}

export interface AgentRunOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  readonly error?: AgentError;
}

export interface AgentRun {
  /** Spider session ID this run records into. */
  readonly sessionId: string;
  readonly provider: string;
  status: AgentRunStatus;
  /** Provider-side session identifier, once the provider reports one. */
  providerSessionId: string | null;
  /**
   * Queue another user prompt. Only meaningful while an interactive
   * run is in progress.
   */
  send(input: string): Promise<void>;
  /**
   * Stop the run using the provider's supported interruption
   * mechanism. Safe to call more than once.
   */
  stop(): Promise<void>;
  /** Resolve once the agent has stopped, with the run outcome. */
  wait(): Promise<AgentRunOutcome>;
}

export interface AgentRunner {
  readonly provider: string;
  start(options: AgentStartOptions): Promise<AgentRun>;
}

export class AgentRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRunError";
  }
}

/**
 * Normalized agent events. Adapters translate provider-specific
 * stream records into this union; the session recorder and callers
 * consume only these shapes.
 */
export interface AgentSessionStartedEvent {
  readonly type: "session_started";
  readonly provider: string;
  readonly providerSessionId: string;
  readonly metadata: Record<string, unknown>;
}

export interface AgentUserMessageEvent {
  readonly type: "user_message";
  readonly text: string;
  readonly timestamp: string | null;
  readonly providerEventId?: string;
}

export interface AgentAssistantMessageEvent {
  readonly type: "assistant_message";
  readonly text: string;
  readonly timestamp: string | null;
  readonly providerEventId?: string;
}

export interface AgentToolCallEvent {
  readonly type: "tool_call";
  /** Provider-side tool-use identifier, used to correlate results. */
  readonly toolCallId: string;
  readonly tool: string;
  readonly input: unknown;
  /** Short human-readable activity summary. */
  readonly description: string;
  readonly timestamp: string | null;
  readonly providerEventId?: string;
}

export interface AgentToolResultEvent {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly tool: string;
  readonly output: string;
  readonly isError: boolean;
  readonly timestamp: string | null;
  readonly providerEventId?: string;
}

export interface AgentFileChangedEvent {
  readonly type: "file_changed";
  /** Relative POSIX path inside the working directory. */
  readonly path: string;
  readonly change: "created" | "modified" | "deleted";
}

export interface AgentCommandStartedEvent {
  readonly type: "command_started";
  readonly toolCallId: string;
  readonly command: string;
}

export interface AgentCommandFinishedEvent {
  readonly type: "command_finished";
  readonly toolCallId: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly status: "succeeded" | "failed";
}

export interface AgentErrorEvent {
  readonly type: "error";
  readonly message: string;
  readonly kind: AgentErrorKind;
  readonly providerDetail?: string;
  readonly evidenceSource: "transcript" | "adapter-derived";
}

export interface AgentSessionCompletedEvent {
  readonly type: "session_completed";
  readonly result: string;
  readonly turns: number;
  readonly totalCostUsd: number | null;
  readonly durationMs: number | null;
}

export interface AgentSessionFailedEvent {
  readonly type: "session_failed";
  readonly message: string;
  readonly kind: AgentErrorKind;
  readonly providerDetail?: string;
}

export interface AgentProcessExitedEvent {
  readonly type: "process_exited";
  readonly code: number | null;
}

export interface AgentCaptureNoteEvent {
  readonly type: "capture_note";
  readonly kind: "omission" | "truncation";
  readonly note: string;
}

export type AgentEvent =
  | AgentSessionStartedEvent
  | AgentUserMessageEvent
  | AgentAssistantMessageEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentFileChangedEvent
  | AgentCommandStartedEvent
  | AgentCommandFinishedEvent
  | AgentErrorEvent
  | AgentSessionCompletedEvent
  | AgentSessionFailedEvent
  | AgentProcessExitedEvent
  | AgentCaptureNoteEvent;

/** Terminal events decide the run outcome; all others are observations. */
export function isTerminalAgentEvent(
  event: AgentEvent,
): event is AgentSessionCompletedEvent | AgentSessionFailedEvent {
  return event.type === "session_completed" || event.type === "session_failed";
}
