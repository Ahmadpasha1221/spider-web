import { open, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, parseStrictJson } from "./json.js";
import { validateSession, type SpiderSession } from "./session.js";

export function serializeSession(session: SpiderSession): string {
  validateSession(session);
  return canonicalJson(session);
}

export function parseSessionJson(text: string): SpiderSession {
  const value = parseStrictJson(text);
  validateSession(value);
  return value;
}

export class SessionFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionFileError";
  }
}

/** Write a canonical Spider Session JSON file without overwriting an existing destination. */
export async function writeSessionJsonFile(
  destination: string,
  session: SpiderSession,
): Promise<void> {
  const absolutePath = resolve(destination);
  const text = serializeSession(session);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle) await unlink(absolutePath).catch(() => undefined);
    throw new SessionFileError(
      `Could not write Spider Session at ${absolutePath}`,
      { cause: error },
    );
  }
  await handle.close();
}
