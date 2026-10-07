import * as childProcess from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { env } from "node:process";

export type CodexLaunchStrategy =
  "direct" | "node-script" | "windows-command-shim";

export interface ResolvedCodexExecutable {
  readonly binary: string;
  readonly launcher: CodexLaunchStrategy;
  readonly nodeBinary?: string;
  readonly script?: string;
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

export interface ShimFileSystem {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
}

export interface CodexExecutableDiscoveryOptions {
  readonly whereFn?: WindowsWhereFunction | undefined;
  readonly spawnFn?: SpawnSyncFunction | undefined;
  readonly fs?: ShimFileSystem | undefined;
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

const defaultFs: ShimFileSystem = {
  existsSync,
  readFileSync,
};

function extractDiscovery(discoveryParam?: CodexDiscoveryParam): {
  whereFn: WindowsWhereFunction;
  spawnFn?: SpawnSyncFunction | undefined;
  fs: ShimFileSystem;
} {
  const fs =
    typeof discoveryParam === "object" &&
    discoveryParam !== null &&
    "fs" in discoveryParam &&
    discoveryParam.fs !== undefined
      ? discoveryParam.fs
      : defaultFs;
  if (!discoveryParam) {
    return { whereFn: defaultWhereFn, fs };
  }
  if (typeof discoveryParam === "object") {
    return {
      whereFn: discoveryParam.whereFn ?? defaultWhereFn,
      ...(discoveryParam.spawnFn !== undefined
        ? { spawnFn: discoveryParam.spawnFn }
        : {}),
      fs,
    };
  }
  if (typeof discoveryParam === "function") {
    if (discoveryParam.length >= 2) {
      return {
        whereFn: defaultWhereFn,
        spawnFn: discoveryParam as SpawnSyncFunction,
        fs,
      };
    }
    try {
      const probe = (discoveryParam as (cmd: string) => unknown)("__probe__");
      if (typeof probe === "string") {
        return { whereFn: discoveryParam as WindowsWhereFunction, fs };
      }
      if (typeof probe === "object" && probe !== null && "status" in probe) {
        return {
          whereFn: defaultWhereFn,
          spawnFn: discoveryParam as SpawnSyncFunction,
          fs,
        };
      }
    } catch {
      return { whereFn: discoveryParam as WindowsWhereFunction, fs };
    }
    return { whereFn: discoveryParam as WindowsWhereFunction, fs };
  }
  return { whereFn: defaultWhereFn, fs };
}

export function resolveNpmShim(
  shimPath: string,
  fileSystem: ShimFileSystem = defaultFs,
): ResolvedCodexExecutable {
  if (!fileSystem.existsSync(shimPath)) {
    throw new Error(`Codex executable not found: ${shimPath}`);
  }

  const shimDir = path.dirname(shimPath);
  let content = "";
  try {
    content = fileSystem.readFileSync(shimPath, "utf8");
  } catch {
    // fallback if unreadable
  }

  const isLikelyNpmShim =
    content.length === 0 ||
    /%dp0%/i.test(content) ||
    /%_prog%/i.test(content) ||
    /node_modules/i.test(content) ||
    /\bnode\b/i.test(content);

  if (!isLikelyNpmShim) {
    throw new Error(`Invalid Codex npm shim: not an npm shim: ${shimPath}`);
  }

  let scriptPath: string | undefined;
  const dp0Match = content.match(/%dp0%[\\/]([^\r\n"]+?\.js)/i);
  if (dp0Match && dp0Match[1]) {
    const candidate = path.resolve(shimDir, dp0Match[1]);
    if (fileSystem.existsSync(candidate)) {
      scriptPath = candidate;
    }
  }

  if (!scriptPath) {
    const codexJsMatch = content.match(/["']?([^"'\r\n]+?codex\.js)["']?/i);
    if (codexJsMatch && codexJsMatch[1]) {
      const candidate = path.isAbsolute(codexJsMatch[1])
        ? codexJsMatch[1]
        : path.resolve(shimDir, codexJsMatch[1]);
      if (fileSystem.existsSync(candidate)) {
        scriptPath = candidate;
      }
    }
  }

  if (!scriptPath) {
    const standardNpmScript = path.resolve(
      shimDir,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (fileSystem.existsSync(standardNpmScript)) {
      scriptPath = standardNpmScript;
    }
  }

  if (!scriptPath) {
    const altNpmScript = path.resolve(
      shimDir,
      "node_modules",
      "codex",
      "bin",
      "codex.js",
    );
    if (fileSystem.existsSync(altNpmScript)) {
      scriptPath = altNpmScript;
    }
  }

  if (!scriptPath) {
    throw new Error(
      `Invalid Codex npm shim: entrypoint not found for ${shimPath}`,
    );
  }

  const localNode = path.resolve(shimDir, "node.exe");
  const nodeBinary = fileSystem.existsSync(localNode) ? localNode : "node";

  return {
    binary: shimPath,
    launcher: "node-script",
    nodeBinary,
    script: scriptPath,
  };
}

function resolveWindowsCodexExecutable(
  command: string,
  whereFn: WindowsWhereFunction,
  fileSystem: ShimFileSystem,
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
    return resolveNpmShim(shimMatch, fileSystem);
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
  const { whereFn, spawnFn, fs } = extractDiscovery(discoveryParam);

  if (explicitBinary && explicitBinary.length > 0) {
    const hasPathSeparator = /[\\/]/.test(explicitBinary);

    if (hasPathSeparator) {
      if (isWindows() && /\.(?:cmd|bat)$/i.test(explicitBinary)) {
        try {
          return resolveNpmShim(explicitBinary, fs);
        } catch (error) {
          if (fs.existsSync(explicitBinary)) {
            return { binary: explicitBinary, launcher: "windows-command-shim" };
          }
          throw error;
        }
      }
      if (spawnFn !== undefined) {
        const result = spawnFn(explicitBinary, ["--version"], {
          stdio: "ignore",
          windowsHide: true,
          launcher: launcherFor(explicitBinary),
        });
        if (result.status !== 0) {
          throw new Error(`Codex executable not found: ${explicitBinary}`);
        }
      }
      return { binary: explicitBinary, launcher: launcherFor(explicitBinary) };
    }

    if (isWindows()) {
      return resolveWindowsCodexExecutable(explicitBinary, whereFn, fs);
    }

    const found = findInUnixPath(explicitBinary, spawnFn);
    if (found) return found;
    throw new Error(`Codex executable not found: ${explicitBinary}`);
  }

  if (isWindows()) {
    return resolveWindowsCodexExecutable("codex", whereFn, fs);
  }

  const found = findInUnixPath("codex", spawnFn);
  if (found) return found;
  throw new Error("Codex executable not found");
}

export function getCodexBinaryName(): string {
  return isWindows() ? "codex.cmd" : "codex";
}
