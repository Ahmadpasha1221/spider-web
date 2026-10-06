export interface ContinuationFileEvidence {
  readonly path: string;
  readonly change: "created" | "modified" | "deleted";
}

export interface ContinuationCommandEvidence {
  readonly command: string;
  readonly status: string;
  readonly exitCode: number | null;
}

export interface ContinuationContext {
  readonly sessionId: string;
  readonly objective: string;
  readonly status: string;
  readonly sourceAgent: string;
  readonly currentTask: string | null;
  readonly completedWork: readonly string[];
  readonly pendingWork: readonly string[];
  readonly blockers: readonly string[];
  readonly decisions: readonly string[];
  readonly filesChanged: readonly ContinuationFileEvidence[];
  readonly commandsExecuted: readonly ContinuationCommandEvidence[];
  readonly errors: readonly string[];
  readonly nextAction: string | null;
  readonly relevantMessages: readonly string[];
  readonly providerHistory: Readonly<Record<string, unknown>>;
}
