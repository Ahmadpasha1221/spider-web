#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  parseSessionJson,
  writeSessionJsonFile,
} from "./core/session-serialization.js";
import { readSpiderEggFile, writeSpiderEggFile } from "./egg/archive.js";
import { LocalSessionRepository } from "./repository/local-session-repository.js";
import type { SessionSummary } from "./repository/session-repository.js";
import { ClaudeAgentRunner } from "./adapters/claude/claude-adapter.js";
import { CodexAgentRunner } from "./adapters/codex/codex-runner.js";
import type { CodexRunConfig } from "./adapters/codex/codex-types.js";
import {
  buildContinuationContext,
  renderContinuationPrompt,
} from "./continuation/continuation.js";
import type {
  AgentEvent,
  AgentPermissionMode,
} from "./adapters/agent-runner.js";

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

Agent:
  spider-web agent claude run <prompt> [--cwd <dir>] [--permission-mode <mode>]
                              [--model <model>] [--max-turns <n>]
                              [--max-budget-usd <usd>] [--interactive]
  spider-web agent codex run <prompt> [--cwd <dir>] [--permission-mode <mode>]
                             [--model <model>] [--sandbox <mode>] [--ephemeral]
                             [--allow-dangerous-bypass]

Continuation:
  spider-web session handoff <session-id> [--output <file>]
  spider-web session continue <session-id> --provider codex [agent options]

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
  agent claude run <prompt>          Run Claude Code and record the session
  agent codex run <prompt>           Run Codex and record the session
  session handoff <id>               Print the continuation prompt for a session
  session continue <id>              Continue a session in a new Codex thread

Agent options:
  --cwd <dir>              Working directory (default: current directory)
  --permission-mode <mode> default | accept-edits | plan | bypass-permissions
  --model <model>          Model override for the run
  --max-turns <n>          Stop the run after <n> turns
  --max-budget-usd <usd>   Stop the run after spending <usd> dollars
  --interactive            Keep the run alive for further prompts (library use)
  --sandbox <mode>         Codex sandbox: read-only | workspace-write | danger-full-access
  --ephemeral              Codex: do not persist rollout files
  --allow-dangerous-bypass Codex: allow danger-full-access (explicit only)
  --ask-for-approval <mode> Codex approval policy: on-request | never
  --provider <name>        Continuation provider (codex only in this phase)
  --output <file>          Write the handoff prompt to a file
  --resume-thread <id>     Provider-native resume of a Codex thread

Interrupt a running agent with Ctrl+C; the session stays stored and inspectable.
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
      cwd: { type: "string" },
      model: { type: "string" },
      "permission-mode": { type: "string" },
      "max-turns": { type: "string" },
      "max-budget-usd": { type: "string" },
      interactive: { type: "boolean" },
      sandbox: { type: "string" },
      ephemeral: { type: "boolean" },
      "allow-dangerous-bypass": { type: "boolean" },
      "ask-for-approval": { type: "string" },
      provider: { type: "string" },
      output: { type: "string" },
      "resume-thread": { type: "string" },
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
    if (command === "handoff" && positionals.length === 3) {
      const session = await repository.get(positionals[2]!);
      if (session === null)
        throw new Error(`Session not found: ${positionals[2]}`);
      const prompt = renderContinuationPrompt(
        buildContinuationContext(session),
      );
      if (typeof values.output === "string") {
        await writeFile(values.output, prompt, "utf8");
        process.stdout.write(`Saved handoff: ${values.output}\n`);
      } else {
        process.stdout.write(prompt);
      }
      return;
    }
    if (command === "continue" && positionals.length === 3) {
      if (values.provider !== undefined && values.provider !== "codex") {
        throw new Error(
          `Unsupported continuation provider: ${values.provider}`,
        );
      }
      const session = await repository.get(positionals[2]!);
      if (session === null)
        throw new Error(`Session not found: ${positionals[2]}`);
      const prompt = renderContinuationPrompt(
        buildContinuationContext(session),
      );
      await runCodexAgent(repository, prompt, values, session);
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

  if (group === "agent") {
    if (
      command === "claude" &&
      positionals[2] === "run" &&
      positionals.length >= 4
    ) {
      await runClaudeAgent(repository, positionals.slice(3).join(" "), values);
      return;
    }
    if (command === "claude" && positionals[2] === "run") {
      throw new Error(
        "Missing prompt. Usage: spider-web agent claude run <prompt> [--cwd <dir>]",
      );
    }
    if (
      command === "codex" &&
      positionals[2] === "run" &&
      positionals.length >= 4
    ) {
      await runCodexAgent(repository, positionals.slice(3).join(" "), values);
      return;
    }
    if (command === "codex" && positionals[2] === "run") {
      throw new Error(
        "Missing prompt. Usage: spider-web agent codex run <prompt> [--cwd <dir>]",
      );
    }
  }

  process.stderr.write(`${HELP}\nInvalid command.\n`);
  process.exitCode = 2;
}

function parsePermissionMode(value: unknown): AgentPermissionMode {
  if (
    value === "default" ||
    value === "accept-edits" ||
    value === "plan" ||
    value === "bypass-permissions"
  ) {
    return value;
  }
  throw new Error(
    `Invalid --permission-mode: ${String(value)} (expected default, accept-edits, plan, or bypass-permissions)`,
  );
}

function parseNumberOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${String(value)}`);
  }
  return parsed;
}

/**
 * Print one normalized agent event. Conversation content the
 * user asked to see (assistant text) is printed; tool output
 * is not, because it may contain credentials or secrets.
 */
function printAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "session_started":
      process.stdout.write(
        `Claude Code session ${event.providerSessionId} started\n`,
      );
      break;
    case "user_message":
      process.stdout.write("Prompt recorded\n");
      break;
    case "assistant_message":
      process.stdout.write(`${event.text}\n`);
      break;
    case "tool_call":
      process.stdout.write(`Tool ${event.description}\n`);
      break;
    case "tool_result":
      break;
    case "command_started":
      process.stdout.write(`$ ${event.command}\n`);
      break;
    case "command_finished":
      process.stdout.write(
        `$ ${event.command} -> ${event.status}${
          event.exitCode === null ? "" : ` (exit ${event.exitCode})`
        }\n`,
      );
      break;
    case "file_changed":
      process.stdout.write(`File ${event.change}: ${event.path}\n`);
      break;
    case "test":
      process.stdout.write(`Test ${event.name}: ${event.status}\n`);
      break;
    case "error":
      process.stderr.write(`Error [${event.kind}]: ${event.message}\n`);
      break;
    case "session_completed":
      process.stdout.write(
        `Completed (${event.turns} turns${
          event.totalCostUsd === null ? "" : `, $${event.totalCostUsd}`
        })\n`,
      );
      break;
    case "session_failed":
      process.stderr.write(`Run failed [${event.kind}]: ${event.message}\n`);
      break;
    case "process_exited":
      process.stderr.write("Agent process ended without a completion result\n");
      break;
    case "capture_note":
      break;
  }
}

async function runClaudeAgent(
  repository: LocalSessionRepository,
  prompt: string,
  values: Record<string, unknown>,
): Promise<void> {
  const permissionMode =
    values["permission-mode"] === undefined
      ? undefined
      : parsePermissionMode(values["permission-mode"]);
  const maxTurns = parseNumberOption(values["max-turns"], "--max-turns");
  const maxBudgetUsd = parseNumberOption(
    values["max-budget-usd"],
    "--max-budget-usd",
  );
  const runner = new ClaudeAgentRunner({
    repository,
    onEvent: printAgentEvent,
  });
  const handle = await runner.start({
    prompt,
    cwd: typeof values.cwd === "string" ? values.cwd : process.cwd(),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(values.interactive === true ? { interactive: true } : {}),
  });
  const onSigint = () => {
    // Interruption is cooperative: stop() asks the SDK to
    // interrupt, the run settles, and the CLI exits below.
    void handle.stop();
  };
  process.on("SIGINT", onSigint);
  try {
    const outcome = await handle.wait();
    if (outcome.status === "completed") {
      process.stdout.write("Run completed.\n");
    } else if (outcome.status === "cancelled") {
      process.stdout.write("Run cancelled.\n");
      process.exitCode = 130;
    } else {
      process.stderr.write(
        `Run failed: ${outcome.error?.message ?? "unknown error"}\n`,
      );
      process.exitCode = 1;
    }
    process.stdout.write(`Session: ${handle.sessionId}\n`);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function parseCodexSandbox(value: unknown): CodexRunConfig["sandbox"] {
  if (value === undefined) return undefined;
  if (value === "read-only" || value === "workspace-write") return value;
  if (value === "danger-full-access") return value;
  throw new Error(`Invalid --sandbox: ${String(value)}`);
}

async function runCodexAgent(
  repository: LocalSessionRepository,
  prompt: string,
  values: Record<string, unknown>,
  continuationSession?: Awaited<ReturnType<LocalSessionRepository["get"]>>,
): Promise<void> {
  const permissionMode =
    values["permission-mode"] === undefined
      ? undefined
      : parsePermissionMode(values["permission-mode"]);
  const runner = new CodexAgentRunner({ repository, onEvent: printCodexEvent });
  const sandbox = parseCodexSandbox(values.sandbox);
  const approvalPolicy =
    values["ask-for-approval"] === undefined
      ? undefined
      : parseCodexApproval(values["ask-for-approval"]);
  const config: CodexRunConfig = {
    ...(continuationSession !== undefined && continuationSession !== null
      ? { session: continuationSession }
      : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
    ...(values.ephemeral === true ? { ephemeral: true as const } : {}),
    ...(values["allow-dangerous-bypass"] === true
      ? { allowDangerousBypass: true as const }
      : {}),
    ...(typeof values["resume-thread"] === "string"
      ? { resumeThreadId: values["resume-thread"] }
      : {}),
  };
  const handle = await runner.start(
    {
      prompt,
      cwd: typeof values.cwd === "string" ? values.cwd : process.cwd(),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(typeof values.model === "string" ? { model: values.model } : {}),
    },
    config,
  );
  const onSigint = () => {
    void handle.stop();
  };
  process.on("SIGINT", onSigint);
  try {
    const outcome = await handle.wait();
    if (outcome.status === "completed") {
      process.stdout.write("Run completed.\n");
    } else if (outcome.status === "cancelled") {
      process.stdout.write("Run cancelled.\n");
      process.exitCode = 130;
    } else {
      process.stderr.write(
        `Run failed: ${outcome.error?.message ?? "unknown error"}\n`,
      );
      process.exitCode = 1;
    }
    process.stdout.write(`Session: ${handle.sessionId}\n`);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function parseCodexApproval(value: unknown): CodexRunConfig["approvalPolicy"] {
  if (value === "on-request" || value === "never") return value;
  throw new Error(`Invalid --ask-for-approval: ${String(value)}`);
}

function printCodexEvent(event: AgentEvent): void {
  if (event.type === "session_started") {
    process.stdout.write(`Codex thread ${event.providerSessionId} started\n`);
  } else {
    printAgentEvent(event);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `spider-web: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
