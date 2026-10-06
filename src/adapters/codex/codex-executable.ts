import * as childProcess from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { env } from "node:process";

export type CodexLaunchStrategy = "direct" | "windows-command-shim";

export interface ResolvedCodexExecutable {
  readonly binary: string;
  readonly launcher: CodexLaunchStrategy;
}

export interface SpawnSyncFunction {
  (
    command: string,
    args: readonly string[],
    options: {
      stdio: "ignore";
      windowsHide: boolean;
      launcher: CodexLaunchStrategy;
    },
  ): { status: number | null; error?: Error };
}

export type WindowsWhereFunction = (command: string) => string;

export interface CodexExecutableDiscoveryOptions {
  readonly whereFn?: WindowsWhereFunction | undefined;
  readonly spawnFn?: SpawnSyncFunction | undefined;
}

export type CodexDiscoveryParam =
  SpawnSyncFunction | WindowsWhereFunction | CodexExecutableDiscoveryOptions;

function isWindows(): boolean {
  return process.platform === "win32";
}

function getPathEntries(): string[] {
  return (env.PATH ?? "").split(isWindows() ? ";" : ":");
}

function launcherFor(binary: string): CodexLaunchStrategy {
  return isWindows() && /\.(?:cmd|bat)$/i.test(binary)
    ? "windows-command-shim"
    : "direct";
}

function defaultWhereFn(command: string): string {
  try {
    return childProcess.execFileSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

function extractDiscovery(discoveryParam?: CodexDiscoveryParam): {
  whereFn: WindowsWhereFunction;
  spawnFn?: SpawnSyncFunction | undefined;
} {
  if (!discoveryParam) {
    return { whereFn: defaultWhereFn };
  }
  if (typeof discoveryParam === "object") {
    return {
      whereFn: discoveryParam.whereFn ?? defaultWhereFn,
      ...(discoveryParam.spawnFn !== undefined
        ? { spawnFn: discoveryParam.spawnFn }
        : {}),
    };
  }
  if (typeof discoveryParam === "function") {
    if (discoveryParam.length >= 2) {
      return {
        whereFn: defaultWhereFn,
        spawnFn: discoveryParam as SpawnSyncFunction,
      };
    }
    try {
      const probe = (discoveryParam as (cmd: string) => unknown)("__probe__");
      if (typeof probe === "string") {
        return { whereFn: discoveryParam as WindowsWhereFunction };
      }
      if (typeof probe === "object" && probe !== null && "status" in probe) {
        return {
          whereFn: defaultWhereFn,
          spawnFn: discoveryParam as SpawnSyncFunction,
        };
      }
    } catch {
      return { whereFn: discoveryParam as WindowsWhereFunction };
    }
    return { whereFn: discoveryParam as WindowsWhereFunction };
  }
  return { whereFn: defaultWhereFn };
}

function resolveWindowsCodexExecutable(
  command: string,
  whereFn: WindowsWhereFunction,
): ResolvedCodexExecutable {
  let output = "";
  try {
    output = whereFn(command);
  } catch {
    output = "";
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const exeMatch = lines.find((line) => /\.exe$/i.test(line));
  if (exeMatch) {
    return { binary: exeMatch, launcher: "direct" };
  }

  const shimMatch = lines.find((line) => /\.(?:cmd|bat)$/i.test(line));
  if (shimMatch) {
    return { binary: shimMatch, launcher: "windows-command-shim" };
  }

  throw new Error(
    command === "codex"
      ? "Codex executable not found"
      : `Codex executable not found: ${command}`,
  );
}

function findInUnixPath(
  command: string,
  spawnFn?: SpawnSyncFunction,
): ResolvedCodexExecutable | null {
  for (const pathEntry of getPathEntries()) {
    if (pathEntry.length === 0) continue;
    const candidate = path.posix.resolve(pathEntry, command);
    if (spawnFn !== undefined) {
      const result = spawnFn(candidate, ["--version"], {
        stdio: "ignore",
        windowsHide: true,
        launcher: "direct",
      });
      if (result.status === 0) {
        return { binary: candidate, launcher: "direct" };
      }
    } else {
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return { binary: candidate, launcher: "direct" };
        }
      } catch {
        // continue search
      }
    }
  }
  return null;
}

/** Quote one argument for the command line consumed by cmd.exe /c. */
export function quoteWindowsCommandArgument(value: string): string {
  if (value.length === 0) return '""';
  const escaped = value.replace(/["^&|<>!]/g, (character) => `^${character}`);
  return `"${escaped}"`;
}

export function buildWindowsCommandLine(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args].map(quoteWindowsCommandArgument).join(" ");
}

export function resolveCodexExecutable(
  explicitBinary?: string,
  discoveryParam?: CodexDiscoveryParam,
): ResolvedCodexExecutable {
  const { whereFn, spawnFn } = extractDiscovery(discoveryParam);

  if (explicitBinary && explicitBinary.length > 0) {
    const launcher = launcherFor(explicitBinary);
    const hasPathSeparator = /[\\/]/.test(explicitBinary);

    if (hasPathSeparator) {
      if (spawnFn !== undefined) {
        const result = spawnFn(explicitBinary, ["--version"], {
          stdio: "ignore",
          windowsHide: true,
          launcher,
        });
        if (result.status !== 0) {
          throw new Error(`Codex executable not found: ${explicitBinary}`);
        }
      }
      return { binary: explicitBinary, launcher };
    }

    if (isWindows()) {
      return resolveWindowsCodexExecutable(explicitBinary, whereFn);
    }

    const found = findInUnixPath(explicitBinary, spawnFn);
    if (found) return found;
    throw new Error(`Codex executable not found: ${explicitBinary}`);
  }

  if (isWindows()) {
    return resolveWindowsCodexExecutable("codex", whereFn);
  }

  const found = findInUnixPath("codex", spawnFn);
  if (found) return found;
  throw new Error("Codex executable not found");
}

export function getCodexBinaryName(): string {
  return isWindows() ? "codex.cmd" : "codex";
}
