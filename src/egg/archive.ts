import { open, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { crc32 } from "node:zlib";
import { TextDecoder, TextEncoder } from "node:util";
import yazl from "yazl";
import * as yauzl from "yauzl";
import {
  createEggPayloads,
  createManifest,
  MAX_EGG_ENTRIES,
  MAX_EGG_EXPANDED_BYTES,
  MAX_MANIFEST_BYTES,
  parseManifestJson,
  serializeManifest,
  verifyPayloads,
  type EggPayload,
  type SelectedArtifact,
  type SpiderEggManifest,
} from "../protocol/manifest.js";
import { renderHandoff } from "../core/handoff.js";
import { parseSessionJson } from "../core/session-serialization.js";
import type { SpiderSession } from "../core/session.js";

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);
const FIXED_DOS_DATE = 0x0021;
const ZIP_UTF8_FLAG = 1 << 11;
const ZIP_UNIX_VERSION_MADE_BY = (3 << 8) | 63;
const ZIP_REGULAR_FILE_MODE = 0o100644;
const MAX_ZIP_OVERHEAD = 16 * 1024 * 1024;
export const MAX_EGG_ARCHIVE_BYTES = MAX_EGG_EXPANDED_BYTES + MAX_ZIP_OVERHEAD;

export class SpiderEggError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpiderEggError";
  }
}

export interface SpiderEggDocument {
  readonly manifest: SpiderEggManifest;
  readonly session: SpiderSession;
  readonly handoff: string;
  readonly artifacts: readonly EggPayload[];
}

export interface SpiderEggCreateOptions {
  readonly selectedArtifacts?: readonly SelectedArtifact[];
}

function fail(message: string): never {
  throw new SpiderEggError(message);
}

function readStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Buffer> {
  return zipFile.openReadStreamPromise(entry).then(async (stream) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > entry.uncompressedSize)
        fail(
          `Entry expanded beyond its declared size: ${entry.fileNameRaw.toString("hex")}`,
        );
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  });
}

function decodeName(entry: yauzl.Entry): string {
  try {
    const name = strictUtf8.decode(entry.fileNameRaw);
    if (!Buffer.from(utf8.encode(name)).equals(entry.fileNameRaw))
      fail("ZIP entry path is not canonical UTF-8");
    return name;
  } catch (error) {
    if (error instanceof SpiderEggError) throw error;
    return fail("ZIP entry path is not valid UTF-8");
  }
}

function validateZipEntryMetadata(entry: yauzl.Entry, name: string): void {
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  ) {
    fail(`Unsafe ZIP entry path: ${name || "<empty>"}`);
  }
  if (
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`Unsafe ZIP entry path: ${name}`);
  }
  if (
    (entry.generalPurposeBitFlag & ZIP_UTF8_FLAG) === 0 ||
    entry.generalPurposeBitFlag !== ZIP_UTF8_FLAG
  ) {
    fail(`Unsupported ZIP flags for entry: ${name}`);
  }
  if (
    entry.compressionMethod !== 0 ||
    entry.compressedSize !== entry.uncompressedSize
  ) {
    fail(`Only uncompressed ZIP entries are supported: ${name}`);
  }
  if (
    entry.uncompressedSize > 0xffff_fffe ||
    entry.compressedSize > 0xffff_fffe
  ) {
    fail(`ZIP64 entry sizes are not supported: ${name}`);
  }
  if (
    entry.extraFieldRaw.byteLength !== 0 ||
    entry.fileCommentRaw.byteLength !== 0
  ) {
    fail(`ZIP extra fields and entry comments are not supported: ${name}`);
  }
  if (entry.lastModFileDate !== FIXED_DOS_DATE || entry.lastModFileTime !== 0) {
    fail(`Unexpected ZIP timestamp for entry: ${name}`);
  }
  if (entry.versionMadeBy !== ZIP_UNIX_VERSION_MADE_BY) {
    fail(`Unexpected ZIP creator version for entry: ${name}`);
  }
  if (entry.versionNeededToExtract !== 20) {
    fail(`Unsupported ZIP version for entry: ${name}`);
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  if ((unixMode & 0o170000) !== 0o100000 || (unixMode & 0o777) !== 0o644) {
    fail(`ZIP entry is not a regular mode-0644 file: ${name}`);
  }
}

