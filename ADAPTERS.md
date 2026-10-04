# Adapter Boundary (Phase 0 decision)

An adapter is the only layer allowed to know an agent's native storage, export format, resume syntax, or provider-specific metadata. The canonical core does not depend on adapter implementations.

## Capability model

Capture, import, and continuation are independent. Detecting an agent does not imply any of them. `native` means a documented, supported interface was used; parser access to undocumented private storage is `experimental` and disabled by default.

```ts
type Support = "supported" | "experimental" | "none";
type CaptureMode = "native-api" | "documented-file-export" | "private-local-format" | "none";
type ImportMode = "native-import" | "documented-file-import" | "none";
type ContinueMode = "native-resume" | "manual-handoff" | "none";

interface AdapterCapabilities {
  detect: Support;
  capture: { support: Support; mode: CaptureMode; events: string[]; omissions: string[] };
  import: { support: Support; mode: ImportMode; omissions: string[] };
  continue: { support: Support; mode: ContinueMode };
}

interface AgentAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  detect(context: ReadOnlyDiscoveryContext): Promise<DetectionResult>;
  capture?(context: CaptureContext): Promise<CaptureResult>;
  importSession?(session: SpiderSession, context: ImportContext): Promise<ImportResult>;
  exportSession?(session: SpiderSession, context: ExportContext): Promise<ExportResult>;
  prepareContinuation?(session: SpiderSession, context: HandoffContext): Promise<ContinuationPlan>;
}
```

Capability combinations are constrained: `support: "none"` requires mode `"none"`; access to an undocumented private local format is always `experimental` and off by default; only documented native APIs/file exports are `supported`. `detect` runs only after explicit adapter selection and searches only its documented, bounded locations. `CaptureResult` contains the normalized session and explicit omissions/truncations. Import and export results identify whether a real native/file operation happened; generating Markdown is never reported as import/export. `ContinuationPlan` contains a handoff path and exact user-run instructions; preparing it has no side effects in the target agent.

The interface sketch uses `SpiderSession` only as a placeholder name; implementations define types from the JSON Schema. Do not require unsupported operations on every adapter. No adapter may execute saved commands or write private provider storage in 0.1.

## Three integration levels

1. **Native adapter:** documented stable local API or format, with each operation and event independently declared supported.
2. **File/export adapter:** documented JSON/JSONL/Markdown/etc. user export, with field-level omissions reported.
3. **Universal handoff:** core renders compact `handoff.md`. A target adapter may provide exact manual start instructions, but this is not native import or session resume.

## CLI semantics

```text
spider-web session list
spider-web session inspect <id-or-egg>
spider-web session capture <agent> [--project <dir>]
spider-web session export <id> [--output <file.spider-egg>] [--confirm-sensitive]
spider-web session import <file.spider-egg>
spider-web session handoff <id-or-egg> [--output <file>] [--confirm-sensitive]
spider-web session continue <file.spider-egg> --agent <agent> [--confirm-sensitive]
```

`import` stores an Egg in Spider Web's local repository; it does not import the session into a provider. `continue` validates the Egg, creates/uses the handoff, and reports native resume vs manual handoff. In 0.1 it never launches an agent. Capture reads the source and writes only Spider Web data. Adapters report status and omissions without logging conversation content.
