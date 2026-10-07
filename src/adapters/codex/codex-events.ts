import type { AgentErrorKind, AgentEvent } from "../agent-runner.js";
import { CODEX_PROVIDER_ID } from "./codex-types.js";
import {
  asRecord,
  describeItem,
  readErrorMessage,
  readExitCode,
  readItemStatus,
  renderItemOutput,
} from "./codex-items.js";
import { redactSecrets, redactValue } from "./codex-redact.js";
import { extractTestResult } from "../test-extractor.js";

export type CodexRawEvent = Record<string, unknown>;

export type CodexNormalizeOutcome =
  | { readonly kind: "events"; readonly events: AgentEvent[] }
  | { readonly kind: "ignored" }
  | { readonly kind: "unsupported"; readonly eventType: string }
  | { readonly kind: "malformed"; readonly note: string };

export class CodexEventNormalizer {
  private readonly cwd: string;
  constructor(options: { cwd: string }) {
    this.cwd = options.cwd;
  }

  push(record: unknown): CodexNormalizeOutcome {
    if (typeof record !== "object" || record === null) {
      return { kind: "malformed", note: "Codex event was not an object" };
    }
    const event = record as CodexRawEvent;
    if (typeof event.type !== "string") {
      return { kind: "malformed", note: "Codex event is missing a type" };
    }

    if (event.type === "thread.started") return this.threadStarted(event);

    // turn.started is an expected Codex lifecycle event.
    // It carries no provider-neutral state required for Spider sessions, so it is
    // intentionally and explicitly ignored without emitting an omission diagnostic.
    if (event.type === "turn.started") {
      return { kind: "ignored" };
    }

    if (event.type === "turn.failed") {
      const message = redactSecrets(readErrorMessage(event.error));
      return {
        kind: "events",
        events: [
          {
            type: "session_failed",
            message,
            kind: classifyCodexMessage(message),
            providerDetail: message,
          },
        ],
      };
    }

    if (event.type === "turn.completed") {
      const usage = asRecord(event.usage);
      const cost =
        usage !== null && typeof usage.total_cost_usd === "number"
          ? usage.total_cost_usd
          : null;
      return {
        kind: "events",
        events: [
          {
            type: "session_completed",
            result: "Codex turn completed",
            turns: 1,
            totalCostUsd: cost,
            durationMs: null,
          },
        ],
      };
    }

    if (event.type === "error") {
      const message = redactSecrets(
        typeof event.message === "string" && event.message.length > 0
          ? event.message
          : "Codex reported an error",
      );
      return {
        kind: "events",
        events: [
          {
            type: "error",
            message,
            kind: classifyCodexMessage(message),
            providerDetail: message,
            evidenceSource: "transcript",
          },
        ],
      };
    }

    if (event.type === "item.started") return this.itemStarted(event);

    // item.updated contains streaming delta updates (e.g. streaming message tokens, progress).
    // Intentionally ignored as the final state is captured in item.completed.
    if (event.type === "item.updated") {
      return { kind: "ignored" };
    }

    if (event.type === "item.completed") return this.itemCompleted(event);

    return { kind: "unsupported", eventType: event.type };
  }

  private threadStarted(event: CodexRawEvent): CodexNormalizeOutcome {
    if (typeof event.thread_id !== "string" || event.thread_id.length === 0) {
      return { kind: "malformed", note: "thread.started misses thread_id" };
    }
    return {
      kind: "events",
      events: [
        {
          type: "session_started",
          provider: CODEX_PROVIDER_ID,
          providerSessionId: event.thread_id,
          metadata: {},
        },
      ],
    };
  }

  private itemStarted(event: CodexRawEvent): CodexNormalizeOutcome {
    const item = asRecord(event.item);
    if (item === null) {
      return { kind: "malformed", note: "item.started is missing its item" };
    }
    const context = describeItem(item, this.cwd);
    if (context === null) return { kind: "ignored" };
    const itemId = typeof item.id === "string" ? item.id : null;
    const toolCallId = itemId ?? context.tool;
    const events: AgentEvent[] = [
      {
        type: "tool_call",
        toolCallId,
        tool: context.tool,
        input: redactValue(context.input),
        description: redactSecrets(context.description),
        timestamp: null,
        ...(itemId !== null ? { providerEventId: itemId } : {}),
      },
    ];
    if (context.command !== null) {
      events.push({
        type: "command_started",
        toolCallId,
        command: redactSecrets(context.command),
      });
    }
    return { kind: "events", events };
  }

