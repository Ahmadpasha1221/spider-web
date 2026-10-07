import { describe, expect, it } from "vitest";
import { normalizeSafeWorkspacePath } from "../../src/adapters/codex/codex-paths.js";

describe("codex-paths: normalizeSafeWorkspacePath", () => {
  const cwd =
    process.platform === "win32" ? "C:\\work\\project" : "/work/project";

  it("normalizes clean relative paths", () => {
    const result = normalizeSafeWorkspacePath("calculator.py", cwd);
    expect(result).toEqual({ ok: true, path: "calculator.py" });
  });

  it("normalizes relative paths with subdirectories and leading ./", () => {
    const result = normalizeSafeWorkspacePath("./src/calculator.py", cwd);
    expect(result).toEqual({ ok: true, path: "src/calculator.py" });
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const result = normalizeSafeWorkspacePath("src\\calculator.py", cwd);
    expect(result).toEqual({ ok: true, path: "src/calculator.py" });
  });

  it("resolves absolute paths inside the workspace to relative POSIX paths", () => {
    const inside =
      process.platform === "win32"
        ? "C:\\work\\project\\src\\calculator.py"
        : "/work/project/src/calculator.py";
    const result = normalizeSafeWorkspacePath(inside, cwd);
    expect(result).toEqual({ ok: true, path: "src/calculator.py" });
  });

  it("rejects path traversal escaping workspace via ..", () => {
    const result1 = normalizeSafeWorkspacePath("..\\outside.txt", cwd);
    expect(result1.ok).toBe(false);

    const result2 = normalizeSafeWorkspacePath("../../outside.txt", cwd);
    expect(result2.ok).toBe(false);

    const result3 = normalizeSafeWorkspacePath("src/../../outside.txt", cwd);
    expect(result3.ok).toBe(false);
  });

  it("rejects absolute paths outside the workspace", () => {
    const outside =
      process.platform === "win32"
        ? "C:\\Windows\\System32\\cmd.exe"
        : "/etc/passwd";
    const result = normalizeSafeWorkspacePath(outside, cwd);
    expect(result.ok).toBe(false);
  });

  it("rejects empty or whitespace-only paths", () => {
    expect(normalizeSafeWorkspacePath("", cwd).ok).toBe(false);
    expect(normalizeSafeWorkspacePath("   ", cwd).ok).toBe(false);
  });

  it("rejects paths that resolve to the workspace root itself", () => {
    expect(normalizeSafeWorkspacePath(".", cwd).ok).toBe(false);
  });
});
