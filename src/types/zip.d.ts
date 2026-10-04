declare module "yazl" {
  import { Readable } from "node:stream";
  export interface ZipOptions {
    mtime?: Date;
    mode?: number;
    compress?: boolean;
    forceDosTimestamp?: boolean;
    forceZip64Format?: boolean;
  }
  export class ZipFile {
    readonly outputStream: Readable;
    on(event: "error", listener: (error: Error) => void): this;
    addBuffer(buffer: Buffer, path: string, options?: ZipOptions): void;
    end(options?: { forceZip64Format?: boolean; comment?: string }): void;
  }
  const yazl: { ZipFile: typeof ZipFile };
  export default yazl;
}

declare module "yauzl" {
  import { Readable } from "node:stream";
  export class Entry {
    compressedSize: number;
    compressionMethod: number;
    crc32: number;
    externalFileAttributes: number;
    extraFieldRaw: Buffer;
    fileCommentRaw: Buffer;
    fileNameRaw: Buffer;
    generalPurposeBitFlag: number;
    lastModFileDate: number;
    lastModFileTime: number;
    relativeOffsetOfLocalHeader: number;
    uncompressedSize: number;
    versionMadeBy: number;
    versionNeededToExtract: number;
  }
  export class ZipFile {
    comment: string;
    entryCount: number;
    eachEntry(): AsyncIterableIterator<Entry>;
    openReadStreamPromise(entry: Entry): Promise<Readable>;
    readLocalFileHeaderPromise(entry: Entry): Promise<{
      versionNeededToExtract: number;
      generalPurposeBitFlag: number;
      compressionMethod: number;
      lastModFileDate: number;
      lastModFileTime: number;
      crc32: number;
      compressedSize: number;
      uncompressedSize: number;
      fileName: Buffer;
      extraField: Buffer;
    }>;
  }
  export function fromBufferPromise(
    buffer: Buffer,
    options: {
      lazyEntries?: boolean;
      decodeStrings?: boolean;
      validateEntrySizes?: boolean;
      strictFileNames?: boolean;
    },
  ): Promise<ZipFile>;
}
