import type { SpiderSession10Draft } from "../generated/spider-session.js";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  assertSchema,
  ContractValidationError,
  validateSessionShape,
} from "./schema.js";

export type SpiderSession = SpiderSession10Draft;
export type SessionEvent =
  | SpiderSession["conversation"][number]
  | SpiderSession["tool_calls"][number]
  | SpiderSession["tool_results"][number]
  | SpiderSession["commands"][number]
  | SpiderSession["tests"][number]
  | SpiderSession["errors"][number];

export function validateSession(
  value: unknown,
): asserts value is SpiderSession {
  assertSchema(validateSessionShape, value, "Spider Session");
  const session = value as SpiderSession;
  const eventArrays: readonly (readonly SessionEvent[])[] = [
    session.conversation,
    session.tool_calls,
    session.tool_results,
    session.commands,
    session.tests,
    session.errors,
  ];
  const ids = new Set<string>();
  const sequences = new Set<number>();
  const calls = new Map(
    session.tool_calls.map((call) => [call.id, call.sequence]),
  );

  for (const events of eventArrays) {
    let previousSequence = 0;
    for (const event of events) {
      if (ids.has(event.id))
        throw new ContractValidationError(`Duplicate event id ${event.id}`);
      if (sequences.has(event.sequence))
        throw new ContractValidationError(
          `Duplicate event sequence ${event.sequence}`,
        );
      if (event.sequence <= previousSequence) {
        throw new ContractValidationError(
          `Events in each event array must be ordered by sequence (event ${event.id})`,
        );
      }
      if (event.id !== `e${event.sequence.toString(36)}`) {
        throw new ContractValidationError(
          `Event id ${event.id} must match sequence ${event.sequence}`,
        );
      }
      ids.add(event.id);
      sequences.add(event.sequence);
      previousSequence = event.sequence;
    }
  }

  for (const result of session.tool_results) {
    const callSequence = calls.get(result.tool_call_id);
    if (callSequence === undefined) {
      throw new ContractValidationError(
        `Tool result ${result.id} refers to missing tool call ${result.tool_call_id}`,
      );
    }
    if (result.sequence <= callSequence) {
      throw new ContractValidationError(
        `Tool result ${result.id} must follow tool call ${result.tool_call_id}`,
      );
    }
    if (
      result.output !== undefined &&
      Buffer.byteLength(
        typeof result.output === "string"
          ? result.output
          : (JSON.stringify(result.output) ?? ""),
        "utf8",
      ) > 65_536
    ) {
      throw new ContractValidationError(
        `Tool result ${result.id} exceeds the 64 KiB inline output limit`,
      );
    }
  }

  const artifactIds = new Set<string>();
  for (const artifact of session.artifacts) {
    if (artifactIds.has(artifact.id))
      throw new ContractValidationError(`Duplicate artifact id ${artifact.id}`);
    artifactIds.add(artifact.id);
    if (
      artifact.inclusion === "included" &&
      (!artifact.sha256 ||
        artifact.entry_path !== `artifacts/${artifact.sha256}`)
    ) {
      throw new ContractValidationError(
        `Included artifact ${artifact.id} must declare matching SHA-256 and entry_path`,
      );
    }
    if (
      artifact.inclusion !== "included" &&
      artifact.entry_path !== undefined &&
      artifact.entry_path !== null
    ) {
      throw new ContractValidationError(
        `Non-included artifact ${artifact.id} must not declare an Egg entry_path`,
      );
    }
  }
}

export function createEmptySession(
  goal: string,
  options: { projectName?: string | null; sourceAgent?: string } = {},
): SpiderSession {
  const now = new Date().toISOString();
  const session: SpiderSession = {
    schema_version: "1.0",
    session: {
      id: `spw_${randomUUID()}`,
      created_at: now,
      updated_at: now,
      source_agent: options.sourceAgent ?? "manual",
      project: { name: options.projectName ?? null, root_hint: null },
    },
    objective: { goal, status: "in_progress" },
    state: { current_task: null, completed: [], in_progress: [], blocked: [] },
    conversation: [],
    tool_calls: [],
    tool_results: [],
    decisions: [],
    files: { created: [], modified: [], deleted: [] },
    artifacts: [],
    commands: [],
    tests: [],
    errors: [],
    capture: { omissions: [], truncations: [] },
    environment: {},
    git: { branch: null, head: null, status: "unknown", files: [] },
    next_action: null,
    extensions: {},
  };
  validateSession(session);
  return session;
}
