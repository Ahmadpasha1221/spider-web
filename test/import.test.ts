import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptySession } from "../src/core/session.js";
import {
  parseSessionJson,
  serializeSession,
  writeSessionJsonFile,
} from "../src/core/session-serialization.js";
import { readSpiderEgg, writeSpiderEgg } from "../src/egg/archive.js";

describe("Spider Egg import", () => {
  it("round-trips an Egg back to the canonical session JSON", async () => {
    const session = createEmptySession("Recover the session", {
      projectName: "demo",
    });
    session.conversation.push({
      id: "e1",
      sequence: 1,
      role: "user",
      content: [{ type: "text", text: "carry this work" }],
      handoff_relevant: true,
    });

    const egg = await writeSpiderEgg(session);
    const document = await readSpiderEgg(egg);
    expect(document.session).toEqual(session);

    const directory = await mkdtemp(join(tmpdir(), "spider-web-import-"));
    const outputPath = join(directory, "session.json");
    try {
      await writeSessionJsonFile(outputPath, document.session);
      const text = await readFile(outputPath, "utf8");
      // The imported file is byte-identical to the canonical in-Egg payload.
      expect(text).toBe(serializeSession(session));
      expect(text.endsWith("\n")).toBe(false);
      expect(parseSessionJson(text)).toEqual(session);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a new session file without replacing existing content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spider-web-import-"));
    const existing = join(directory, "existing.json");
    try {
      await writeFile(existing, "preserve me");
      await expect(
        writeSessionJsonFile(existing, createEmptySession("goal")),
      ).rejects.toThrow();
      expect(await readFile(existing, "utf8")).toBe("preserve me");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses portable POSIX entry paths with no separators or traversal", async () => {
    const archive = await writeSpiderEgg(createEmptySession("portable paths"));
    const document = await readSpiderEgg(archive);
    const paths = document.manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("session.json");
    expect(paths).toContain("handoff.md");
    for (const path of paths) {
      expect(path).not.toMatch(/\\/);
      expect(path).not.toMatch(/^[A-Za-z]:/);
      expect(path).not.toMatch(/^\//);
      expect(path).not.toContain("..");
    }
  });
});
