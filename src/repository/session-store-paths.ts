import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { SessionRepositoryError } from "./session-repository.js";

export interface SessionStorePaths {
  readonly dataDirectory: string;
  readonly sessionsDirectory: string;
  readonly indexFile: string;
}

/**
 * Platform-neutral description of the execution environment. Injectable so
 * the data-directory resolution can be tested for every platform without
 * running on that platform.
 */
export interface PathResolutionContext {
  readonly platform?: string;
  readonly homeDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Session IDs are `spw_` plus a lowercase UUID v4, exactly matching the
 * Spider Session schema. Because IDs never contain separators, dots, or
 * drive letters, a validated ID is always a single safe path segment.
 */
const SESSION_ID_PATTERN =
  /^spw_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Resolve the Spider Web local data directory.
 *
 * Follows the Phase 0 local-storage decision: Linux uses
 * `$XDG_DATA_HOME/spider-web` (falling back to `~/.local/share/spider-web`,
 * ignoring a relative `XDG_DATA_HOME` per the XDG specification), macOS uses
 * `~/Library/Application Support/spider-web`, and Windows uses
 * `%LOCALAPPDATA%\Spider Web` with an OS home-directory fallback when the
 * variable is absent. `SPIDER_WEB_DATA_DIR` overrides the platform default,
 * which is primarily useful for tests and isolated environments.
 */
export function resolveSpiderDataDirectory(
  context: PathResolutionContext = {},
): string {
  const platform = context.platform ?? process.platform;
  const homeDirectory = context.homeDirectory ?? homedir();
  const env = context.env ?? process.env;

  const override = env.SPIDER_WEB_DATA_DIR;
  if (override && override.length > 0) return resolve(override);

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData && localAppData.length > 0)
      return join(localAppData, "Spider Web");
    return join(homeDirectory, "AppData", "Local", "Spider Web");
  }
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "spider-web");
  }
  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome && isAbsolute(xdgDataHome))
    return join(xdgDataHome, "spider-web");
  return join(homeDirectory, ".local", "share", "spider-web");
}

export function createSessionStorePaths(
  dataDirectory: string,
): SessionStorePaths {
  const root = resolve(dataDirectory);
  return {
    dataDirectory: root,
    sessionsDirectory: join(root, "sessions"),
    indexFile: join(root, "index.json"),
  };
}

function assertWithinSessionsDirectory(
  sessionsDirectory: string,
  candidate: string,
  sessionId: string,
): void {
  const parent = resolve(sessionsDirectory);
  const resolved = resolve(candidate);
  if (resolved !== parent && !resolved.startsWith(parent + sep)) {
    throw new SessionRepositoryError(
      `Session ID escapes the session store: ${sessionId}`,
    );
  }
}

/** Directory holding one session's files, e.g. `<data>/sessions/<id>/`. */
export function sessionDirectory(
  paths: SessionStorePaths,
  sessionId: string,
): string {
  if (!isValidSessionId(sessionId))
    throw new SessionRepositoryError(`Invalid session ID: ${sessionId}`);
  const directory = join(paths.sessionsDirectory, sessionId);
  assertWithinSessionsDirectory(paths.sessionsDirectory, directory, sessionId);
  return directory;
}

/** Canonical stored session file, e.g. `<data>/sessions/<id>/session.json`. */
export function sessionFile(
  paths: SessionStorePaths,
  sessionId: string,
): string {
  return join(sessionDirectory(paths, sessionId), "session.json");
}
