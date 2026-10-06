#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  parseSessionJson,
  writeSessionJsonFile,
} from "./core/session-serialization.js";
import { readSpiderEggFile, writeSpiderEggFile } from "./egg/archive.js";
import { LocalSessionRepository } from "./repository/local-session-repository.js";
import type { SessionSummary } from "./repository/session-repository.js";

const HELP = `Spider Web ${process.env.npm_package_version ?? "0.1.0"}

Usage:
  spider-web --help
  spider-web --version

Session repository:
  spider-web session list
  spider-web session inspect <session-id>
  spider-web session export <session-id> <output.spider-egg> [--confirm-sensitive]
  spider-web session delete <session-id>
  spider-web session import <input.spider-egg> [--confirm-sensitive]

Egg archive:
  spider-web egg export <session.json> <output.spider-egg> [--confirm-sensitive]
  spider-web egg import <input.spider-egg> <output-session.json> [--confirm-sensitive]
  spider-web egg inspect <input.spider-egg>

Session document:
  spider-web session validate <session.json>

Commands:
  session list                       List stored sessions
  session inspect <session-id>       Show a stored session summary
  session export <session-id> <file>  Export a stored session as a Spider Egg
  session delete <session-id>        Delete a stored session
  session import <file.spider-egg>   Store a session from a Spider Egg
  egg export <file> <output>         Create a Spider Egg from a session file
  egg import <file> <output>         Recover the session from a Spider Egg file
  egg inspect <file>                 Verify a Spider Egg file
  session validate <file>            Validate a Spider Session JSON file
`;

