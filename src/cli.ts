#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseSessionJson } from "./core/session-serialization.js";

const HELP = `Spider Web ${process.env.npm_package_version ?? "0.1.0"}

Usage:
  spider-web --help
  spider-web --version
  spider-web session validate <session.json>

Commands:
  session validate <file>  Validate a provider-neutral Spider Session file
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (values.version) { process.stdout.write("0.1.0\n"); return; }
  if (positionals.length !== 3 || positionals[0] !== "session" || positionals[1] !== "validate") {
    process.stderr.write(`${HELP}\nInvalid command.\n`);
    process.exitCode = 2;
    return;
  }
  const session = parseSessionJson(await readFile(positionals[2]!, "utf8"));
  process.stdout.write(`Valid Spider Session ${session.schema_version}\nID: ${session.session.id}\nStatus: ${session.objective.status}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`spider-web: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
