import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEggPayloads, createManifest, parseManifestJson, serializeManifest, validateManifest, verifyPayloads } from "../src/protocol/manifest.js";
import { createEmptySession } from "../src/core/session.js";

describe("Spider Egg manifest contract", () => {
  it("creates canonical sorted manifest and verifies payload hashes", () => {
    const session = createEmptySession("Move work between agents");
    const payloads = createEggPayloads(session);
    const manifest = createManifest(session, payloads);
    expect(manifest.entries.map(({ path }) => path)).toEqual(["handoff.md", "session.json"]);
    expect(parseManifestJson(serializeManifest(manifest))).toEqual(manifest);
    expect(() => parseManifestJson(`${serializeManifest(manifest)}\n`)).toThrow(/canonical/);
    verifyPayloads(manifest, payloads, session);
  });
  it("requires explicitly supplied included artifacts with the declared digest", () => {
    const session = createEmptySession("goal");
    const bytes = new TextEncoder().encode("selected data");
    const digest = createHash("sha256").update(bytes).digest("hex");
    session.artifacts.push({ id: "a1", kind: "text/plain", sha256: digest, inclusion: "included", entry_path: `artifacts/${digest}` });
    expect(() => createEggPayloads(session)).toThrow(/no explicitly selected payload/);
    const payloads = createEggPayloads(session, [{ artifactId: "a1", bytes }]);
    const manifest = createManifest(session, payloads);
    verifyPayloads(manifest, payloads, session);
    const corrupt = payloads.map((payload) => payload.path.startsWith("artifacts/") ? { ...payload, bytes: new TextEncoder().encode("other") } : payload);
    expect(() => verifyPayloads(manifest, corrupt, session)).toThrow(/integrity/);
  });
  it("rejects unsorted or duplicate manifest paths", () => {
    const session = createEmptySession("goal");
    const manifest = createManifest(session, createEggPayloads(session));
    manifest.entries.reverse();
    expect(() => validateManifest(manifest)).toThrow(/sorted/);
    manifest.entries.push({ ...manifest.entries[0]! });
    expect(() => validateManifest(manifest)).toThrow();
  });
});
