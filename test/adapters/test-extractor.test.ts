import { describe, expect, it } from "vitest";
import {
  detectTestCommand,
  extractTestResult,
} from "../../src/adapters/test-extractor.js";

describe("test-extractor: detectTestCommand", () => {
  it("detects python unittest commands across variations", () => {
    expect(detectTestCommand("python -m unittest discover -v")).toEqual({
      isTestCommand: true,
      framework: "unittest",
    });
    expect(detectTestCommand("python3 -m unittest")).toEqual({
      isTestCommand: true,
      framework: "unittest",
    });
    expect(detectTestCommand("py -m unittest -v")).toEqual({
      isTestCommand: true,
      framework: "unittest",
    });
    expect(detectTestCommand("py.exe -m unittest test_calculator.py")).toEqual({
      isTestCommand: true,
      framework: "unittest",
    });
  });

  it("detects pytest commands across variations", () => {
    expect(detectTestCommand("pytest")).toEqual({
      isTestCommand: true,
      framework: "pytest",
    });
    expect(detectTestCommand("pytest -q")).toEqual({
      isTestCommand: true,
      framework: "pytest",
    });
    expect(detectTestCommand("python -m pytest tests/")).toEqual({
      isTestCommand: true,
      framework: "pytest",
    });
    expect(detectTestCommand("py -m pytest")).toEqual({
      isTestCommand: true,
      framework: "pytest",
    });
  });

  it("detects npm / pnpm / yarn / vitest / jest runners", () => {
    expect(detectTestCommand("npm test")).toEqual({
      isTestCommand: true,
      framework: "npm test",
    });
    expect(detectTestCommand("npm run test")).toEqual({
      isTestCommand: true,
      framework: "npm test",
    });
    expect(detectTestCommand("pnpm test")).toEqual({
      isTestCommand: true,
      framework: "pnpm test",
    });
    expect(detectTestCommand("yarn test")).toEqual({
      isTestCommand: true,
      framework: "yarn test",
    });
    expect(detectTestCommand("npx vitest run")).toEqual({
      isTestCommand: true,
      framework: "vitest",
    });
  });

  it("detects cargo test and go test", () => {
    expect(detectTestCommand("cargo test")).toEqual({
      isTestCommand: true,
      framework: "cargo test",
    });
    expect(detectTestCommand("cargo.exe test --quiet")).toEqual({
      isTestCommand: true,
      framework: "cargo test",
    });
    expect(detectTestCommand("go test ./...")).toEqual({
      isTestCommand: true,
      framework: "go test",
    });
  });

  it("unwraps PowerShell / pwsh command lines", () => {
    const psCmd =
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "py -m unittest discover -v; Write-Output \'--- compile ---\'"';
    expect(detectTestCommand(psCmd)).toEqual({
      isTestCommand: true,
      framework: "unittest",
    });
  });

  it("unwraps cmd.exe and bash command lines", () => {
    expect(detectTestCommand('cmd.exe /c "pytest && echo done"')).toEqual({
      isTestCommand: true,
      framework: "pytest",
    });
    expect(detectTestCommand('bash -c "python -m unittest"')).toEqual({
      isTestCommand: true,
      framework: "unittest",
    });
  });

  it("does not classify non-test commands as tests", () => {
    expect(detectTestCommand("python calculator.py")).toEqual({
      isTestCommand: false,
      framework: null,
    });
    expect(detectTestCommand("py -m compileall calculator.py")).toEqual({
      isTestCommand: false,
      framework: null,
    });
    expect(detectTestCommand("git log --oneline -5")).toEqual({
      isTestCommand: false,
      framework: null,
    });
    expect(detectTestCommand("git status --short")).toEqual({
      isTestCommand: false,
      framework: null,
    });
    expect(detectTestCommand("rg --files")).toEqual({
      isTestCommand: false,
      framework: null,
    });
    expect(detectTestCommand("Get-Content test_calculator.py")).toEqual({
      isTestCommand: false,
      framework: null,
    });
  });
});

describe("test-extractor: extractTestResult", () => {
  it("extracts passing python unittest result", () => {
    const output = "Ran 3 tests in 0.001s\n\nOK";
    const result = extractTestResult({
      command: "python -m unittest discover -v",
      output,
      exitCode: 0,
    });
    expect(result).toEqual({
      name: "unittest",
      status: "passed",
    });
  });

  it("extracts failing python unittest result with non-zero exit code", () => {
    const output =
      "FAIL: test_add (test_calc.TestCalc)\nRan 3 tests in 0.002s\n\nFAILED (failures=1)";
    const result = extractTestResult({
      command: "py -m unittest discover -v",
      output,
      exitCode: 1,
    });
    expect(result).toEqual({
      name: "unittest",
      status: "failed",
    });
  });

  it("extracts passing pytest result", () => {
    const output =
      "============================= 9 passed in 0.04s =============================";
    const result = extractTestResult({
      command: "pytest -q",
      output,
      exitCode: 0,
    });
    expect(result).toEqual({
      name: "pytest",
      status: "passed",
    });
  });

  it("extracts failing pytest result", () => {
    const output =
      "======================== 1 failed, 8 passed in 0.12s ========================";
    const result = extractTestResult({
      command: "pytest",
      output,
      exitCode: 1,
    });
    expect(result).toEqual({
      name: "pytest",
      status: "failed",
    });
  });

  it("returns null for non-test commands even if output contains OK", () => {
    const result = extractTestResult({
      command: "python calculator.py",
      output: "OK",
      exitCode: 0,
    });
    expect(result).toBeNull();
  });

  it("returns null for ambiguous test output when exit code is 0 without summary evidence", () => {
    const result = extractTestResult({
      command: "python -m unittest discover -v",
      output: "some unformatted text without test count or summary",
      exitCode: 0,
    });
    expect(result).toBeNull();
  });
});