  private itemCompleted(event: CodexRawEvent): CodexNormalizeOutcome {
    const item = asRecord(event.item);
    if (item === null) {
      return { kind: "malformed", note: "item.completed is missing its item" };
    }
    const itemId = typeof item.id === "string" ? item.id : null;
    const itemType = typeof item.type === "string" ? item.type : "unknown";

    if (itemType === "agent_message") {
      const text = redactSecrets(
        typeof item.text === "string" ? item.text : "",
      );
      if (text.trim().length === 0) return { kind: "ignored" };
      return {
        kind: "events",
        events: [
          {
            type: "assistant_message",
            text,
            timestamp: null,
            ...(itemId !== null ? { providerEventId: itemId } : {}),
          },
        ],
      };
    }

    if (itemType === "error") {
      const message = redactSecrets(
        typeof item.message === "string" && item.message.length > 0
          ? item.message
          : "Codex item failed",
      );
      return {
        kind: "events",
        events: [
          {
            type: "error",
            message,
            kind: classifyCodexMessage(message),
            providerDetail: message,
            evidenceSource: "transcript",
          },
        ],
      };
    }

    const context = describeItem(item, this.cwd);
    if (context === null) return { kind: "ignored" };
    const toolCallId = itemId ?? context.tool;
    const failed = readItemStatus(item);
    const output = renderItemOutput(item, context);

    const events: AgentEvent[] = [
      {
        type: "tool_result",
        toolCallId,
        tool: context.tool,
        output: redactSecrets(output),
        isError: failed,
        timestamp: null,
        ...(itemId !== null ? { providerEventId: itemId } : {}),
      },
    ];

    if (context.command !== null) {
      const exitCode = readExitCode(item);
      events.push({
        type: "command_finished",
        toolCallId,
        command: redactSecrets(context.command),
        exitCode,
        status: failed ? "failed" : "succeeded",
      });

      // Extract test result if this command was a test runner
      const testResult = extractTestResult({
        command: context.command,
        output,
        exitCode,
      });
      if (testResult !== null) {
        events.push({
          type: "test",
          name: testResult.name,
          status: testResult.status,
          evidenceSource: "transcript",
        });
      }
    }

    // Emit file changes for file editing tools
    if (context.fileChanges && context.fileChanges.length > 0) {
      for (const change of context.fileChanges) {
        events.push({
          type: "file_changed",
          path: change.path,
          change: change.change,
        });
      }
    }

    // Record omissions for rejected paths (e.g. directory traversal attempts)
    if (context.rejectedFilePaths && context.rejectedFilePaths.length > 0) {
      for (const rejected of context.rejectedFilePaths) {
        events.push({
          type: "capture_note",
          kind: "omission",
          note: `Codex file change path rejected: ${rejected.error}`,
        });
      }
    }

    return { kind: "events", events };
  }
}

export function classifyCodexMessage(message: string): AgentErrorKind {
  const text = message.toLowerCase();
  if (text.includes("unauthorized") || text.includes("401"))
    return "authentication";
  if (text.includes("auth") || text.includes("login")) return "authentication";
  if (text.includes("api key") || text.includes("oauth"))
    return "authentication";
  if (text.includes("billing") || text.includes("402")) return "billing";
  if (text.includes("rate limit") || text.includes("429")) return "rate_limit";
  if (text.includes("quota") || text.includes("usage limit"))
    return "rate_limit";
  if (text.includes("overloaded") || text.includes("503")) return "overloaded";
  if (text.includes("timed out") || text.includes("max turns")) return "limit";
  if (text.includes("denied") || text.includes("cancelled"))
    return "cancellation";
  if (text.includes("interrupted")) return "cancellation";
  return "provider";
}
