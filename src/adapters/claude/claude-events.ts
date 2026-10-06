import { posix as posixPath, win32 as win32Path } from "node:path";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentErrorKind, AgentEvent } from "../agent-runner.js";
import {
  classifyAssistantError,
  classifyResultError,
} from "./claude-errors.js";

/**
 * Tools whose successful completion mutates a file on disk.
 * File claims are derived only from these tool results — never
 * from assistant text — so every recorded file change is backed
 * by actual tool evidence.
 */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

/**
 * Normalizes SDK message-stream records into provider-neutral
 * {@link AgentEvent}s.
 *
 * The normalizer is stateful: it correlates tool results with
 * the tool calls that requested them through the provider's
 * tool-use ids, which is what allows file-change and command
 * evidence to be derived from completed tool calls.
 */
export class ClaudeEventNormalizer {
  private readonly cwd: string;
  private readonly toolContexts = new Map<string, ToolContext>();
  private lastProviderErrorKind: AgentErrorKind | null = null;

  constructor(options: { cwd: string }) {
    this.cwd = options.cwd;
  }

  /**
   * Translate one SDK stream record into zero or more neutral
   * events. Unknown message types and subtypes are ignored
   * safely: the SDK grows faster than this adapter, and an
   * unmapped record must never crash a run.
   */
  push(message: SDKMessage): AgentEvent[] {
    switch (message.type) {
      case "system":
        return message.subtype === "init" ? this.pushSystem(message) : [];
      case "assistant":
        return this.pushAssistant(message);
      case "user":
        return this.pushUser(message);
      case "result":
        return this.pushResult(message);
      case "rate_limit_event":
        return this.pushRateLimit(message);
      default:
        return [];
    }
  }

  private pushSystem(message: SDKSystemMessage): AgentEvent[] {
    return [
      {
        type: "session_started",
        provider: "claude-code",
        providerSessionId: message.session_id,
        metadata: {
          model: message.model,
          claudeCodeVersion: message.claude_code_version,
          permissionMode: message.permissionMode,
        },
      },
    ];
  }

  private pushAssistant(message: SDKAssistantMessage): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (message.error !== undefined) {
      const kind = classifyAssistantError(message.error);
      this.lastProviderErrorKind = kind;
      events.push({
        type: "error",
        kind,
        message: `Claude reported ${message.error}`,
        providerDetail: message.error,
        evidenceSource: "transcript",
      });
    }
    for (const block of message.message.content) {
      if (block.type === "text") {
        if (block.text.trim().length === 0) continue;
        events.push({
          type: "assistant_message",
          text: block.text,
          timestamp: message.timestamp ?? null,
          providerEventId: message.uuid,
        });
      } else if (block.type === "tool_use") {
        events.push(...this.pushToolUse(message, block));
      }
      // Thinking blocks and other block types are deliberately
      // not captured (see docs/agents/claude-code.md).
    }
    return events;
  }

  private pushToolUse(
    message: SDKAssistantMessage,
    block: {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    },
  ): AgentEvent[] {
    const toolCallId = block.id;
    this.toolContexts.set(toolCallId, {
      name: block.name,
      input: block.input,
    });
    const events: AgentEvent[] = [
      {
        type: "tool_call",
        toolCallId,
        tool: block.name,
        input: block.input,
        description: describeToolCall(block.name, block.input, this.cwd),
        timestamp: message.timestamp ?? null,
        providerEventId: message.uuid,
      },
    ];
    const command = extractCommand(block.input);
    if (command !== null) {
      events.push({ type: "command_started", toolCallId, command });
    }
    return events;
  }

  private pushUser(message: SDKUserMessage): AgentEvent[] {
    const events: AgentEvent[] = [];
    const content = message.message.content;
    if (typeof content === "string") {
      // Harness-injected user turns are synthetic; host-sent
      // prompts are recorded when Spider sends them, so a
      // non-synthetic text message here is still conversation.
      if (message.isSynthetic !== true && content.trim().length > 0) {
        events.push({
          type: "user_message",
          text: content,
          timestamp: message.timestamp ?? null,
          ...(message.uuid !== undefined
            ? { providerEventId: message.uuid }
            : {}),
        });
      }
      return events;
    }
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      events.push(...this.pushToolResult(message, block));
    }
    return events;
  }

  private pushToolResult(
    message: SDKUserMessage,
    block: {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content?: unknown;
      readonly is_error?: boolean;
    },
  ): AgentEvent[] {
    const toolCallId = block.tool_use_id;
    const context = this.toolContexts.get(toolCallId);
    const isError = block.is_error === true;
    const events: AgentEvent[] = [
      {
        type: "tool_result",
        toolCallId,
        tool: context?.name ?? "unknown",
        output: renderToolResultOutput(block.content, message.tool_use_result),
        isError,
        timestamp: message.timestamp ?? null,
        ...(message.uuid !== undefined
          ? { providerEventId: message.uuid }
          : {}),
      },
    ];
    const command = extractCommand(context?.input);
    if (command !== null) {
      events.push({
        type: "command_finished",
        toolCallId,
        command,
        exitCode: extractExitCode(message.tool_use_result),
        status: isError ? "failed" : "succeeded",
      });
    }
    if (
      context !== undefined &&
      !isError &&
      FILE_EDIT_TOOLS.has(context.name)
    ) {
      events.push(...this.pushFileChange(context.input));
    }
    return events;
  }

  /**
   * Derive a file claim from a successful file-editing tool
   * call. Only paths inside the working directory are
   * recorded; the session format stores relative POSIX paths
   * only, so anything else is documented as an omission.
   */
  private pushFileChange(input: unknown): AgentEvent[] {
    const filePath = extractFilePath(input);
    if (filePath === null) return [];
    const relative = toRelativePosix(filePath, this.cwd);
    if (relative === null) {
      return [
        {
          type: "capture_note",
          kind: "omission",
          note: "A file change outside the working directory was not recorded",
        },
      ];
    }
    return [
      {
        type: "file_changed",
        path: relative,
        // Write can create or overwrite, but the SDK event
        // does not distinguish the two; Edit and MultiEdit
        // modify existing files by definition.
        change: "modified",
      },
    ];
  }

  private pushResult(message: SDKResultMessage): AgentEvent[] {
    if (message.subtype === "success" && message.is_error !== true) {
      return [
        {
          type: "session_completed",
          result: message.result,
          turns: message.num_turns,
          totalCostUsd: message.total_cost_usd ?? null,
          durationMs: message.duration_ms ?? null,
        },
      ];
    }
    if (message.subtype === "success") {
      // A success-subtype result with is_error reports an
      // API-side failure (for example "Not logged in").
      return [
        {
          type: "session_failed",
          message:
            message.result.trim().length > 0
              ? message.result
              : "Claude reported an error result",
          kind: classifyResultError(
            "error_during_execution",
            this.lastProviderErrorKind,
          ),
          ...(message.result.trim().length > 0
            ? { providerDetail: message.result }
            : {}),
        },
      ];
    }
    const errors = message.errors.filter((error) => error.trim().length > 0);
    return [
      {
        type: "session_failed",
        message:
          errors.length > 0
            ? errors.join("; ")
            : `Claude run ended with ${message.subtype}`,
        kind: classifyResultError(message.subtype, this.lastProviderErrorKind),
        ...(errors.length > 0 ? { providerDetail: errors.join("; ") } : {}),
      },
    ];
  }

  private pushRateLimit(message: SDKRateLimitEvent): AgentEvent[] {
    const info = message.rate_limit_info;
    if (info.status === "allowed") return [];
    const parts: string[] = [
      info.status === "allowed_warning" ? "warning" : "rejected",
    ];
    if (info.rateLimitType !== undefined) parts.push(info.rateLimitType);
    if (info.utilization !== undefined) {
      parts.push(`utilization ${info.utilization}`);
    }
    if (info.resetsAt !== undefined) {
      parts.push(`resets at ${new Date(info.resetsAt).toISOString()}`);
    }
    const detail = parts.join(" ");
    return [
      {
        type: "error",
        kind: "rate_limit",
        message:
          info.status === "allowed_warning"
            ? `Claude rate limit ${detail}`
            : `Claude rate limit ${detail}`,
        providerDetail: JSON.stringify(info),
        evidenceSource: "transcript",
      },
    ];
  }
}

