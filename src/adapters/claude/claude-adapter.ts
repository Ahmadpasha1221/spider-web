import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  type Options,
  type PermissionMode,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
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
import { classifyThrownError } from "./claude-errors.js";
import { ClaudeEventNormalizer } from "./claude-events.js";
import type { ClaudeRunConfig } from "./claude-types.js";

/**
 * How long an interrupt() may take before the runner falls
 * back to the abort controller (the SDK's documented
 * cancellation mechanism).
 */
const INTERRUPT_BACKSTOP_MS = 5_000;

const PERMISSION_MODE_MAP: Readonly<
  Record<AgentPermissionMode, PermissionMode>
> = {
  default: "default",
  "accept-edits": "acceptEdits",
  plan: "plan",
  "bypass-permissions": "bypassPermissions",
};

/**
 * The subset of the SDK Query surface the runner uses.
 * The real SDK Query satisfies this; tests substitute a
 * deterministic fake.
 */
export interface AgentQueryLike extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
}

export type ClaudeQueryFunction = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AgentQueryLike;

export interface ClaudeAgentRunnerOptions {
  readonly repository: SessionRepository;
  /** Test seam: replaces the SDK query() entry point. */
  readonly query?: ClaudeQueryFunction;
  /** Observes every normalized event, in stream order. */
  readonly onEvent?: (event: AgentEvent) => void;
}

/**
 * Drives a live Claude Code session through the official
 * Claude Agent SDK and records it into a Spider Session.
 *
 * Every normalized event is persisted through the repository
 * as it is observed, so the stored session always reflects
 * the latest meaningful state even if the agent process or
 * this process dies mid-run.
 */
export class ClaudeAgentRunner implements AgentRunner {
  readonly provider = "claude-code";
  private readonly query: ClaudeQueryFunction;

  constructor(private readonly options: ClaudeAgentRunnerOptions) {
    this.query = options.query ?? sdkQuery;
  }

