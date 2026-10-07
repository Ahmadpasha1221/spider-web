import type {
  AgentCaptureNoteEvent,
  AgentCommandFinishedEvent,
  AgentCommandStartedEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentFileChangedEvent,
  AgentProcessExitedEvent,
  AgentSessionCompletedEvent,
  AgentSessionFailedEvent,
  AgentSessionStartedEvent,
  AgentTestEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentUserMessageEvent,
  AgentAssistantMessageEvent,
} from "./agent-runner.js";
import { validateSession, type SpiderSession } from "../core/session.js";
import { Buffer } from "node:buffer";

/**
 * Byte budget for an inline tool-call input. Larger inputs are
 * replaced by a truncated preview plus a capture.truncations
 * entry: the effect of a tool call (for example a written file)
 * lives on disk, so replaying the full payload in the session
 * only grows storage.
 */
const MAX_TOOL_INPUT_BYTES = 4096;

/** Byte budget for an inline tool result output. */
const MAX_TOOL_OUTPUT_BYTES = 16384;

/** Byte budget for state items and next-action descriptions. */
const MAX_STATE_ITEM_BYTES = 2048;

/**
 * Folds normalized {@link AgentEvent}s into a Spider Session
 * draft while keeping the draft valid at every step.
 *
 * Invariants maintained by construction:
 * - event ids are derived from a single global sequence counter
 *   (`e<sequence.toString(36)>`), unique across all collections
 * - each collection stays ordered by ascending sequence
 * - tool results only reference tool calls recorded earlier in
 *   the same session (correlated through the provider tool-use id)
 * - inline tool output stays well below the 64 KiB contract limit
 */
export class SessionRecorder {
  private readonly draft: SpiderSession;
  private readonly toolCallIds = new Map<string, string>();
  private nextSequence: number;
  private provider: string | null = null;

  constructor(session: SpiderSession) {
    this.draft = session;
    this.nextSequence = firstFreeSequence(session);
  }

