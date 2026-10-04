import type { SpiderSession } from "./session.js";
import { validateSession } from "./session.js";

export const MAX_HANDOFF_CHARACTERS = 12_000;
const TRUNCATION_NOTICE =
  "\n\n> Handoff truncated at 12,000 Unicode characters; lower-priority content omitted.\n";

function listSection(
  title: string,
  values: readonly { description: string }[],
): string[] {
  return values.length === 0
    ? []
    : ["", `## ${title}`, ...values.map((value) => `- ${value.description}`)];
}

export function renderHandoff(session: SpiderSession): string {
  validateSession(session);
  const lines = [
    "# Spider Web handoff",
    "",
    `**Objective:** ${session.objective.goal}`,
    `**Status:** ${session.objective.status}`,
  ];
  const projectName = session.session.project.name;
  if (projectName) lines.push(`**Project:** ${projectName}`);
  if (session.session.source_agent)
    lines.push(`**Captured from:** ${session.session.source_agent}`);
  if (session.state.current_task)
    lines.push("", "## Current task", session.state.current_task);
  if (session.next_action)
    lines.push("", "## Next action", session.next_action.description);
  lines.push(...listSection("Blockers", session.state.blocked));
  lines.push(...listSection("Completed", session.state.completed));
  lines.push(...listSection("In progress", session.state.in_progress));
  lines.push(...listSection("Decisions", session.decisions));

  for (const [title, files] of [
    ["Created files", session.files.created],
    ["Modified files", session.files.modified],
    ["Deleted files", session.files.deleted],
  ] as const) {
    if (files.length > 0)
      lines.push(
        "",
        `## ${title}`,
        ...files.map((file) => `- \`${file.path}\``),
      );
  }

  if (session.git.status !== "unknown" || session.git.files.length > 0) {
    lines.push("", "## Git state", `- Status: ${session.git.status}`);
    if (session.git.branch) lines.push(`- Branch: ${session.git.branch}`);
    if (session.git.head) lines.push(`- HEAD: ${session.git.head}`);
    lines.push(
      ...session.git.files.map(
        (file) =>
          `- ${file.index_status}/${file.worktree_status}: \`${file.path}\``,
      ),
    );
  }
  if (session.tests.length > 0) {
    lines.push(
      "",
      "## Tests",
      ...session.tests.map((test) => `- ${test.name}: ${test.status}`),
    );
  }
  if (session.errors.length > 0) {
    lines.push(
      "",
      "## Errors",
      ...session.errors.map((error) => `- ${error.description}`),
    );
  }
  if (session.commands.length > 0) {
    lines.push(
      "",
      "## Commands",
      ...session.commands.map(
        (command) => `- \`${command.command}\`: ${command.status}`,
      ),
    );
  }
  const env = Object.entries(session.environment).filter(([, value]) => value);
  if (env.length > 0)
    lines.push(
      "",
      "## Environment",
      ...env.map(([key, value]) => `- ${key}: ${value}`),
    );

  const relevantMessages = session.conversation
    .filter((message) => message.handoff_relevant)
    .sort((a, b) => b.sequence - a.sequence);
  if (relevantMessages.length > 0) {
    lines.push("", "## Relevant conversation");
    for (const message of relevantMessages) {
      const text = message.content
        .map((part) =>
          part.type === "text"
            ? (part.text ?? "")
            : (part.note ?? `[${part.type}]`),
        )
        .join("\n");
      lines.push(`- **${message.role}:** ${text}`);
    }
  }

  const full = `${lines.join("\n")}\n`;
  const codePoints = Array.from(full);
  if (codePoints.length <= MAX_HANDOFF_CHARACTERS) return full;
  const notice = Array.from(TRUNCATION_NOTICE);
  const prefix = codePoints
    .slice(0, MAX_HANDOFF_CHARACTERS - notice.length)
    .join("")
    .trimEnd();
  return `${prefix}${TRUNCATION_NOTICE}`;
}