  /**
   * Start a run. The Spider session is created and persisted
   * (with the user prompt) before the agent process starts,
   * then updated as events arrive.
   */
  async start(
    options: AgentStartOptions,
    config?: ClaudeRunConfig,
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

    const session = createEmptySession(options.prompt, {
      projectName: options.projectName ?? null,
      sourceAgent: this.provider,
    });
    await this.options.repository.create(session);

    const prompts = new PromptQueue(options.interactive === true);
    const abortController = new AbortController();
    const normalizer = new ClaudeEventNormalizer({ cwd });
    const recorder = new SessionRecorder(session);
    const run = new ClaudeAgentRun(session.session.id, this.provider);
    const controls: RunControls = {
      run,
      prompts,
      normalizer,
      abortController,
      recorder,
      persist: () => this.persist(recorder),
      stopRequested: false,
      query: null,
      backstopTimer: null,
    };
    run.attach(controls);

    // Record the prompt before the agent starts so the
    // objective and the opening user turn are durable even
    // if the agent never produces another event.
    prompts.push({
      type: "user",
      message: { role: "user", content: options.prompt },
      parent_tool_use_id: null,
    });
    if (!prompts.interactive) {
      // Single-prompt run: closing the input signals end of
      // input, so the agent finishes its turn and exits.
      prompts.close();
    }
    recorder.apply({
      type: "user_message",
      text: options.prompt,
      timestamp: new Date().toISOString(),
    });
    await this.persist(recorder);

    void this.execute(controls, cwd, options, config).catch(
      (error: unknown) => {
        // execute() handles its own failures; this guard
        // only exists so a bug can never surface as an
        // unhandled rejection.
        run.settleOutcome({
          status: "failed",
          error: {
            kind: "unknown",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
    return run;
  }

  private async persist(recorder: SessionRecorder): Promise<void> {
    recorder.touch();
    await this.options.repository.update(recorder.session);
  }

  private async execute(
    controls: RunControls,
    cwd: string,
    startOptions: AgentStartOptions,
    config: ClaudeRunConfig | undefined,
  ): Promise<void> {
    const { run, recorder, normalizer, prompts, abortController } = controls;
    let outcome: AgentRunOutcome | null = null;
    try {
      const sdkOptions: Options = {
        cwd,
        abortController,
        permissionMode:
          PERMISSION_MODE_MAP[startOptions.permissionMode ?? "default"],
        ...(startOptions.model !== undefined
          ? { model: startOptions.model }
          : {}),
        ...(startOptions.maxTurns !== undefined
          ? { maxTurns: startOptions.maxTurns }
          : {}),
        ...(startOptions.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: startOptions.maxBudgetUsd }
          : {}),
        ...(config?.allowedTools !== undefined
          ? { allowedTools: [...config.allowedTools] }
          : {}),
        ...(config?.disallowedTools !== undefined
          ? { disallowedTools: [...config.disallowedTools] }
          : {}),
        ...(config?.canUseTool !== undefined
          ? { canUseTool: config.canUseTool }
          : {}),
        ...(config?.hooks !== undefined ? { hooks: config.hooks } : {}),
        ...(config?.env !== undefined ? { env: config.env } : {}),
        ...(config?.additionalDirectories !== undefined
          ? { additionalDirectories: [...config.additionalDirectories] }
          : {}),
      };
      const agentQuery = this.query({
        prompt: prompts,
        options: sdkOptions,
      });
      controls.query = agentQuery;
      for await (const message of agentQuery) {
        if (run.status === "starting") run.status = "running";
        const events = normalizer.push(message);
        // Once a stop was requested, terminal events from
        // trailing stream records are dropped: the run
        // outcome is cancellation, not whatever the
        // interrupted turn reported.
        const applicable = controls.stopRequested
          ? events.filter(
              (event) =>
                event.type !== "session_completed" &&
                event.type !== "session_failed",
            )
          : events;
        for (const event of applicable) {
          this.options.onEvent?.(event);
          recorder.apply(event);
          if (event.type === "session_started") {
            run.providerSessionId = event.providerSessionId;
          }
        }
        if (applicable.length > 0) {
          try {
            await this.persist(recorder);
          } catch (error) {
            // Persistence is the durability guarantee of
            // this adapter. Stop the agent rather than
            // continue unpersisted.
            abortController.abort();
            throw error;
          }
        }
        if (!controls.stopRequested) {
          const terminal = events.find(isTerminalAgentEvent);
          if (terminal !== undefined) {
            outcome =
              terminal.type === "session_completed"
                ? { status: "completed" }
                : {
                    status: "failed",
                    error: {
                      kind: terminal.kind,
                      message: terminal.message,
                      ...(terminal.providerDetail !== undefined
                        ? { providerDetail: terminal.providerDetail }
                        : {}),
                    },
                  };
            run.status = outcome.status;
          }
        }
      }
      if (outcome === null) {
        outcome = this.settleStreamEnd(controls);
      }
    } catch (error) {
      if (outcome === null) {
        outcome = this.settleFailure(controls, error);
      }
      // Otherwise the SDK re-surfaced an error result that
      // was already recorded from the stream; the outcome
      // already determined stands.
    } finally {
      prompts.close();
      if (controls.backstopTimer !== null) {
        clearTimeout(controls.backstopTimer);
        controls.backstopTimer = null;
      }
      try {
        await this.persist(recorder);
      } catch {
        // The last successful update stands; the stored
        // session remains valid and inspectable.
      }
      run.settleOutcome(
        outcome ?? {
          status: "failed",
          error: {
            kind: "unknown",
            message: "Run ended without a determined outcome",
          },
        },
      );
    }
  }

  private settleStreamEnd(controls: RunControls): AgentRunOutcome {
    const { run, recorder } = controls;
    if (controls.stopRequested) {
      recorder.apply({
        type: "error",
        kind: "cancellation",
        message: "Run stopped by request",
        evidenceSource: "adapter-derived",
      });
      run.status = "cancelled";
      return { status: "cancelled" };
    }
    recorder.apply({ type: "process_exited", code: null });
    run.status = "failed";
    return {
      status: "failed",
      error: {
        kind: "process",
        message: "Claude Code process ended without a completion result",
      },
    };
  }

  private settleFailure(
    controls: RunControls,
    error: unknown,
  ): AgentRunOutcome {
    const { run, recorder } = controls;
    if (controls.stopRequested) {
      recorder.apply({
        type: "error",
        kind: "cancellation",
        message: "Run stopped by request",
        evidenceSource: "adapter-derived",
      });
      run.status = "cancelled";
      return { status: "cancelled" };
    }
    const agentError = classifyThrownError(error);
    recorder.apply({
      type: "session_failed",
      message: agentError.message,
      kind: agentError.kind,
      ...(agentError.providerDetail !== undefined
        ? { providerDetail: agentError.providerDetail }
        : {}),
    });
    run.status = "failed";
    return { status: "failed", error: agentError };
  }
}

interface RunControls {
  readonly run: ClaudeAgentRun;
  readonly prompts: PromptQueue;
  readonly normalizer: ClaudeEventNormalizer;
  readonly abortController: AbortController;
  readonly recorder: SessionRecorder;
  readonly persist: () => Promise<void>;
  stopRequested: boolean;
  query: AgentQueryLike | null;
  backstopTimer: ReturnType<typeof setTimeout> | null;
}

class ClaudeAgentRun implements AgentRun {
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

  async send(input: string): Promise<void> {
    const controls = this.controls;
    if (controls === null) {
      throw new AgentRunError("Run is not attached");
    }
    if (this.outcome !== null) {
      throw new AgentRunError("Cannot send input: the run has ended");
    }
    if (!controls.prompts.interactive) {
      throw new AgentRunError("Cannot send input: the run is not interactive");
    }
    controls.prompts.push({
      type: "user",
      message: { role: "user", content: input },
      parent_tool_use_id: null,
    });
    controls.recorder.apply({
      type: "user_message",
      text: input,
      timestamp: new Date().toISOString(),
    });
    await controls.persist();
  }

  async stop(): Promise<void> {
    const controls = this.controls;
    if (controls === null) {
      throw new AgentRunError("Run is not attached");
    }
    if (controls.stopRequested) return;
    controls.stopRequested = true;
    const query = controls.query;
    if (query === null) {
      controls.abortController.abort();
      return;
    }
    try {
      // The SDK's supported interruption mechanism.
      await query.interrupt();
    } catch {
      controls.abortController.abort();
      return;
    }
    // Backstop: if the interrupt does not end the stream
    // promptly, force cleanup through the abort controller.
    controls.backstopTimer = setTimeout(() => {
      controls.abortController.abort();
    }, INTERRUPT_BACKSTOP_MS);
    controls.backstopTimer.unref();
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

/**
 * The prompt stream handed to the SDK. Spider records user
 * prompts when it sends them (the SDK stream does not echo
 * host-sent prompts back), so this queue is the single
 * source of user turns.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private readonly waiters: (() => void)[] = [];
  private closed = false;
  readonly interactive: boolean;

  constructor(interactive: boolean) {
    this.interactive = interactive;
  }

  push(message: SDKUserMessage): void {
    if (this.closed) {
      throw new AgentRunError("Prompt input is closed");
    }
    this.pending.push(message);
    this.notify();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.notify();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, void, undefined> {
    return {
      next: async (): Promise<IteratorResult<SDKUserMessage, void>> => {
        for (;;) {
          const first = this.pending.shift();
          if (first !== undefined) {
            return { done: false, value: first };
          }
          if (this.closed) {
            return { done: true, value: undefined };
          }
          await this.waitForPush();
        }
      },
    };
  }

  private waitForPush(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notify(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
