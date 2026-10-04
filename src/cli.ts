#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { parseSessionJson } from "./core/session-serialization.js";
import { readSpiderEggFile, writeSpiderEggFile } from "./egg/archive.js";

const HELP = `Spider Web ${process.env.npm_package_version ?? "0.1.0"}

Usage:
  spider-web --help
  spider-web --version
  spider-web session validate <session.json>
  spider-web session export <session.json> <output.spider-egg> [--confirm-sensitive]
  spider-web session inspect <input.spider-egg>

Commands:
  session validate <file>  Validate a provider-neutral Spider Session file
  session export <file> <output>  Create a portable Spider Egg
  session inspect <file>  Verify an Egg and show its session summary
`;

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
  if (
    positionals[0] !== "session" ||
    !["validate", "export", "inspect"].includes(positionals[1] ?? "")
  ) {
    process.stderr.write(`${HELP}\nInvalid command.\n`);
    process.exitCode = 2;
    return;
  }

  const command = positionals[1];
  if (command === "validate" && positionals.length === 3) {
    const session = parseSessionJson(await readFile(positionals[2]!, "utf8"));
    process.stdout.write(
      `Valid Spider Session ${session.schema_version}\nID: ${session.session.id}\nStatus: ${session.objective.status}\n`,
    );
    return;
  }
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
    if (!values["confirm-sensitive"]) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "Export contains sensitive session content; rerun with --confirm-sensitive",
        );
      }
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await prompt.question("Create this Spider Egg? [y/N] ");
        if (!/^y(es)?$/i.test(answer.trim()))
          throw new Error("Export cancelled");
      } finally {
        prompt.close();
      }
    }
    await writeSpiderEggFile(positionals[3]!, session);
    process.stdout.write(`Saved Spider Egg: ${positionals[3]}\n`);
    return;
  }
  if (command === "inspect" && positionals.length === 3) {
    const egg = await readSpiderEggFile(positionals[2]!);
    process.stdout.write(
      `Valid Spider Egg 0.1\nID: ${egg.session.session.id}\nStatus: ${egg.session.objective.status}\nMessages: ${egg.session.conversation.length}\nArtifacts: ${egg.artifacts.length}\n`,
    );
    return;
  }
  process.stderr.write(`${HELP}\nInvalid arguments.\n`);
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `spider-web: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
