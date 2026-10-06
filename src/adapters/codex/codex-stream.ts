import type { Readable, Writable } from "node:stream";
import type { SessionRecorder } from "../agent-session.js";
import { redactSecrets } from "./codex-redact.js";

export async function readJsonLines(
  stream: Readable | null,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  if (stream === null) return;
  let buffer = "";
  for await (const chunk of stream) {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      await onLine(line);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.trim().length > 0) await onLine(buffer);
}

export async function recordStderr(
  stream: Readable | null,
  recorder: SessionRecorder,
): Promise<void> {
  if (stream === null) return;
  let buffer = "";
  for await (const chunk of stream) {
    buffer += String(chunk);
  }
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