function readZipFile(buffer: Buffer): Promise<yauzl.ZipFile> {
  return yauzl.fromBufferPromise(buffer, {
    lazyEntries: true,
    decodeStrings: false,
    validateEntrySizes: true,
    strictFileNames: true,
  });
}

function validateContainerLayout(
  buffer: Buffer,
  entries: readonly yauzl.Entry[],
): void {
  const eocdOffset = buffer.byteLength - 22;
  if (
    buffer.readUInt32LE(0) !== 0x04034b50 ||
    buffer.readUInt32LE(eocdOffset) !== 0x06054b50
  ) {
    fail("ZIP container has a prefix, comment, or trailing data");
  }
  if (
    buffer.readUInt16LE(eocdOffset + 4) !== 0 ||
    buffer.readUInt16LE(eocdOffset + 6) !== 0 ||
    buffer.readUInt16LE(eocdOffset + 8) !== entries.length ||
    buffer.readUInt16LE(eocdOffset + 10) !== entries.length ||
    buffer.readUInt16LE(eocdOffset + 20) !== 0
  ) {
    fail("Multi-disk, ZIP64, or commented ZIP containers are not supported");
  }

  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize !== eocdOffset)
    fail("ZIP central directory layout is invalid");

  let localOffset = 0;
  let expectedCentralSize = 0;
  for (const entry of entries) {
    if (entry.relativeOffsetOfLocalHeader !== localOffset)
      fail("ZIP local entries are not contiguous and ordered");
    localOffset +=
      30 +
      entry.fileNameRaw.byteLength +
      entry.extraFieldRaw.byteLength +
      entry.compressedSize;
    expectedCentralSize +=
      46 +
      entry.fileNameRaw.byteLength +
      entry.extraFieldRaw.byteLength +
      entry.fileCommentRaw.byteLength;
  }
  if (localOffset !== centralOffset || expectedCentralSize !== centralSize) {
    fail("ZIP central and local directory sizes do not match");
  }
}

/** Write a deterministic, uncompressed Spider Egg ZIP archive in memory. */
export async function writeSpiderEgg(
  session: SpiderSession,
  selectedArtifacts: readonly SelectedArtifact[] = [],
): Promise<Buffer> {
  const stableArtifacts = selectedArtifacts.map(({ artifactId, bytes }) => ({
    artifactId,
    bytes: Buffer.from(bytes),
  }));
  const payloads = createEggPayloads(session, stableArtifacts);
  const manifest = createManifest(session, payloads);
  const manifestBytes = utf8.encode(serializeManifest(manifest));
  const entries: EggPayload[] = [
    {
      path: "manifest.json",
      mediaType: "application/json",
      bytes: manifestBytes,
    },
    ...payloads,
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const expandedBytes = entries.reduce(
    (total, entry) => total + entry.bytes.byteLength,
    0,
  );
  if (entries.length > MAX_EGG_ENTRIES)
    fail("Spider Egg exceeds the entry-count limit");
  if (expandedBytes > MAX_EGG_EXPANDED_BYTES)
    fail("Spider Egg exceeds the expanded-size limit");
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES)
    fail("Spider Egg manifest exceeds the size limit");

  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  let zipError: Error | undefined;
  zip.on("error", (error: Error) => {
    zipError = error;
  });
  zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => {
      if (zipError) {
        reject(
          new SpiderEggError("Failed to write Spider Egg archive", {
            cause: zipError,
          }),
        );
        return;
      }
      const archive = Buffer.concat(chunks);
      if (archive.byteLength > MAX_EGG_ARCHIVE_BYTES) {
        reject(
          new SpiderEggError("Spider Egg archive exceeds the maximum ZIP size"),
        );
        return;
      }
      resolve(archive);
    });
    try {
      for (const entry of entries) {
        const stableBuffer = Buffer.from(
          entry.bytes.buffer,
          entry.bytes.byteOffset,
          entry.bytes.byteLength,
        );
        zip.addBuffer(stableBuffer, entry.path, {
          mtime: FIXED_MTIME,
          mode: ZIP_REGULAR_FILE_MODE,
          compress: false,
          forceDosTimestamp: true,
          forceZip64Format: false,
        });
      }
      zip.end({ forceZip64Format: false, comment: "" });
    } catch (error) {
      reject(
        new SpiderEggError("Failed to write Spider Egg archive", {
          cause: error,
        }),
      );
    }
  });
}