interface ToolContext {
  readonly name: string;
  readonly input: unknown;
}

/**
 * Short human-readable summary of a tool call, used as the
 * session's current task while the call is in flight.
 */
function describeToolCall(tool: string, input: unknown, cwd: string): string {
  if (typeof input !== "object" || input === null) return tool;
  const record = input as Record<string, unknown>;
  const field: Record<string, string> = {
    Read: "file_path",
    Edit: "file_path",
    Write: "file_path",
    MultiEdit: "file_path",
    NotebookEdit: "notebook_path",
    Bash: "command",
    Glob: "pattern",
    Grep: "pattern",
    Task: "description",
    WebFetch: "url",
    WebSearch: "query",
  };
  const fieldForTool = field[tool];
  if (fieldForTool === undefined) return tool;
  const value = record[fieldForTool];
  if (typeof value !== "string" || value.trim().length === 0) return tool;
  const firstLine = value.split("\n")[0] ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return tool;
  const displayValue =
    fieldForTool === "file_path" || fieldForTool === "notebook_path"
      ? toRelativeDisplayPath(trimmed, cwd)
      : trimmed;
  return `${tool}: ${displayValue}`;
}

function extractCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return null;
  }
  return command;
}

function extractFilePath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const field of ["file_path", "notebook_path", "path"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Convert an absolute or working-directory-relative path into a
 * relative POSIX path inside the working directory, or null when
 * the path lies outside it (or is the directory itself).
 */
function toRelativePosix(filePath: string, cwd: string): string | null {
  const pathApi = choosePathApi(filePath, cwd);
  const absolute = pathApi.isAbsolute(filePath)
    ? pathApi.normalize(filePath)
    : pathApi.resolve(cwd, filePath);
  const relative = pathApi.relative(pathApi.resolve(cwd), absolute);
  if (
    relative.length === 0 ||
    pathApi.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`)
  ) {
    return null;
  }
  return relative.split(pathApi.sep).join("/");
}

function toRelativeDisplayPath(filePath: string, cwd: string): string {
  return toRelativePosix(filePath, cwd) ?? filePath;
}

function choosePathApi(filePath: string, cwd: string): typeof posixPath {
  const looksWindows =
    win32Path.isAbsolute(filePath) ||
    win32Path.isAbsolute(cwd) ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    /^\\\\/.test(filePath);
  return (looksWindows ? win32Path : posixPath) as typeof posixPath;
}

function renderToolResultOutput(content: unknown, structured: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const candidate = block as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        texts.push(candidate.text);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  if (structured === undefined) return "";
  if (typeof structured === "string") return structured;
  return JSON.stringify(structured) ?? "";
}

/**
 * Best-effort exit code from the structured tool output. The
 * SDK does not guarantee an exit-code field for every tool, so
 * absence is reported as null rather than guessed.
 */
function extractExitCode(structured: unknown): number | null {
  if (typeof structured !== "object" || structured === null) return null;
  const record = structured as Record<string, unknown>;
  const exitCode = record.exitCode ?? record.exit_code;
  return typeof exitCode === "number" && Number.isInteger(exitCode)
    ? exitCode
    : null;
}
