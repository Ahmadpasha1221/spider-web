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

  it("selects a Windows npm command shim with a shell launcher", () => {
    mockPlatform("win32");
    const result = resolveCodexExecutable(
      undefined,
      () => "C:\\fake\\npm\\codex.cmd\r\n",
    );
    expect(result).toEqual({
      binary: "C:\\fake\\npm\\codex.cmd",
      launcher: "windows-command-shim",
    });
  });

  it("selects a Windows npm command shim when preceded by extensionless script", () => {
    mockPlatform("win32");
    const result = resolveCodexExecutable(
      undefined,
      () => "C:\\fake\\npm\\codex\r\nC:\\fake\\npm\\codex.cmd\r\n",
    );
    expect(result).toEqual({
      binary: "C:\\fake\\npm\\codex.cmd",
      launcher: "windows-command-shim",
    });
  });

  it("supports Windows bat shims", () => {
    mockPlatform("win32");
    const result = resolveCodexExecutable(
      undefined,
      () => "C:\\fake\\npm\\codex.bat\r\n",
    );
    expect(result.launcher).toBe("windows-command-shim");
    expect(result.binary).toBe("C:\\fake\\npm\\codex.bat");
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
    expect(
      resolveCodexExecutable(
        "C:\\custom\\codex.cmd",
        createMockSpawn(["codex.cmd"]),
      ),
    ).toEqual({
      binary: "C:\\custom\\codex.cmd",
      launcher: "windows-command-shim",
    });
  });

  it("supports explicit binaries without custom spawn function", () => {
    mockPlatform("linux");
    expect(resolveCodexExecutable("/custom/codex")).toEqual({
      binary: "/custom/codex",
      launcher: "direct",
    });

    mockPlatform("win32");
    expect(resolveCodexExecutable("C:\\custom\\codex.cmd")).toEqual({
      binary: "C:\\custom\\codex.cmd",
      launcher: "windows-command-shim",
    });

    expect(resolveCodexExecutable("C:\\custom\\codex.exe")).toEqual({
      binary: "C:\\custom\\codex.exe",
      launcher: "direct",
    });

    expect(resolveCodexExecutable("C:\\custom\\codex.bat")).toEqual({
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
