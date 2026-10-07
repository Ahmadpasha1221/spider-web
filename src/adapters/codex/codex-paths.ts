import { win32 as win32Path, posix as posixPath } from "node:path";

export interface SafePathSuccess {
  readonly ok: true;
  readonly path: string;
}

export interface SafePathFailure {
  readonly ok: false;
  readonly error: string;
}

export type SafePathResult = SafePathSuccess | SafePathFailure;

/**
 * Validates against the Spider schema pattern for relative POSIX file paths:
 * ^(?!/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|/)\.\.(?:/|$)).+$
 */
const VALID_RELATIVE_POSIX =
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

/**
 * Normalizes an untrusted file path into a safe, workspace-relative POSIX path.
 *
 * Requirements:
 * - Reject empty or whitespace-only paths.
 * - Normalize Windows separators (`\`) to POSIX (`/`).
 * - Strip leading `./`.
 * - If path is absolute:
 *     - If inside `cwd`, resolve to relative POSIX path.
 *     - If outside `cwd`, reject as workspace traversal.
 * - If path is relative:
 *     - Resolve against `cwd` and verify it stays inside `cwd`.
 *     - Reject paths that escape via `..` or traverse outside `cwd`.
 *     - Reject paths resolving to the workspace root itself (`.` / empty).
 * - Ensure the resulting path matches the Spider session schema.
 */
export function normalizeSafeWorkspacePath(
  rawPath: string,
  cwd: string,
): SafePathResult {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "File path cannot be empty" };
  }

  // Reject paths that directly attempt traversal or invalid chars before path API normalization
  if (trimmed.includes("\0")) {
    return { ok: false, error: "File path contains null bytes" };
  }

  const looksWindows =
    win32Path.isAbsolute(trimmed) ||
    win32Path.isAbsolute(cwd) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\\\\/.test(trimmed);

  const pathApi = looksWindows ? win32Path : posixPath;
  const resolvedCwd = pathApi.resolve(cwd);

  let absoluteCandidate: string;
  if (pathApi.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    absoluteCandidate = pathApi.normalize(trimmed);
  } else {
    // Relative path: check for simple obvious escapes first
    const uniformSlashes = trimmed.replace(/\\/g, "/");
    const segments = uniformSlashes.split("/");
    let depth = 0;
    for (const segment of segments) {
      if (segment === "..") {
        depth--;
        if (depth < 0) {
          return {
            ok: false,
            error: `File path escapes workspace directory: ${rawPath}`,
          };
        }
      } else if (segment.length > 0 && segment !== ".") {
        depth++;
      }
    }
    absoluteCandidate = pathApi.resolve(resolvedCwd, trimmed);
  }

  // Calculate relative path from resolvedCwd
  const rel = pathApi.relative(resolvedCwd, absoluteCandidate);

  // Check if it escapes or refers to root
  if (
    rel.length === 0 ||
    rel === "." ||
    rel === ".." ||
    rel.startsWith(`..${pathApi.sep}`) ||
    rel.startsWith(`..${posixPath.sep}`) ||
    pathApi.isAbsolute(rel)
  ) {
    return {
      ok: false,
      error: `File path escapes workspace directory: ${rawPath}`,
    };
  }

  // Convert all separators to forward slashes
  let posixNormalized = rel.split(pathApi.sep).join("/");
  if (posixNormalized.startsWith("./")) {
    posixNormalized = posixNormalized.slice(2);
  }

  // Final check against Spider schema contract
  if (!VALID_RELATIVE_POSIX.test(posixNormalized)) {
    return {
      ok: false,
      error: `File path does not conform to valid workspace-relative format: ${rawPath}`,
    };
  }

  return { ok: true, path: posixNormalized };
}
