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
 */
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
    await rename(temporaryPath, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