/** Create a new local Egg file without overwriting an existing destination. */
export async function writeSpiderEggFile(
  destination: string,
  session: SpiderSession,
  options: SpiderEggCreateOptions = {},
): Promise<void> {
  const absolutePath = resolve(destination);
  const archive = await writeSpiderEgg(
    session,
    options.selectedArtifacts ?? [],
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(archive);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle) await unlink(absolutePath).catch(() => undefined);
    throw new SpiderEggError(`Could not create Spider Egg at ${absolutePath}`, {
      cause: error,
    });
  }
  await handle.close();
}

/** Read a bounded local Egg file. Contents remain in memory and are never extracted. */
export async function readSpiderEggFile(
  source: string,
): Promise<SpiderEggDocument> {
  const absolutePath = resolve(source);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY);
    const metadata = await handle.stat();
    if (!metadata.isFile()) fail("Spider Egg source must be a regular file");
    if (metadata.size > MAX_EGG_ARCHIVE_BYTES)
      fail("Spider Egg archive exceeds the maximum ZIP size");
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_EGG_ARCHIVE_BYTES)
        fail("Spider Egg archive exceeds the maximum ZIP size");
      chunks.push(bytes);
    }
    return await readSpiderEgg(Buffer.concat(chunks, size));
  } catch (error) {
    if (error instanceof SpiderEggError) throw error;
    throw new SpiderEggError(`Could not read Spider Egg at ${absolutePath}`, {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

/** Read and fully validate a Spider Egg without extracting or executing its contents. */
export async function readSpiderEgg(
  input: Uint8Array,
): Promise<SpiderEggDocument> {
  if (input.byteLength > MAX_EGG_ARCHIVE_BYTES)
    fail("Spider Egg archive exceeds the maximum ZIP size");
  if (input.byteLength < 22) fail("Input is too small to be a ZIP archive");
  const zip = await readZipFile(Buffer.from(input));
  if (zip.comment.length !== 0) fail("ZIP archive comments are not supported");
  if (zip.entryCount < 1 || zip.entryCount > MAX_EGG_ENTRIES)
    fail("Spider Egg entry count is invalid");

  const metadata: Array<{ entry: yauzl.Entry; path: string }> = [];
  try {
    for await (const entry of zip.eachEntry()) {
      const path = decodeName(entry);
      validateZipEntryMetadata(entry, path);
      metadata.push({ entry, path });
      if (metadata.length > MAX_EGG_ENTRIES)
        fail("Spider Egg entry count exceeds the limit");
    }
  } catch (error) {
    if (error instanceof SpiderEggError) throw error;
    throw new SpiderEggError("Could not read ZIP central directory", {
      cause: error,
    });
  }

  const paths = metadata.map(({ path }) => path);
  validateContainerLayout(
    Buffer.from(input),
    metadata.map(({ entry }) => entry),
  );
  if (new Set(paths).size !== paths.length)
    fail("Spider Egg contains duplicate ZIP entry paths");
  const sortedPaths = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paths.some((path, index) => path !== sortedPaths[index]))
    fail("ZIP entries are not sorted by path");
  if (
    !paths.includes("manifest.json") ||
    !paths.includes("session.json") ||
    !paths.includes("handoff.md")
  ) {
    fail("Spider Egg is missing required entries");
  }

  let expandedBytes = 0;
  for (const { entry, path } of metadata) {
    expandedBytes += entry.uncompressedSize;
    if (expandedBytes > MAX_EGG_EXPANDED_BYTES)
      fail("Spider Egg exceeds the expanded-size limit");
    if (
      path === "manifest.json" &&
      entry.uncompressedSize > MAX_MANIFEST_BYTES
    ) {
      fail("Spider Egg manifest exceeds the size limit");
    }
  }

  const payloads: EggPayload[] = [];
  let manifest: SpiderEggManifest | undefined;
  try {
    for (const { entry, path } of metadata) {
      const local = await zip.readLocalFileHeaderPromise(entry);
      if (
        local.versionNeededToExtract !== entry.versionNeededToExtract ||
        local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
        local.compressionMethod !== entry.compressionMethod ||
        local.lastModFileDate !== entry.lastModFileDate ||
        local.lastModFileTime !== entry.lastModFileTime ||
        local.crc32 !== entry.crc32 ||
        local.compressedSize !== entry.compressedSize ||
        local.uncompressedSize !== entry.uncompressedSize ||
        local.fileName.compare(entry.fileNameRaw) !== 0 ||
        local.extraField.byteLength !== 0
      ) {
        fail(`ZIP local and central metadata do not match: ${path}`);
      }
      const bytes = await readStream(zip, entry);
      if (bytes.byteLength !== entry.uncompressedSize)
        fail(`ZIP entry size mismatch: ${path}`);
      if (crc32(bytes) >>> 0 !== entry.crc32)
        fail(`ZIP CRC-32 check failed: ${path}`);
      if (path === "manifest.json") {
        if (manifest)
          fail("Spider Egg contains duplicate manifest.json entries");
        let text: string;
        try {
          text = strictUtf8.decode(bytes);
        } catch {
          fail("manifest.json is not valid UTF-8");
        }
        manifest = parseManifestJson(text!);
      } else {
        const mediaType =
          path === "session.json"
            ? "application/json"
            : path === "handoff.md"
              ? "text/markdown; charset=utf-8"
              : "application/octet-stream";
        payloads.push({ path, mediaType, bytes });
      }
    }
  } catch (error) {
    if (error instanceof SpiderEggError) throw error;
    throw new SpiderEggError("Could not read Spider Egg payloads", {
      cause: error,
    });
  }
  if (!manifest) fail("Spider Egg is missing manifest.json");

  const byPath = new Map(payloads.map((payload) => [payload.path, payload]));
  const declaredPayloads: EggPayload[] = manifest.entries.map((item) => {
    const payload = byPath.get(item.path);
    if (!payload) fail(`Spider Egg is missing declared payload ${item.path}`);
    return { ...payload, mediaType: item.media_type };
  });
  if (declaredPayloads.length !== payloads.length)
    fail("Spider Egg contains undeclared payload entries");
  verifyPayloads(manifest, declaredPayloads);

  const sessionEntry = byPath.get("session.json");
  const handoffEntry = byPath.get("handoff.md");
  if (!sessionEntry || !handoffEntry)
    fail("Spider Egg is missing required session or handoff content");
  let handoff: string;
  try {
    handoff = strictUtf8.decode(handoffEntry.bytes);
  } catch {
    fail("handoff.md is not valid UTF-8");
  }
  const session = parseSessionJson(strictUtf8.decode(sessionEntry.bytes));
  if (handoff !== renderHandoff(session))
    fail("handoff.md does not match the deterministic session handoff");
  verifyPayloads(manifest, declaredPayloads, session);

  return {
    manifest,
    session,
    handoff: handoff!,
    artifacts: declaredPayloads.filter((payload) =>
      payload.path.startsWith("artifacts/"),
    ),
  };
}
