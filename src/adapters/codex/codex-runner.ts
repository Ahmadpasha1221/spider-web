import { spawn as nodeSpawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createEmptySession } from "../../core/session.js";
import type { SessionRepository } from "../../repository/session-repository.js";
import {
  AgentRunError,
  isTerminalAgentEvent,
  type AgentEvent,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunOutcome,
  type AgentRunStatus,
  type AgentRunner,
  type AgentStartOptions,
} from "../agent-runner.js";
import { SessionRecorder } from "../agent-session.js";
import { CodexEventNormalizer, classifyCodexMessage } from "./codex-events.js";
import { readJsonLines, recordStderr } from "./codex-stream.js";
import {
  CODEX_PROVIDER_ID,
  type CodexRunConfig,
  type CodexSandboxMode,
  type CodexSpawnFunction,
} from "./codex-types.js";
import {
  buildWindowsCommandLine,
  resolveCodexExecutable,
  type ResolvedCodexExecutable,
} from "./codex-executable.js";

export interface CodexAgentRunnerOptions {
  readonly repository: SessionRepository;
  readonly spawn?: CodexSpawnFunction;
  readonly resolveExecutable?: (
    explicitBinary?: string,
  ) => ResolvedCodexExecutable;
  readonly onEvent?: (event: AgentEvent) => void;
}
const SANDBOX_BY_PERMISSION: Record<AgentPermissionMode, CodexSandboxMode> = {
  default: "read-only",
  "accept-edits": "workspace-write",
  plan: "read-only",
  "bypass-permissions": "danger-full-access",
};