async function requireSensitiveConfirmation(
  message: string,
  prompt: string,
  confirmed: boolean,
): Promise<void> {
  if (confirmed) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${message}; rerun with --confirm-sensitive`);
  }
  const promptInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await promptInterface.question(prompt);
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Cancelled");
  } finally {
    promptInterface.close();
  }
}

function formatCell(value: string, width: number): string {
  if (value.length > width) return `${value.slice(0, Math.max(width - 1, 0))}…`;
  return value.padEnd(width);
}

function renderSessionTable(sessions: readonly SessionSummary[]): string {
  const headers = [
    "ID",
    "TITLE",
    "AGENT",
    "PROJECT",
    "STATUS",
    "UPDATED",
  ] as const;
  const rows = sessions.map((session) => [
    session.id,
    session.title,
    session.source_agent,
    session.project_name ?? "",
    session.status,
    session.updated_at,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const headerLine = headers
    .map((header, index) => formatCell(header, widths[index] ?? header.length))
    .join("  ");
  const bodyLines = rows.map((row) =>
    row
      .map((cell, index) => formatCell(cell, widths[index] ?? cell.length))
      .join("  "),
  );
  return [headerLine, ...bodyLines].join("\n");
}

function renderSessionDetails(session: {
  readonly session: {
    readonly id: string;
    readonly created_at: string;
    readonly updated_at: string;
    readonly source_agent: string;
    readonly project: { readonly name: string | null };
  };
  readonly objective: {
    readonly goal: string;
    readonly status: string;
  };
  readonly state: {
    readonly current_task: string | null;
  };
  readonly conversation: readonly unknown[];
  readonly tool_calls: readonly unknown[];
  readonly commands: readonly unknown[];
  readonly tests: readonly unknown[];
  readonly errors: readonly unknown[];
  readonly next_action: { readonly description: string } | null;
}): string {
  const lines = [
    `Session: ${session.session.id}`,
    `Title: ${session.objective.goal}`,
    `Status: ${session.objective.status}`,
    `Agent: ${session.session.source_agent}`,
    `Project: ${session.session.project.name ?? "(none)"}`,
    `Created: ${session.session.created_at}`,
    `Updated: ${session.session.updated_at}`,
  ];
  if (session.state.current_task)
    lines.push(`Current task: ${session.state.current_task}`);
  if (session.next_action)
    lines.push(`Next action: ${session.next_action.description}`);
  lines.push(
    `Messages: ${session.conversation.length}`,
    `Tool calls: ${session.tool_calls.length}`,
    `Commands: ${session.commands.length}`,
    `Tests: ${session.tests.length}`,
    `Errors: ${session.errors.length}`,
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "confirm-sensitive": { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write("0.1.0\n");
    return;
  }

  const group = positionals[0];
  const command = positionals[1];
  const repository = new LocalSessionRepository();

  if (group === "session") {
    if (command === "list" && positionals.length === 2) {
      const sessions = await repository.list();
      if (sessions.length === 0) {
        process.stdout.write("No sessions.\n");
        return;
      }
      process.stdout.write(`${renderSessionTable(sessions)}\n`);
      return;
    }
    if (command === "inspect" && positionals.length === 3) {
      const session = await repository.get(positionals[2]!);
      if (session === null)
        throw new Error(`Session not found: ${positionals[2]}`);
      process.stdout.write(renderSessionDetails(session));
      return;
    }
    if (command === "export" && positionals.length === 4) {
      const session = await repository.get(positionals[2]!);
      if (session === null)
        throw new Error(`Session not found: ${positionals[2]}`);
      const includedArtifactCount = session.artifacts.filter(
        (item) => item.inclusion === "included",
      ).length;
      if (includedArtifactCount > 0) {
        throw new Error(
          "This CLI export accepts session and handoff data only; use the library API to supply explicitly selected artifact bytes",
        );
      }
      process.stdout.write(
        `Spider Egg export preview\nSession: ${session.session.id}\nMessages: ${session.conversation.length}\nArtifacts: 0\n`,
      );
      await requireSensitiveConfirmation(
        "Export contains sensitive session content",
        "Create this Spider Egg? [y/N] ",
        values["confirm-sensitive"] === true,
      );
      await writeSpiderEggFile(positionals[3]!, session);
      process.stdout.write(`Saved Spider Egg: ${positionals[3]}\n`);
      return;
    }
    if (command === "delete" && positionals.length === 3) {
      await repository.delete(positionals[2]!);
      process.stdout.write(`Deleted session: ${positionals[2]}\n`);
      return;
    }
    if (command === "import" && positionals.length === 3) {
      const egg = await readSpiderEggFile(positionals[2]!);
      const includedArtifactCount = egg.session.artifacts.filter(
        (item) => item.inclusion === "included",
      ).length;
      process.stdout.write(
        `Spider Egg import preview\nSession: ${egg.session.session.id}\nStatus: ${egg.session.objective.status}\nMessages: ${egg.session.conversation.length}\nArtifacts: ${includedArtifactCount}\n`,
      );
      await requireSensitiveConfirmation(
        "Import contains sensitive session content",
        "Import this Spider Egg? [y/N] ",
        values["confirm-sensitive"] === true,
      );
      await repository.import(egg.session);
      process.stdout.write(`Imported session: ${egg.session.session.id}\n`);
      return;
    }
    if (command === "validate" && positionals.length === 3) {
      const session = parseSessionJson(await readFile(positionals[2]!, "utf8"));
      process.stdout.write(
        `Valid Spider Session ${session.schema_version}\nID: ${session.session.id}\nStatus: ${session.objective.status}\n`,
      );
      return;
    }
  }

  if (group === "egg") {
    if (command === "export" && positionals.length === 4) {
      const session = parseSessionJson(await readFile(positionals[2]!, "utf8"));
      const includedArtifactCount = session.artifacts.filter(
        (item) => item.inclusion === "included",
      ).length;
      if (includedArtifactCount > 0) {
        throw new Error(
          "This CLI export accepts session and handoff data only; use the library API to supply explicitly selected artifact bytes",
        );
      }
      process.stdout.write(
        `Spider Egg export preview\nSession: ${session.session.id}\nMessages: ${session.conversation.length}\nArtifacts: 0\n`,
      );
      await requireSensitiveConfirmation(
        "Export contains sensitive session content",
        "Create this Spider Egg? [y/N] ",
        values["confirm-sensitive"] === true,
      );
      await writeSpiderEggFile(positionals[3]!, session);
      process.stdout.write(`Saved Spider Egg: ${positionals[3]}\n`);
      return;
    }
    if (command === "import" && positionals.length === 4) {
      const egg = await readSpiderEggFile(positionals[2]!);
      const includedArtifactCount = egg.session.artifacts.filter(
        (item) => item.inclusion === "included",
      ).length;
      process.stdout.write(
        `Spider Egg import preview\nSession: ${egg.session.session.id}\nStatus: ${egg.session.objective.status}\nMessages: ${egg.session.conversation.length}\nArtifacts: ${includedArtifactCount}\n`,
      );
      await requireSensitiveConfirmation(
        "Import contains sensitive session content",
        "Import this Spider Egg? [y/N] ",
        values["confirm-sensitive"] === true,
      );
      await writeSessionJsonFile(positionals[3]!, egg.session);
      process.stdout.write(`Saved Spider Session: ${positionals[3]}\n`);
      return;
    }
    if (command === "inspect" && positionals.length === 3) {
      const egg = await readSpiderEggFile(positionals[2]!);
      process.stdout.write(
        `Valid Spider Egg 0.1\nID: ${egg.session.session.id}\nStatus: ${egg.session.objective.status}\nMessages: ${egg.session.conversation.length}\nArtifacts: ${egg.artifacts.length}\n`,
      );
      return;
    }
  }

  process.stderr.write(`${HELP}\nInvalid command.\n`);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `spider-web: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
