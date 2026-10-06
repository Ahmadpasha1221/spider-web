import { validateSession, type SpiderSession } from "../core/session.js";
import type {
  ContinuationCommandEvidence,
  ContinuationContext,
  ContinuationFileEvidence,
} from "./continuation-context.js";

const MAX_PROMPT_CHARS = 8000;

function textPart(message: SpiderSession["conversation"][number]): string {
  return message.content
    .map((part) =>
      part.type === "text"
        ? (part.text ?? "")
        : (part.note ?? `[${part.type}]`),
    )
    .join("\n")
    .trim();
}

export function buildContinuationContext(
  session: SpiderSession,
): ContinuationContext {
  validateSession(session);
  const filesChanged: ContinuationFileEvidence[] = [
    ...session.files.created.map((f) => ({
      path: f.path,
      change: "created" as const,
    })),
    ...session.files.modified.map((f) => ({
      path: f.path,
      change: "modified" as const,
    })),
    ...session.files.deleted.map((f) => ({
      path: f.path,
      change: "deleted" as const,
    })),
  ];
  const commandsExecuted: ContinuationCommandEvidence[] = session.commands.map(
    (c) => ({
      command: c.command,
      status: c.status,
      exitCode: c.exit_code ?? null,
    }),
  );
  const relevantMessages = session.conversation
    .filter((m) => m.handoff_relevant)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, 5)
    .map((m) => `${m.role}: ${textPart(m)}`)
    .filter((t) => t.trim().length > 0);
  const providerHistory: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(session.extensions)) {
    if (typeof value === "object" && value !== null) {
      providerHistory[key] = { ...(value as Record<string, unknown>) };
    }
  }
  return {
    sessionId: session.session.id,
    objective: session.objective.goal,
    status: session.objective.status,
    sourceAgent: session.session.source_agent,
    currentTask: session.state.current_task,
    completedWork: session.state.completed.map((s) => s.description),
    pendingWork: session.state.in_progress.map((s) => s.description),
    blockers: session.state.blocked.map((s) => s.description),
    decisions: session.decisions.map((d) => d.description),
    filesChanged,
    commandsExecuted,
    errors: session.errors.map((e) => e.description),
    nextAction: session.next_action?.description ?? null,
    relevantMessages,
    providerHistory,
  };
}

export function renderContinuationPrompt(context: ContinuationContext): string {
  const lines = [
    `This is a continuation of Spider session ${context.sessionId}.`,
    `It was previously handled by ${context.sourceAgent}.`,
    "",
    `Original objective: ${context.objective}`,
    `Current status: ${context.status}`,
  ];
  if (context.currentTask) lines.push(`Current task: ${context.currentTask}`);
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push("", `## ${title}`);
    for (const item of items.slice(0, 10)) lines.push(`- ${item}`);
  };
  section("Already completed (do not redo)", context.completedWork);
  section("Pending work", context.pendingWork);
  section("Blockers", context.blockers);
  section("Decisions", context.decisions);
  if (context.filesChanged.length > 0) {
    lines.push("", "## Files changed");
    for (const f of context.filesChanged.slice(0, 20)) {
      lines.push(`- ${f.change}: \`${f.path}\``);
    }
  }
  if (context.commandsExecuted.length > 0) {
    lines.push("", "## Commands executed");
    for (const c of context.commandsExecuted.slice(0, 10)) {
      lines.push(`- \`${c.command}\`: ${c.status}`);
    }
  }
  section("Errors", context.errors);
  if (context.nextAction) lines.push("", "## Next action", context.nextAction);
  section("Relevant conversation", context.relevantMessages);
  lines.push(
    "",
    "Continue the existing work. Do not restart completed work unnecessarily.",
    "Inspect the current workspace before making assumptions.",
    "Verify the current state. Continue from the pending work.",
  );
  const full = `${lines.join("\n")}\n`;
  if (full.length <= MAX_PROMPT_CHARS) return full;
  return `${full.slice(0, MAX_PROMPT_CHARS - 40)}\n... [truncated]\n`;
}
