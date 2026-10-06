import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude-specific run configuration. Every field is optional and
 * explicit: Spider never grants permissions, bypasses checks, or
 * injects environment variables on its own initiative.
 */
export interface ClaudeRunConfig {
  /** Tool-name rules the agent may use (CLI --allowedTools). */
  readonly allowedTools?: readonly string[];
  /** Tool-name rules the agent may not use (CLI --disallowedTools). */
  readonly disallowedTools?: readonly string[];
  /**
   * Host-side permission handler for tools that need approval.
   * When omitted, the SDK default applies (interactive prompt in
   * a terminal; denial in headless runs).
   */
  readonly canUseTool?: CanUseTool;
  /** SDK hook callbacks, keyed by hook event name. */
  readonly hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /**
   * Environment for the agent process. When set, it replaces the
   * inherited environment entirely (SDK semantics). Never set it
   * from untrusted input.
   */
  readonly env?: Record<string, string | undefined>;
  /** Absolute directories beyond the working directory the agent may access. */
  readonly additionalDirectories?: readonly string[];
}