export class CodexAgentRunner implements AgentRunner {
  readonly provider = CODEX_PROVIDER_ID;
  private readonly spawnFn: CodexSpawnFunction;
  constructor(private readonly options: CodexAgentRunnerOptions) {
    this.spawnFn =
      options.spawn ??
      ((binary, args, spawnOptions) =>
        nodeSpawn(
          spawnOptions.launcher === "windows-command-shim" ? "cmd.exe" : binary,
          spawnOptions.launcher === "windows-command-shim"
            ? ["/d", "/s", "/c", `"${buildWindowsCommandLine(binary, args)}"`]
            : [...args],
          {
            cwd: spawnOptions.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsVerbatimArguments:
              spawnOptions.launcher === "windows-command-shim",
          },
        ));
  }
  async start(
    options: AgentStartOptions,
    config: CodexRunConfig = {},
  ): Promise<AgentRun> {
    const cwd = resolvePath(options.cwd);
    let directory: ReturnType<typeof statSync>;
    try {
      directory = statSync(cwd);
    } catch {
      throw new AgentRunError(`Working directory does not exist: ${cwd}`);
    }
    if (!directory.isDirectory()) {
      throw new AgentRunError(`Working directory is not a directory: ${cwd}`);
    }
    const sandbox = resolveSandbox(options.permissionMode ?? "default", config);
    const session =
      config.session ??
      createEmptySession(options.prompt, {
        projectName: options.projectName ?? null,
        sourceAgent: this.provider,
      });
    if (config.session === undefined) {
      await this.options.repository.create(session);
    } else {
      session.session.updated_at = new Date().toISOString();
      await this.options.repository.update(session);
    }
    const normalizer = new CodexEventNormalizer({ cwd });
    const recorder = new SessionRecorder(session);
    const run = new CodexAgentRun(session.session.id, this.provider);
    const controls: RunControls = {
      run,
      normalizer,
      recorder,
      stopRequested: false,
      child: null,
    };
    run.attach(controls);
    recorder.apply({
      type: "user_message",
      text: options.prompt,
      timestamp: new Date().toISOString(),
    });
    await this.persist(recorder);
    const spawnWith = config.spawn ?? this.spawnFn;
    // Only resolve the executable if using the default spawn function.
    // Custom spawn functions (e.g., in tests) handle binary resolution themselves.
    const shouldResolve =
      this.options.spawn === undefined ||
      this.options.resolveExecutable !== undefined;
    let resolved: {
      binary: string;
      launcher: "direct" | "windows-command-shim";
    };
    try {
      resolved = shouldResolve
        ? (this.options.resolveExecutable ?? resolveCodexExecutable)(
            config.codexBinary,
          )
        : {
            binary: config.codexBinary ?? "codex",
            launcher: "direct",
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recorder.apply({
        type: "session_failed",
        message,
        kind: "process",
        providerDetail: message,
      });
      await this.persist(recorder);
      throw new AgentRunError(message, { cause: error });
    }
    const args = buildCodexArgs(options, config, sandbox);
    let child: ReturnType<CodexSpawnFunction>;
    try {
      child = spawnWith(resolved.binary, args, {
        cwd,
        launcher: resolved.launcher,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message =
        code === "ENOENT"
          ? `Codex executable not found: ${resolved.binary}`
          : "Could not start Codex";
      recorder.apply({
        type: "session_failed",
        message,
        kind: "process",
        providerDetail: message,
      });
      await this.persist(recorder);
      throw new AgentRunError(message, { cause: error });
    }
    controls.child = child;
    void this.drive(controls, child);
    return run;
  }
  private async persist(recorder: SessionRecorder): Promise<void> {
    recorder.touch();
    await this.options.repository.update(recorder.session);
  }
  private async drive(
    controls: RunControls,
    child: ReturnType<CodexSpawnFunction>,
  ): Promise<void> {
    const { run, recorder, normalizer } = controls;
    let outcome: AgentRunOutcome | null = null;
    let sawTerminal = false;
    const emit = (event: AgentEvent): void => {
      recorder.apply(event);
      this.options.onEvent?.(event);
      if (event.type === "session_started")
        run.providerSessionId = event.providerSessionId;
      if (isTerminalAgentEvent(event)) {
        sawTerminal = true;
        run.status =
          event.type === "session_completed" ? "completed" : "failed";
      }
    };
    const onLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        recorder.apply({
          type: "capture_note",
          kind: "omission",
          note: "Codex emitted a non-JSON line that was not recorded",
        });
        await this.persist(recorder);
        return;
      }
      const normalized = normalizer.push(parsed);
      if (normalized.kind === "ignored") {
        const type =
          typeof parsed === "object" && parsed !== null && "type" in parsed
            ? String((parsed as { type: unknown }).type)
            : "unknown";
        recorder.apply({
          type: "capture_note",
          kind: "omission",
          note: `Unknown or unsupported Codex event type: ${type}`,
        });
        await this.persist(recorder);
        return;
      }
      if (normalized.kind === "malformed") {
        recorder.apply({
          type: "capture_note",
          kind: "omission",
          note: `Codex event ignored`,
        });
        await this.persist(recorder);
        return;
      }
      for (const event of normalized.events) emit(event);
      await this.persist(recorder);
    };
    const stdoutDone = readJsonLines(child.stdout, onLine);
    const stderrDone = recordStderr(child.stderr, recorder);
    const closeDone = new Promise<{ code: number | null }>(
      (resolve, reject) => {
        child.once("close", (code) => resolve({ code }));
        child.once("error", (error: Error) => reject(error));
      },
    );
    try {
      const closeResult = await Promise.all([
        closeDone,
        stdoutDone,
        stderrDone,
      ]).then((r) => r[0]);
      if (controls.stopRequested) {
        recorder.apply({
          type: "error",
          kind: "cancellation",
          message: "Run stopped by request",
          evidenceSource: "adapter-derived",
        });
        run.status = "cancelled";
        outcome = { status: "cancelled" };
      } else if (!sawTerminal && closeResult.code === 0) {
        recorder.apply({
          type: "session_completed",
          result: "Codex exited successfully",
          turns: 1,
          totalCostUsd: null,
          durationMs: null,
        });
        run.status = "completed";
        outcome = { status: "completed" };
      } else if (!sawTerminal) {
        const message = `Codex process exited with code ${String(closeResult.code)}`;
        recorder.apply({
          type: "session_failed",
          message,
          kind: "process",
          providerDetail: message,
        });
        run.status = "failed";
        outcome = { status: "failed", error: { kind: "process", message } };
      } else {
        outcome = { status: run.status === "failed" ? "failed" : "completed" };
        if (run.status === "failed") {
          outcome = {
            status: "failed",
            error: { kind: "provider", message: "Codex run failed" },
          };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = message.includes("ENOENT")
        ? "process"
        : classifyCodexMessage(message);
      const detail = message.includes("ENOENT")
        ? "Codex executable not found"
        : message;
      recorder.apply({
        type: "session_failed",
        message: detail,
        kind,
        providerDetail: message,
      });
      run.status = "failed";
      outcome = { status: "failed", error: { kind, message: detail } };
    } finally {
      try {
        await this.persist(recorder);
      } catch {
        // keep last good state
      }
      run.settleOutcome(
        outcome ?? {
          status: "failed",
          error: { kind: "unknown", message: "Run ended" },
        },
      );
    }
  }
}
function resolveSandbox(
  mode: AgentPermissionMode,
  config: CodexRunConfig,
): CodexSandboxMode {
  if (config.sandbox !== undefined) {
    if (
      config.sandbox === "danger-full-access" &&
      config.allowDangerousBypass !== true
    ) {
      throw new AgentRunError("danger-full-access needs allowDangerousBypass");
    }
    return config.sandbox;
  }
  if (mode === "bypass-permissions" && config.allowDangerousBypass !== true) {
    throw new AgentRunError("bypass-permissions needs allowDangerousBypass");
  }
  return SANDBOX_BY_PERMISSION[mode];
}
/**
 * Construct command-line arguments for `codex exec`.
 *
 * For Codex CLI 0.160.0, the non-interactive `exec` command does not accept
 * `--ask-for-approval`. Spider omits that flag while preserving the configured
 * sandbox posture, working directory, model, resume ID, ephemeral mode, and prompt.
 */
export function buildCodexArgs(
  options: AgentStartOptions,
  config: CodexRunConfig,
  sandbox: CodexSandboxMode,
): string[] {
  const args: string[] = [
    "exec",
    "--json",
    "--sandbox",
    sandbox,
    "--cd",
    resolvePath(options.cwd),
  ];
  if (typeof options.model === "string" && options.model.length > 0)
    args.push("--model", options.model);
  if (config.resumeThreadId !== undefined)
    args.push("resume", config.resumeThreadId);
  if (config.ephemeral === true) args.push("--ephemeral");
  if (config.skipGitRepoCheck === true) args.push("--skip-git-repo-check");
  if (config.extraArgs !== undefined) args.push(...config.extraArgs);
  args.push(options.prompt);
  return args;
}
interface RunControls {
  readonly run: CodexAgentRun;
  readonly normalizer: CodexEventNormalizer;
  readonly recorder: SessionRecorder;
  stopRequested: boolean;
  child: ReturnType<CodexSpawnFunction> | null;
}
class CodexAgentRun implements AgentRun {
  status: AgentRunStatus = "starting";
  providerSessionId: string | null = null;
  private outcome: AgentRunOutcome | null = null;
  private settle!: (outcome: AgentRunOutcome) => void;
  private controls: RunControls | null = null;
  readonly waitPromise: Promise<AgentRunOutcome>;
  constructor(
    readonly sessionId: string,
    readonly provider: string,
  ) {
    this.waitPromise = new Promise<AgentRunOutcome>((resolve) => {
      this.settle = resolve;
    });
  }
  attach(controls: RunControls): void {
    this.controls = controls;
  }
  async send(): Promise<void> {
    throw new AgentRunError("Codex exec runs are single-turn");
  }
  async stop(): Promise<void> {
    const controls = this.controls;
    if (controls === null) throw new AgentRunError("Run is not attached");
    controls.stopRequested = true;
    try {
      controls.child?.kill("SIGINT");
    } catch {
      // close handler settles
    }
  }
  async wait(): Promise<AgentRunOutcome> {
    return this.waitPromise;
  }
  settleOutcome(outcome: AgentRunOutcome): void {
    if (this.outcome !== null) return;
    this.outcome = outcome;
    this.status = outcome.status;
    this.settle(outcome);
  }
}
