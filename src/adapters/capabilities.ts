export type Support = "supported" | "experimental" | "none";
export type CaptureMode =
  "native-api" | "documented-file-export" | "private-local-format" | "none";
export type ImportMode =
  "native-import" | "documented-file-import" | "private-local-format" | "none";
export type ContinuationMode = "native-resume" | "manual-handoff" | "none";

export const NEUTRAL_EVENT_TYPES = [
  "message",
  "tool_call",
  "tool_result",
  "decision",
  "artifact",
  "command",
  "test",
  "error",
  "file_state",
  "git_snapshot",
  "next_action",
] as const;
export type NeutralEventType = (typeof NEUTRAL_EVENT_TYPES)[number];

export interface AdapterCapabilities {
  detect: Support;
  capture: {
    support: Support;
    mode: CaptureMode;
    events: readonly NeutralEventType[];
    omissions: readonly string[];
  };
  import: { support: Support; mode: ImportMode; omissions: readonly string[] };
  continue: { support: Support; mode: ContinuationMode };
}

export interface ReadOnlyDiscoveryContext {
  projectRoot?: string;
  allowUserHomeDiscovery: boolean;
}

export interface CaptureResult<Session> {
  session: Session;
  omissions: readonly string[];
  truncations: readonly string[];
}

export interface ContinuationPlan {
  mode: Exclude<ContinuationMode, "none">;
  handoffPath: string;
  instructions: readonly string[];
}

export interface AgentAdapter<Session, Context = ReadOnlyDiscoveryContext> {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  detect(context: Context): Promise<{ found: boolean; evidence?: string }>;
  capture?(context: Context): Promise<CaptureResult<Session>>;
  importSession?(
    session: Session,
    context: Context,
  ): Promise<{ imported: boolean; omissions: readonly string[] }>;
  exportSession?(
    session: Session,
    context: Context,
  ): Promise<{
    exported: boolean;
    path?: string;
    omissions: readonly string[];
  }>;
  prepareContinuation?(
    session: Session,
    context: Context,
  ): Promise<ContinuationPlan>;
}

function validateCapability(
  name: string,
  support: Support,
  mode: string,
  allowedModes: readonly string[],
  privateMode?: string,
): void {
  if (!allowedModes.includes(mode))
    throw new Error(`${name}: unsupported mode ${mode}`);
  if ((support === "none") !== (mode === "none")) {
    throw new Error(
      `${name}: support 'none' and mode 'none' must be used together`,
    );
  }
  if (privateMode === mode && support !== "experimental") {
    throw new Error(
      `${name}: private local formats must be marked experimental`,
    );
  }
  if (mode !== "none" && privateMode !== mode && support !== "supported") {
    throw new Error(`${name}: documented modes must be marked supported`);
  }
}

export function validateAdapterCapabilities(
  value: unknown,
): asserts value is AdapterCapabilities {
  if (typeof value !== "object" || value === null)
    throw new Error("Adapter capabilities must be an object");
  const caps = value as Partial<AdapterCapabilities>;
  const supports: readonly Support[] = ["supported", "experimental", "none"];
  if (!supports.includes(caps.detect as Support))
    throw new Error("detect has an invalid support value");
  if (!caps.capture || !caps.import || !caps.continue)
    throw new Error("capture, import, and continue capabilities are required");
  if (
    !supports.includes(caps.capture.support) ||
    !supports.includes(caps.import.support) ||
    !supports.includes(caps.continue.support)
  ) {
    throw new Error("A capability has an invalid support value");
  }
  validateCapability(
    "capture",
    caps.capture.support,
    caps.capture.mode,
    ["native-api", "documented-file-export", "private-local-format", "none"],
    "private-local-format",
  );
  validateCapability(
    "import",
    caps.import.support,
    caps.import.mode,
    ["native-import", "documented-file-import", "private-local-format", "none"],
    "private-local-format",
  );
  validateCapability("continue", caps.continue.support, caps.continue.mode, [
    "native-resume",
    "manual-handoff",
    "none",
  ]);
  if (
    !Array.isArray(caps.capture.events) ||
    !Array.isArray(caps.capture.omissions) ||
    !Array.isArray(caps.import.omissions)
  ) {
    throw new Error("Adapter events and omissions must be arrays");
  }
  if (
    caps.capture.events.some(
      (event) =>
        !NEUTRAL_EVENT_TYPES.includes(
          event as (typeof NEUTRAL_EVENT_TYPES)[number],
        ),
    )
  ) {
    throw new Error("Adapter event declarations must use neutral event names");
  }
}
