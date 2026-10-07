import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { SessionRecorder } from "../agent-session.js";
import { redactSecrets } from "./codex-redact.js";

export async function readJsonLines(
  stream: Readable | null,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  if (stream === null) return;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.write(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer),
          );
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      await onLine(line);
      index = buffer.indexOf("\n");
    }
  }
  buffer += decoder.end();
  if (buffer.trim().length > 0) await onLine(buffer);
}

export async function recordStderr(
  stream: Readable | null,
  recorder: SessionRecorder,
): Promise<void> {
  if (stream === null) return;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.write(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer),
          );
  }
  buffer += decoder.end();
  const text = buffer.trim();
  if (text.length > 0) {
    recorder.apply({
      type: "capture_note",
      kind: "omission",
      note: `Codex stderr: ${redactSecrets(text).slice(0, 500)}`,
    });
  }
}

export type WritableLike = Writable;