  /** The session being recorded into. */
  get session(): SpiderSession {
    return this.draft;
  }

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "session_started":
        this.applySessionStarted(event);
        break;
      case "user_message":
        this.applyUserMessage(event);
        break;
      case "assistant_message":
        this.applyAssistantMessage(event);
        break;
      case "tool_call":
        this.applyToolCall(event);
        break;
      case "tool_result":
        this.applyToolResult(event);
        break;
      case "file_changed":
        this.applyFileChanged(event);
        break;
      case "command_started":
        this.applyCommandStarted(event);
        break;
      case "command_finished":
        this.applyCommandFinished(event);
        break;
      case "test":
        this.applyTest(event);
        break;
      case "error":
        this.applyError(event);
        break;
      case "session_completed":
        this.applySessionCompleted(event);
        break;
      case "session_failed":
        this.applySessionFailed(event);
        break;
      case "process_exited":
        this.applyProcessExited(event);
        break;
      case "capture_note":
        this.applyCaptureNote(event);
        break;
    }
    validateSession(this.draft);
  }

  /** Refresh the session's updated_at before persisting. */
  touch(): void {
    this.draft.session.updated_at = new Date().toISOString();
  }

  private nextEvent(): { id: string; sequence: number } {
    const sequence = this.nextSequence++;
    return { id: `e${sequence.toString(36)}`, sequence };
  }

  private applySessionStarted(event: AgentSessionStartedEvent): void {
    this.provider = event.provider;
    this.draft.extensions[event.provider] = {
      providerSessionId: event.providerSessionId,
      ...event.metadata,
    };
  }

  private applyUserMessage(event: AgentUserMessageEvent): void {
    const { id, sequence } = this.nextEvent();
    this.draft.conversation.push({
      id,
      sequence,
      role: "user",
      content: [{ type: "text", text: event.text }],
      timestamp: event.timestamp,
      handoff_relevant: true,
      evidence: {
        source: "user",
        confidence: "observed",
        event_id: event.providerEventId ?? null,
      },
    });
  }

  private applyAssistantMessage(event: AgentAssistantMessageEvent): void {
    const { id, sequence } = this.nextEvent();
    this.draft.conversation.push({
      id,
      sequence,
      role: "assistant",
      content: [{ type: "text", text: event.text }],
      timestamp: event.timestamp,
      handoff_relevant: true,
      evidence: {
        source: "transcript",
        confidence: "observed",
        event_id: event.providerEventId ?? null,
      },
    });
  }

  private applyToolCall(event: AgentToolCallEvent): void {
    const { id, sequence } = this.nextEvent();
    const bounded = this.boundedValue(
      event.input,
      MAX_TOOL_INPUT_BYTES,
      `tool call ${id} input`,
    );
    this.draft.tool_calls.push({
      id,
      sequence,
      name: event.tool,
      input: bounded.value,
      status: "requested",
      timestamp: event.timestamp,
      evidence: {
        source: "transcript",
        confidence: "observed",
        event_id: event.providerEventId ?? null,
      },
    });
    this.recordTruncation(bounded);
    this.toolCallIds.set(event.toolCallId, id);
    this.draft.state.current_task = event.description;
  }

  private applyToolResult(event: AgentToolResultEvent): void {
    const callId = this.toolCallIds.get(event.toolCallId);
    if (callId === undefined) {
      // The contract requires every tool result to reference a
      // recorded tool call; record the omission instead of
      // breaking the session.
      this.draft.capture.omissions.push(
        `tool result for tool use ${event.toolCallId} was not recorded because its tool call was not captured`,
      );
      return;
    }
    const { id, sequence } = this.nextEvent();
    const bounded = this.boundedText(
      event.output,
      MAX_TOOL_OUTPUT_BYTES,
      `tool result ${id} output`,
    );
    this.draft.tool_results.push({
      id,
      sequence,
      tool_call_id: callId,
      status: event.isError ? "failed" : "completed",
      output: bounded.value,
      timestamp: event.timestamp,
      evidence: {
        source: "transcript",
        confidence: "observed",
        event_id: event.providerEventId ?? null,
      },
    });
    this.recordTruncation(bounded);
    const call = this.draft.tool_calls.find((item) => item.id === callId);
    if (call !== undefined) {
      call.status = event.isError ? "failed" : "completed";
    }
  }

  private applyFileChanged(event: AgentFileChangedEvent): void {
    const { path, change } = event;
    const files = this.draft.files;

    const findIndex = (list: { path: string }[]): number =>
      list.findIndex((item) => item.path === path);

    const createdIndex = findIndex(files.created);
    const modifiedIndex = findIndex(files.modified);
    const deletedIndex = findIndex(files.deleted);

    if (change === "created") {
      if (createdIndex >= 0) {
        // Already recorded as created; no duplicate.
        return;
      }
      if (modifiedIndex >= 0) {
        files.modified.splice(modifiedIndex, 1);
      }
      if (deletedIndex >= 0) {
        files.deleted.splice(deletedIndex, 1);
      }
      files.created.push({
        path,
        evidence: {
          source: "adapter-derived",
          confidence: "observed",
          event_id: null,
        },
      });
    } else if (change === "modified") {
      if (createdIndex >= 0) {
        // If created earlier during this session, it remains "created".
        return;
      }
      if (modifiedIndex >= 0) {
        // Already recorded as modified; no duplicate.
        return;
      }
      if (deletedIndex >= 0) {
        files.deleted.splice(deletedIndex, 1);
      }
      files.modified.push({
        path,
        evidence: {
          source: "adapter-derived",
          confidence: "observed",
          event_id: null,
        },
      });
    } else if (change === "deleted") {
      if (deletedIndex >= 0) {
        // Already recorded as deleted; no duplicate.
        return;
      }
      if (createdIndex >= 0) {
        // File was created and then deleted during this session.
        files.created.splice(createdIndex, 1);
      }
      if (modifiedIndex >= 0) {
        files.modified.splice(modifiedIndex, 1);
      }
      files.deleted.push({
        path,
        evidence: {
          source: "adapter-derived",
          confidence: "observed",
          event_id: null,
        },
      });
    }
  }

  private applyTest(event: AgentTestEvent): void {
    const { id, sequence } = this.nextEvent();
    this.draft.tests.push({
      id,
      sequence,
      name: event.name,
      status: event.status,
      details_artifact_id: null,
      evidence: {
        source: event.evidenceSource ?? "transcript",
        confidence: "observed",
        event_id: null,
      },
    });
  }

  private applyCommandStarted(event: AgentCommandStartedEvent): void {
    const { id, sequence } = this.nextEvent();
    this.draft.commands.push({
      id,
      sequence,
      command: event.command,
      status: "running",
      exit_code: null,
      output_artifact_id: null,
      evidence: {
        source: "transcript",
        confidence: "observed",
        event_id: null,
      },
    });
  }

  private applyCommandFinished(event: AgentCommandFinishedEvent): void {
    const { id, sequence } = this.nextEvent();
    this.draft.commands.push({
      id,
      sequence,
      command: event.command,
      status: event.status,
      exit_code: event.exitCode,
      output_artifact_id: null,
      evidence: {
        source: "transcript",
        confidence: "observed",
        event_id: null,
      },
    });
  }

  private applyError(event: AgentErrorEvent): void {
    const { id, sequence } = this.nextEvent();
    this.draft.errors.push({
      id,
      sequence,
      description: event.message,
      evidence: {
        source: event.evidenceSource,
        confidence: "observed",
        event_id: null,
      },
      artifact_id: null,
    });
  }

  private applySessionCompleted(event: AgentSessionCompletedEvent): void {
    this.draft.objective.status = "completed";
    this.draft.state.current_task = null;
    const bounded = this.boundedText(
      event.result,
      MAX_STATE_ITEM_BYTES,
      "run completion summary",
    );
    this.draft.state.completed.push({
      description: bounded.value,
      rationale: null,
      evidence: {
        source: "transcript",
        confidence: "observed",
        event_id: null,
      },
    });
    this.recordTruncation(bounded);
    this.draft.next_action = null;
    this.mergeProviderExtension({
      run: {
        completedAt: new Date().toISOString(),
        turns: event.turns,
        totalCostUsd: event.totalCostUsd,
        durationMs: event.durationMs,
      },
    });
  }

  private applySessionFailed(event: AgentSessionFailedEvent): void {
    this.draft.objective.status = "blocked";
    const bounded = this.boundedText(
      event.message,
      MAX_STATE_ITEM_BYTES,
      "run failure description",
    );
    this.draft.state.blocked.push({
      description: bounded.value,
      rationale: null,
      evidence: {
        source: "adapter-derived",
        confidence: "observed",
        event_id: null,
      },
    });
    this.recordTruncation(bounded);
    const { id, sequence } = this.nextEvent();
    this.draft.errors.push({
      id,
      sequence,
      description: bounded.value,
      evidence: {
        source: "adapter-derived",
        confidence: "observed",
        event_id: null,
      },
      artifact_id: null,
    });
    this.draft.next_action = {
      description: "Resolve the recorded failure, then resume the session.",
      rationale: null,
      evidence: {
        source: "adapter-derived",
        confidence: "inferred",
        event_id: null,
      },
    };
  }

  private applyProcessExited(event: AgentProcessExitedEvent): void {
    this.draft.objective.status = "blocked";
    const { id, sequence } = this.nextEvent();
    const description =
      event.code === null
        ? "Agent process ended without a completion result"
        : `Agent process exited with code ${event.code} without a completion result`;
    this.draft.errors.push({
      id,
      sequence,
      description,
      evidence: {
        source: "adapter-derived",
        confidence: "observed",
        event_id: null,
      },
      artifact_id: null,
    });
    this.draft.state.blocked.push({
      description:
        "Agent process ended before reporting a completion result; the last known state is preserved",
      rationale: null,
      evidence: {
        source: "adapter-derived",
        confidence: "observed",
        event_id: null,
      },
    });
    this.draft.next_action = {
      description: "Resume the session to continue the work.",
      rationale: null,
      evidence: {
        source: "adapter-derived",
        confidence: "inferred",
        event_id: null,
      },
    };
  }

  private applyCaptureNote(event: AgentCaptureNoteEvent): void {
    if (event.kind === "omission") {
      this.draft.capture.omissions.push(event.note);
    } else {
      this.draft.capture.truncations.push(event.note);
    }
  }

  private mergeProviderExtension(additional: Record<string, unknown>): void {
    if (this.provider === null) return;
    const existing = this.draft.extensions[this.provider];
    const base: Record<string, unknown> =
      typeof existing === "object" && existing !== null
        ? { ...(existing as Record<string, unknown>) }
        : {};
    this.draft.extensions[this.provider] = { ...base, ...additional };
  }

  private recordTruncation(bounded: {
    truncated: boolean;
    note: string;
  }): void {
    if (bounded.truncated) {
      this.draft.capture.truncations.push(bounded.note);
    }
  }

  private boundedText(
    text: string,
    maxBytes: number,
    label: string,
  ): { value: string; truncated: boolean; note: string } {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) {
      return { value: text, truncated: false, note: "" };
    }
    const cut = Buffer.from(text, "utf8").subarray(0, maxBytes);
    return {
      value: `${cut.toString("utf8")}… [truncated]`,
      truncated: true,
      note: `${label} truncated to ${maxBytes} bytes`,
    };
  }

  private boundedValue(
    value: unknown,
    maxBytes: number,
    label: string,
  ): { value: unknown; truncated: boolean; note: string } {
    if (typeof value === "string") {
      const bounded = this.boundedText(value, maxBytes, label);
      return {
        value: bounded.value,
        truncated: bounded.truncated,
        note: bounded.note,
      };
    }
    const text = JSON.stringify(value) ?? "";
    if (Buffer.byteLength(text, "utf8") <= maxBytes) {
      return { value, truncated: false, note: "" };
    }
    const cut = Buffer.from(text, "utf8").subarray(0, maxBytes);
    return {
      value: `${cut.toString("utf8")}… [truncated]`,
      truncated: true,
      note: `${label} truncated to ${maxBytes} bytes`,
    };
  }
}

function firstFreeSequence(session: SpiderSession): number {
  const collections: readonly (readonly { sequence: number }[])[] = [
    session.conversation,
    session.tool_calls,
    session.tool_results,
    session.commands,
    session.tests,
    session.errors,
  ];
  let max = 0;
  for (const collection of collections) {
    for (const event of collection) {
      if (event.sequence > max) max = event.sequence;
    }
  }
  return max + 1;
}
