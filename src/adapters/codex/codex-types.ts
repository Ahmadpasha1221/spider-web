import type { Readable, Writable } from "node:stream";
import type { SpiderSession } from "../../core/session.js";
import type { CodexLaunchStrategy } from "./codex-executable.js";

/**
 * Codex provider identity used in Spider provenance, session
 * `source_agent` values, and `extensions.codex` metadata.
 */
export const CODEX_PROVIDER_ID = "codex";

/**
 * Sandbox posture for a `codex exec` run. These are the documented
 * `--sandbox` values for non-interactive Codex runs. Spider's
 * default is `read-only`; anything broader requires an explicit
 * caller decision (see {@link CodexRunConfig}).
 */
export type CodexSandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";

export type CodexApprovalPolicy = "on-request" | "never";

/**
 * Minimal child-process surface the Codex runner needs. The real
 * `node:child_process` ChildProcess satisfies this interface;
 * tests substitute a deterministic fake.
 */
export interface CodexChildProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  kill(signal?: number | string): boolean;
  once(
    event: "close",
    listener: (code: number | null, signal: string | null) => void,
  ): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export type CodexSpawnFunction = (
  binary: string,
  args: readonly string[],
  options: { cwd: string; launcher?: CodexLaunchStrategy },
) => CodexChildProcess;

/**
 * Codex-specific run configuration. Every field is optional and
 * explicit: Spider never grants permissions, bypasses approvals,
 * or injects environment variables on its own initiative.
 *
 * Integration surface: the documented `codex exec --json`
 * non-interactive JSONL stream. The app-server transport is
 * explicitly experimental and unsupported for production use in
 * the official Codex documentation, so Spider does not use it.
 */
export interface CodexRunConfig {
  /** Append this Codex run to an existing Spider session. */
  readonly session?: SpiderSession;
  /**
   * Sandbox for model-generated commands. Overrides the mapping
   * from {@link AgentPermissionMode}. Passing
   * `danger-full-access` here is an explicit caller decision.
   */
  readonly sandbox?: CodexSandboxMode;
  /**
   * Provider-mediated approval policy; never is the non-interactive mode.
   *
   * Note on Codex 0.160.0: The non-interactive `codex exec` CLI does not
   * expose `--ask-for-approval`. Enforcing `never` cannot currently be
   * mapped to CLI flags without dangerous bypasses
   * (`--dangerously-bypass-approvals-and-sandbox`), so Spider retains this
   * field for provider-neutral capability tracking while omitting unsupported
   * CLI flags until capability negotiation is introduced.
   */
  readonly approvalPolicy?: CodexApprovalPolicy;
  /** Codex executable to spawn. Defaults to `codex` on PATH. */
  readonly codexBinary?: string;
  /**
   * Provider-native resume: continue an existing Codex thread
   * (`codex exec resume <thread-id>`) instead of starting a new
   * one. This resumes the *provider* thread; cross-provider
   * continuation (Claude Spider session -> new Codex thread) does
   * not use this field.
   */
  readonly resumeThreadId?: string;
  /** Run without persisting Codex rollout files (`--ephemeral`). */
  readonly ephemeral?: boolean;
  /** Allow running outside a Git repository. */
  readonly skipGitRepoCheck?: boolean;
  /**
   * Required to map `bypass-permissions` onto
   * `danger-full-access`. Spider never escalates permissions on
   * its own; without this flag (or an explicit `sandbox`
   * override) a `bypass-permissions` request is rejected.
   */
  readonly allowDangerousBypass?: boolean;
  /** Additional raw CLI args appended before the prompt. */
  readonly extraArgs?: readonly string[];
  /** Test seam: replaces the child-process spawn. */
  readonly spawn?: CodexSpawnFunction;
}
