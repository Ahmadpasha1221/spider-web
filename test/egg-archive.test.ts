import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptySession } from "../src/core/session.js";
import {
  readSpiderEgg,
  readSpiderEggFile,
  writeSpiderEgg,
  writeSpiderEggFile,
} from "../src/egg/archive.js";

describe("Spider Egg archive", () => {
  it("writes deterministic archives and reads back the canonical session and handoff", async () => {
    const session = createEmptySession("Carry current work safely");
    const first = await writeSpiderEgg(session);
    const second = await writeSpiderEgg(session);
    expect(first.equals(second)).toBe(true);

    const document = await readSpiderEgg(first);
    expect(document.session).toEqual(session);
    expect(document.handoff).toContain("Carry current work safely");
    expect(document.artifacts).toEqual([]);
    expect(document.manifest.entries.map((item) => item.path)).toEqual([
      "handoff.md",
      "session.json",
    ]);
  });

  it("includes explicitly selected content-addressed artifacts", async () => {
    const session = createEmptySession("Keep this selected file");
    const bytes = Buffer.from("selected artifact bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    session.artifacts.push({
      id: "artifact-1",
      kind: "text/plain",
      sha256,
      inclusion: "included",
      entry_path: `artifacts/${sha256}`,
    });

    const archive = await writeSpiderEgg(session, [
      { artifactId: "artifact-1", bytes },
    ]);
    const document = await readSpiderEgg(archive);
    expect(document.artifacts).toHaveLength(1);
    expect(Buffer.from(document.artifacts[0]!.bytes)).toEqual(bytes);
  });

  it("rejects invalid ZIP input and payload corruption", async () => {
    await expect(readSpiderEgg(Buffer.from("not a zip"))).rejects.toThrow();

    const archive = Buffer.from(
      await writeSpiderEgg(createEmptySession("integrity check")),
    );
    const handoffName = Buffer.from("handoff.md");
    const firstByte = 30 + handoffName.byteLength;
    archive[firstByte] = archive[firstByte]! ^ 0x01;
    await expect(readSpiderEgg(archive)).rejects.toThrow(
      /CRC|checksum|integrity/i,
    );
  });

  it("writes a new Egg file without replacing existing content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-egg-"));
    const outputPath = join(directory, "session.spider-egg");
    try {
      const session = createEmptySession("file API smoke test");
      await writeSpiderEggFile(outputPath, session);
      const loaded = await readSpiderEggFile(outputPath);
      expect(loaded.session.session.id).toBe(session.session.id);

      const existing = join(directory, "existing.spider-egg");
      await writeFile(existing, "preserve me");
      await expect(writeSpiderEggFile(existing, session)).rejects.toThrow();
      expect(await readFile(existing, "utf8")).toBe("preserve me");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
