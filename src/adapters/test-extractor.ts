export interface TestCommandDetection {
  readonly isTestCommand: boolean;
  readonly framework: string | null;
}

export interface ExtractedSuiteResult {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped" | "running" | "unknown";
}

/**
 * Strips common shell wrappers (powershell, pwsh, cmd, bash, sh) and extracts
 * discrete sub-commands separated by `;`, `&&`, or `||`.
 */
function extractCommandSegments(rawCommandLine: string): string[] {
  let cmd = rawCommandLine.trim();

  // Strip PowerShell/pwsh wrapper: pwsh.exe -Command "..." or powershell -Command '...'
  const psMatch = cmd.match(
    /(?:^|[\s"'\\/])(?:pwsh|powershell)(?:\.exe)?["']?\s+(?:-[a-zA-Z0-9]+\s+)*-(?:c|command)\s+(".*"|'.*'|.+)$/i,
  );
  if (psMatch && psMatch[1]) {
    let inner = psMatch[1].trim();
    if (
      (inner.startsWith('"') && inner.endsWith('"')) ||
      (inner.startsWith("'") && inner.endsWith("'"))
    ) {
      inner = inner.slice(1, -1);
    }
    cmd = inner.trim();
  } else {
    // Strip cmd.exe wrapper: cmd.exe /c "..." or cmd /c ...
    const cmdMatch = cmd.match(
      /(?:^|[\s"'\\/])cmd(?:\.exe)?["']?\s+(?:\/[a-zA-Z0-9]+\s+)*\/c\s+(".*"|.+)$/i,
    );
    if (cmdMatch && cmdMatch[1]) {
      let inner = cmdMatch[1].trim();
      if (inner.startsWith('"') && inner.endsWith('"')) {
        inner = inner.slice(1, -1);
      }
      cmd = inner.trim();
    } else {
      // Strip sh/bash wrapper: bash -c "..."
      const bashMatch = cmd.match(
        /(?:^|[\s"'\\/])(?:bash|sh|zsh)["']?\s+(?:-[a-zA-Z0-9]+\s+)*-c\s+(".*"|'.*'|.+)$/i,
      );
      if (bashMatch && bashMatch[1]) {
        let inner = bashMatch[1].trim();
        if (
          (inner.startsWith('"') && inner.endsWith('"')) ||
          (inner.startsWith("'") && inner.endsWith("'"))
        ) {
          inner = inner.slice(1, -1);
        }
        cmd = inner.trim();
      }
    }
  }

  // Split compound commands on `;`, `&&`, or `||` (not inside quotes)
  const segments: string[] = [];
  const parts = cmd.split(/(?:;|&&|\|\|)/g);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }

  return segments.length > 0 ? segments : [rawCommandLine.trim()];
}

/**
 * Classifies whether a single command segment matches a known test framework.
 */
function classifySingleSegment(segment: string): string | null {
  const trimmed = segment.trim();

  // Python unittest:
  // e.g., "python -m unittest discover -v", "py -m unittest -v", "python3 -m unittest"
  if (
    /(?:^|[\\/])(?:python|python3|py)(?:\.exe)?\s+(?:-[a-zA-Z0-9]+\s+)*-m\s+unittest(?:\s+|$)/i.test(
      trimmed,
    )
  ) {
    return "unittest";
  }

  // Pytest:
  // e.g., "pytest -q", "py -m pytest", "python3 -m pytest"
  if (
    /(?:^|[\\/])(?:python|python3|py)(?:\.exe)?\s+(?:-[a-zA-Z0-9]+\s+)*-m\s+pytest(?:\s+|$)/i.test(
      trimmed,
    ) ||
    /(?:^|[\\/])pytest(?:\.exe)?(?:\s+|$)/i.test(trimmed)
  ) {
    return "pytest";
  }

  // Node / npm / yarn / pnpm test runners:
  if (/^npm\s+(?:run\s+)?test(?:\s+|$)/i.test(trimmed)) {
    return "npm test";
  }
  if (/^pnpm\s+(?:run\s+)?test(?:\s+|$)/i.test(trimmed)) {
    return "pnpm test";
  }
  if (/^yarn\s+test(?:\s+|$)/i.test(trimmed)) {
    return "yarn test";
  }
  if (
    /^npx\s+(?:vitest|jest)(?:\s+|$)/i.test(trimmed) ||
    /(?:^|[\\/])(?:vitest|jest)(?:\.cmd|\.exe)?(?:\s+|$)/i.test(trimmed)
  ) {
    return "vitest";
  }

  // Cargo test:
  if (/(?:^|[\\/])cargo(?:\.exe)?\s+test(?:\s+|$)/i.test(trimmed)) {
    return "cargo test";
  }

  // Go test:
  if (/(?:^|[\\/])go(?:\.exe)?\s+test(?:\s+|$)/i.test(trimmed)) {
    return "go test";
  }

  return null;
}

/**
 * Detects whether a command line executes a known test runner.
 */
export function detectTestCommand(commandLine: string): TestCommandDetection {
  const segments = extractCommandSegments(commandLine);
  for (const segment of segments) {
    const framework = classifySingleSegment(segment);
    if (framework !== null) {
      return { isTestCommand: true, framework };
    }
  }
  return { isTestCommand: false, framework: null };
}

/**
 * Extracts structured test suite evidence from command execution evidence.
 *
 * Rules:
 * - Only parses commands confidently identified as test commands.
 * - Requires clear evidence in command output / exit code.
 * - Does NOT fabricate test results or invent counts.
 * - Returns null when output is ambiguous or unparseable.
 */
export function extractTestResult(options: {
  command: string;
  output: string;
  exitCode: number | null;
}): ExtractedSuiteResult | null {
  const { command, output, exitCode } = options;
  const detection = detectTestCommand(command);
  if (!detection.isTestCommand || detection.framework === null) {
    return null;
  }

  const { framework } = detection;
  const normalizedOutput = output.replace(/\r\n/g, "\n");

  switch (framework) {
    case "unittest": {
      // Look for standard unittest patterns:
      // "Ran X tests in ...s\n\nOK"
      // or "Ran X tests in ...s\n\nFAILED (failures=Y, errors=Z)"
      const ranMatch = /Ran\s+(\d+)\s+tests?\s+in\s+[0-9.]+s/i.test(
        normalizedOutput,
      );
      const okMatch =
        /(?:^|\n)OK(?:\s*\(.*?\))?\s*$/m.test(normalizedOutput) ||
        normalizedOutput.trim().endsWith("OK");
      const failedMatch =
        /FAILED\s*\((?:failures=\d+|errors=\d+)/i.test(normalizedOutput) ||
        /(?:^|\n)(?:FAIL|ERROR):/m.test(normalizedOutput);

      if (ranMatch && okMatch && exitCode === 0) {
        return { name: "unittest", status: "passed" };
      }
      if (failedMatch || (ranMatch && exitCode !== 0 && exitCode !== null)) {
        return { name: "unittest", status: "failed" };
      }
      if (ranMatch && exitCode === 0) {
        return { name: "unittest", status: "passed" };
      }
      // If exit code is failed and command is unittest:
      if (exitCode !== null && exitCode !== 0) {
        return { name: "unittest", status: "failed" };
      }
      return null;
    }

    case "pytest": {
      // Look for pytest summary line:
      // e.g. "=== 9 passed in 0.05s ===" or "=== 1 failed, 8 passed in 0.12s ==="
      const passedSummary =
        /=+.*?\b(\d+)\s+passed\b.*?=+/i.test(normalizedOutput) &&
        !/=+\s+.*?\b\d+\s+failed\b.*?=+/i.test(normalizedOutput);
      const failedSummary = /=+.*?\b\d+\s+failed\b.*?=+/i.test(
        normalizedOutput,
      );

      if (passedSummary && exitCode === 0) {
        return { name: "pytest", status: "passed" };
      }
      if (failedSummary || (exitCode !== null && exitCode !== 0)) {
        return { name: "pytest", status: "failed" };
      }
      return null;
    }

    case "cargo test": {
      if (
        /test result:\s*ok\.\s*\d+\s+passed/i.test(normalizedOutput) &&
        exitCode === 0
      ) {
        return { name: "cargo test", status: "passed" };
      }
      if (
        /test result:\s*FAILED\./i.test(normalizedOutput) ||
        (exitCode !== null && exitCode !== 0)
      ) {
        return { name: "cargo test", status: "failed" };
      }
      return null;
    }

    case "go test": {
      if (/(?:^|\n)PASS(?:\s|$)/m.test(normalizedOutput) && exitCode === 0) {
        return { name: "go test", status: "passed" };
      }
      if (
        /(?:^|\n)FAIL(?:\s|$)/m.test(normalizedOutput) ||
        (exitCode !== null && exitCode !== 0)
      ) {
        return { name: "go test", status: "failed" };
      }
      return null;
    }

    case "npm test":
    case "pnpm test":
    case "yarn test":
    case "vitest": {
      const vitestPassed =
        /\b\d+\s+passed\b/i.test(normalizedOutput) &&
        !/\b\d+\s+failed\b/i.test(normalizedOutput);
      const jestPassed =
        /Tests:\s+\d+\s+passed/i.test(normalizedOutput) &&
        !/\d+\s+failed/i.test(normalizedOutput);

      if ((vitestPassed || jestPassed) && exitCode === 0) {
        return { name: framework, status: "passed" };
      }
      if (
        /\b(?:FAIL|FAILED)\b/i.test(normalizedOutput) ||
        (exitCode !== null && exitCode !== 0)
      ) {
        return { name: framework, status: "failed" };
      }
      return null;
    }

    default:
      return null;
  }
}
