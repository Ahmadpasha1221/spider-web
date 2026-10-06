import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_WRITE_MODE = 0o600;

/**
 * Atomically replace a file by writing a sibling temporary file, syncing it,
 * and renaming it over the target.
 *
 * A failed write leaves the previous target untouched and removes the
 * temporary file, so callers never observe a partially written target. The
 * rename is atomic against process crashes. Durability against power loss is
 * not guaranteed because the parent directory is not fsynced; directory
 * fsync is not portable to Windows.
 *
 * On Windows, concurrent renames over the same target can transiently fail
 * with a sharing violation (EPERM/EACCES/EBUSY) while the loser of the race
 * has the target open. The rename is retried with a short backoff so that
 * concurrent last-write-wins updates complete instead of failing the caller.
 */
const RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const;
const RENAME_RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);

async function renameWithRetry(
  temporaryPath: string,
  target: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, target);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (
        code === undefined ||
        !RENAME_RETRYABLE_CODES.has(code) ||
        delay === undefined
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function writeFileAtomically(
  target: string,
  data: Uint8Array | string,
  options: { readonly mode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? DEFAULT_WRITE_MODE;
  const directory = dirname(target);
  const temporaryPath = join(
    directory,
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      mode,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporaryPath, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
