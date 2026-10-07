import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildWindowsCommandLine,
  getCodexBinaryName,
  resolveCodexExecutable,
  type SpawnSyncFunction,
} from "../../src/adapters/codex/codex-executable.js";

const originalPlatform = process.platform;
const originalPath = process.env.PATH;

function mockPlatform(platform: string): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}
function mockPath(path: string): void {
  process.env.PATH = path;
}
function restorePlatform(): void {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
}
function restorePath(): void {
  process.env.PATH = originalPath;
}
function createMockSpawn(successCommands: string[]): SpawnSyncFunction {
  return (command: string) => {
    const base = command.split(/[\\/]/).pop() ?? command;
    return successCommands.includes(base)
      ? { status: 0 }
      : { status: 1, error: new Error("ENOENT") };
  };
}

describe("resolveCodexExecutable", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    restorePlatform();
    restorePath();
    vi.restoreAllMocks();
  });

  it("returns codex on Unix with direct launching", () => {
    mockPlatform("linux");
    mockPath("/usr/bin:/bin");
    const result = resolveCodexExecutable(
      undefined,
      createMockSpawn(["codex"]),
    );
    expect(result).toEqual({ binary: "/usr/bin/codex", launcher: "direct" });
  });

  it("selects a Windows native executable", () => {
    mockPlatform("win32");
    const result = resolveCodexExecutable(
      undefined,
      () => "C:\\tools\\codex.exe\r\n",
    );
    expect(result).toEqual({
      binary: "C:\\tools\\codex.exe",
      launcher: "direct",
    });
  });

  it("selects a Windows native executable via options object", () => {
    mockPlatform("win32");
    const result = resolveCodexExecutable(undefined, {
      whereFn: () => "C:\\tools\\codex.exe\r\n",
    });
    expect(result).toEqual({
      binary: "C:\\tools\\codex.exe",
      launcher: "direct",
    });
  });

  it("resolves Windows codex.cmd to a Node-script launch", () => {
    mockPlatform("win32");
    const mockFs = {
      existsSync: (p: string) =>
        p === "C:\\fake\\npm\\codex.cmd" ||
        p === "C:\\fake\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      readFileSync: () =>
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
    };
    const result = resolveCodexExecutable(undefined, {
      whereFn: () => "C:\\fake\\npm\\codex.cmd\r\n",
      fs: mockFs,
    });
    expect(result).toEqual({
      binary: "C:\\fake\\npm\\codex.cmd",
      launcher: "node-script",
      nodeBinary: "node",
      script: "C:\\fake\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    });
  });

  it("resolves the underlying Node executable correctly when local node.exe exists", () => {
    mockPlatform("win32");
    const mockFs = {
      existsSync: (p: string) =>
        p === "C:\\fake\\npm\\codex.cmd" ||
        p === "C:\\fake\\npm\\node.exe" ||
        p === "C:\\fake\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      readFileSync: () =>
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
    };
    const result = resolveCodexExecutable(undefined, {
      whereFn: () => "C:\\fake\\npm\\codex.cmd\r\n",
      fs: mockFs,
    });
    expect(result.nodeBinary).toBe("C:\\fake\\npm\\node.exe");
    expect(result.script).toBe(
      "C:\\fake\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    );
  });

  it("selects a Windows npm command shim when preceded by extensionless script", () => {
    mockPlatform("win32");
    const mockFs = {
      existsSync: (p: string) =>
        p === "C:\\fake\\npm\\codex.cmd" ||
        p === "C:\\fake\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      readFileSync: () =>
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
    };
    const result = resolveCodexExecutable(undefined, {
      whereFn: () => "C:\\fake\\npm\\codex\r\nC:\\fake\\npm\\codex.cmd\r\n",
      fs: mockFs,
    });
    expect(result.launcher).toBe("node-script");
    expect(result.script).toBe(
      "C:\\fake\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    );
  });

  it("throws clear error when discovered shim is missing on disk", () => {
    mockPlatform("win32");
    const mockFs = {
      existsSync: () => false,
      readFileSync: () => "",
    };
    expect(() =>
      resolveCodexExecutable(undefined, {
        whereFn: () => "C:\\fake\\npm\\codex.cmd\r\n",
        fs: mockFs,
      }),
    ).toThrow("Codex executable not found: C:\\fake\\npm\\codex.cmd");
  });

  it("throws clear error when npm shim entrypoint does not exist", () => {
    mockPlatform("win32");
    const mockFs = {
      existsSync: (p: string) => p === "C:\\fake\\npm\\codex.cmd",
      readFileSync: () =>
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
    };
    expect(() =>
      resolveCodexExecutable(undefined, {
        whereFn: () => "C:\\fake\\npm\\codex.cmd\r\n",
        fs: mockFs,
      }),
    ).toThrow(
      "Invalid Codex npm shim: entrypoint not found for C:\\fake\\npm\\codex.cmd",
    );
  });

  it("does not execute arbitrary shell commands during discovery", () => {
    mockPlatform("win32");
    const spawnSpy = vi.fn();
    const mockFs = {
      existsSync: (p: string) =>
        p === "C:\\fake\\npm\\codex.cmd" ||
        p === "C:\\fake\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      readFileSync: () =>
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
    };
    resolveCodexExecutable(undefined, {
      whereFn: () => "C:\\fake\\npm\\codex.cmd\r\n",
      spawnFn: spawnSpy as SpawnSyncFunction,
      fs: mockFs,
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("prefers native .exe when both .exe and .cmd exist", () => {
    mockPlatform("win32");
    const result = resolveCodexExecutable(
      undefined,
      () => "C:\\fake\\npm\\codex.cmd\r\nC:\\tools\\codex.exe\r\n",
    );
    expect(result).toEqual({
      binary: "C:\\tools\\codex.exe",
      launcher: "direct",
    });
  });

  it("prefers native .exe when .exe appears before .cmd", () => {
    mockPlatform("win32");
    const result = resolveCodexExecutable(
      undefined,
      () => "C:\\tools\\codex.exe\r\nC:\\fake\\npm\\codex.cmd\r\n",
    );
    expect(result).toEqual({
      binary: "C:\\tools\\codex.exe",
      launcher: "direct",
    });
  });

  it("throws when Windows command discovery finds nothing", () => {
    mockPlatform("win32");
    expect(() => resolveCodexExecutable(undefined, () => "")).toThrow(
      "Codex executable not found",
    );
  });

  it("throws when Windows command discovery fails or throws", () => {
    mockPlatform("win32");
    expect(() =>
      resolveCodexExecutable(undefined, () => {
        throw new Error("where.exe failed");
      }),
    ).toThrow("Codex executable not found");
  });

  it("throws when Windows discovery only finds unsupported extensions like .ps1", () => {
    mockPlatform("win32");
    expect(() =>
      resolveCodexExecutable(
        undefined,
        () => "C:\\fake\\npm\\codex.ps1\r\nC:\\fake\\npm\\codex\r\n",
      ),
    ).toThrow("Codex executable not found");
  });

  it("throws when Codex is missing on Unix", () => {
    mockPlatform("linux");
    mockPath("/nonexistent");
    expect(() =>
      resolveCodexExecutable(undefined, createMockSpawn([])),
    ).toThrow("Codex executable not found");
  });

  it("supports explicit binaries and explicit Windows shims", () => {
    mockPlatform("linux");
    expect(
      resolveCodexExecutable("/custom/codex", createMockSpawn(["codex"])),
    ).toEqual({ binary: "/custom/codex", launcher: "direct" });

    mockPlatform("win32");
    const mockFs = {
      existsSync: (p: string) =>
        p === "C:\\custom\\codex.cmd" ||
        p === "C:\\custom\\node_modules\\@openai\\codex\\bin\\codex.js",
      readFileSync: () =>
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
    };
    expect(
      resolveCodexExecutable("C:\\custom\\codex.cmd", {
        spawnFn: createMockSpawn(["codex.cmd"]),
        fs: mockFs,
      }),
    ).toEqual({
      binary: "C:\\custom\\codex.cmd",
      launcher: "node-script",
      nodeBinary: "node",
      script: "C:\\custom\\node_modules\\@openai\\codex\\bin\\codex.js",
    });
  });

  it("supports explicit binaries without custom spawn function", () => {
    mockPlatform("linux");
    expect(resolveCodexExecutable("/custom/codex")).toEqual({
      binary: "/custom/codex",
      launcher: "direct",
    });

    mockPlatform("win32");
    const mockFs = {
      existsSync: (p: string) =>
        p === "C:\\custom\\codex.cmd" ||
        p === "C:\\custom\\node_modules\\@openai\\codex\\bin\\codex.js" ||
        p === "C:\\custom\\codex.exe" ||
        p === "C:\\custom\\codex.bat",
      readFileSync: (p: string) =>
        p === "C:\\custom\\codex.cmd"
          ? `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`
          : `@ECHO off\r\necho custom batch\r\n`,
    };
    expect(
      resolveCodexExecutable("C:\\custom\\codex.cmd", { fs: mockFs }),
    ).toEqual({
      binary: "C:\\custom\\codex.cmd",
      launcher: "node-script",
      nodeBinary: "node",
      script: "C:\\custom\\node_modules\\@openai\\codex\\bin\\codex.js",
    });

    expect(
      resolveCodexExecutable("C:\\custom\\codex.exe", { fs: mockFs }),
    ).toEqual({
      binary: "C:\\custom\\codex.exe",
      launcher: "direct",
    });

    expect(
      resolveCodexExecutable("C:\\custom\\codex.bat", { fs: mockFs }),
    ).toEqual({
      binary: "C:\\custom\\codex.bat",
      launcher: "windows-command-shim",
    });
  });

  it("throws when explicit binary is not found", () => {
    mockPlatform("linux");
    expect(() =>
      resolveCodexExecutable("/custom/missing", createMockSpawn([])),
    ).toThrow("Codex executable not found: /custom/missing");
  });

  it("returns the platform default binary name", () => {
    mockPlatform("win32");
    expect(getCodexBinaryName()).toBe("codex.cmd");
    mockPlatform("darwin");
    expect(getCodexBinaryName()).toBe("codex");
  });
});

describe("Windows command-line quoting", () => {
  it("keeps a shell-sensitive prompt inside one quoted argument", () => {
    const prompt = 'Fix this: "a && b", $(echo bad), & whoami, | test';
    const command = buildWindowsCommandLine("C:\\npm\\codex.cmd", [prompt]);
    expect(command).toContain(
      '"Fix this: ^"a ^&^& b^", $(echo bad), ^& whoami, ^| test"',
    );
    expect(command.match(/\^&/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
