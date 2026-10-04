import { createHash } from "node:crypto";
import type { SpiderEggManifest01 } from "../generated/spider-egg-manifest.js";
import { canonicalJson, parseStrictJson } from "../core/json.js";
import { renderHandoff } from "../core/handoff.js";
import { serializeSession } from "../core/session-serialization.js";
import { validateSession, type SpiderSession } from "../core/session.js";
import { parseSessionJson } from "../core/session-serialization.js";
import { assertSchema, ContractValidationError, validateManifestShape } from "../core/schema.js";

export type SpiderEggManifest = SpiderEggManifest01;
export const MAX_EGG_ENTRIES = 2_000;
export const MAX_EGG_EXPANDED_BYTES = 256 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface EggPayload {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface SelectedArtifact {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function contract(message: string): never {
  throw new ContractValidationError(message);
}

export function validateManifest(value: unknown, session?: SpiderSession): asserts value is SpiderEggManifest {
  assertSchema(validateManifestShape, value, "Spider Egg manifest");
  const manifest = value as SpiderEggManifest;
  if (manifest.entries.length > MAX_EGG_ENTRIES - 1) contract("Manifest exceeds the total Egg entry limit");
  if (manifest.required_features.length !== 0) contract("Unsupported required features are present");
  const paths = new Set<string>();
  let totalBytes = 0;
  let previousPath = "";
  for (const entry of manifest.entries) {
    if (paths.has(entry.path)) contract(`Duplicate manifest path: ${entry.path}`);
    paths.add(entry.path);
    if (entry.path <= previousPath) contract("Manifest entries must be strictly lexicographically sorted by path");
    previousPath = entry.path;
    totalBytes += entry.size;
    if (totalBytes > MAX_EGG_EXPANDED_BYTES) contract("Manifest exceeds the expanded size limit");
    if (entry.path === "session.json" && entry.media_type !== "application/json") contract("session.json must use application/json");
    if (entry.path === "handoff.md" && entry.media_type !== "text/markdown; charset=utf-8") contract("handoff.md must use text/markdown; charset=utf-8");
    if (entry.path.startsWith("artifacts/") && entry.media_type === "") contract("Artifact media type must not be empty");
    if (entry.path.startsWith("artifacts/") && entry.path.slice("artifacts/".length) !== entry.sha256) {
      contract(`Artifact path must be content-addressed by its SHA-256: ${entry.path}`);
    }
  }
  if (session) {
    validateSession(session);
    if (manifest.session_id !== session.session.id) contract("Manifest session_id does not match session.json");
    const expected = new Set(session.artifacts.flatMap((artifact) => artifact.inclusion === "included" && artifact.entry_path ? [artifact.entry_path] : []));
    const actual = new Set(manifest.entries.filter((entry) => entry.path.startsWith("artifacts/")).map((entry) => entry.path));
    if (expected.size !== actual.size || [...expected].some((path) => !actual.has(path))) {
      contract("Manifest artifact entries do not match included session artifacts");
    }
    for (const artifact of session.artifacts) {
      if (artifact.inclusion === "included" && (!artifact.entry_path || !artifact.sha256 || artifact.entry_path !== `artifacts/${artifact.sha256}`)) {
        contract(`Included artifact ${artifact.id} has inconsistent content metadata`);
      }
    }
  }
}

export function createEggPayloads(session: SpiderSession, selected: readonly SelectedArtifact[] = []): EggPayload[] {
  validateSession(session);
  const selectedById = new Map<string, Uint8Array>();
  for (const item of selected) {
    if (selectedById.has(item.artifactId)) contract(`Duplicate selected artifact id: ${item.artifactId}`);
    selectedById.set(item.artifactId, item.bytes);
  }
  const referenced = new Set<string>();
  const payloads: EggPayload[] = [
    { path: "session.json", mediaType: "application/json", bytes: encoder.encode(serializeSession(session)) },
    { path: "handoff.md", mediaType: "text/markdown; charset=utf-8", bytes: encoder.encode(renderHandoff(session)) },
  ];
  const emitted = new Set<string>();
  for (const artifact of session.artifacts) {
    if (artifact.inclusion !== "included") continue;
    if (!artifact.sha256 || !artifact.entry_path || artifact.entry_path !== `artifacts/${artifact.sha256}`) {
      contract(`Included artifact ${artifact.id} must declare matching SHA-256 and entry_path`);
    }
    const bytes = selectedById.get(artifact.id);
    if (!bytes) contract(`Included artifact ${artifact.id} has no explicitly selected payload`);
    referenced.add(artifact.id);
    if (sha256(bytes) !== artifact.sha256) contract(`Selected artifact ${artifact.id} does not match its declared SHA-256`);
    if (!emitted.has(artifact.entry_path)) {
      payloads.push({ path: artifact.entry_path, mediaType: artifact.kind || "application/octet-stream", bytes });
      emitted.add(artifact.entry_path);
    }
  }
  for (const artifactId of selectedById.keys()) if (!referenced.has(artifactId)) contract(`Selected artifact ${artifactId} is not declared as included in the session`);
  return payloads;
}

export function createManifest(session: SpiderSession, payloads: readonly EggPayload[]): SpiderEggManifest {
  validateSession(session);
  const entries = payloads.map((payload) => ({ path: payload.path, media_type: payload.mediaType, size: payload.bytes.byteLength, sha256: sha256(payload.bytes) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest: SpiderEggManifest = {
    format: "spider-egg",
    format_version: "0.1",
    schema_version: "1.0",
    session_id: session.session.id,
    required_features: [],
    entries: entries as SpiderEggManifest["entries"],
  };
  validateManifest(manifest, session);
  const bytes = encoder.encode(canonicalJson(manifest)).byteLength;
  if (bytes > MAX_MANIFEST_BYTES) contract("Manifest exceeds the manifest size limit");
  return manifest;
}

export function verifyPayloads(manifest: SpiderEggManifest, payloads: readonly EggPayload[], session?: SpiderSession): void {
  validateManifest(manifest, session);
  const actual = new Map<string, EggPayload>();
  for (const payload of payloads) {
    if (actual.has(payload.path)) contract(`Duplicate payload path: ${payload.path}`);
    actual.set(payload.path, payload);
  }
  if (actual.size !== manifest.entries.length) contract("Payload count does not match manifest");
  for (const entry of manifest.entries) {
    const payload = actual.get(entry.path);
    if (!payload) contract(`Missing payload: ${entry.path}`);
    if (payload.bytes.byteLength !== entry.size || sha256(payload.bytes) !== entry.sha256) contract(`Payload integrity check failed: ${entry.path}`);
    if (payload.mediaType !== entry.media_type) contract(`Payload media type mismatch: ${entry.path}`);
    if (entry.path === "session.json") {
      let parsed: SpiderSession;
      try { parsed = parseSessionJson(decoder.decode(payload.bytes)); } catch { contract("session.json is not a valid Spider Session JSON document"); }
      if (parsed!.session.id !== manifest.session_id) contract("manifest session_id does not match session.json");
      if (session && canonicalJson(parsed!) !== canonicalJson(session)) contract("session.json payload differs from the supplied session");
      if (!session) validateManifest(manifest, parsed!);
    }
  }
}

export function serializeManifest(manifest: SpiderEggManifest): string {
  validateManifest(manifest);
  const text = canonicalJson(manifest);
  if (encoder.encode(text).byteLength > MAX_MANIFEST_BYTES) contract("Manifest exceeds the manifest size limit");
  return text;
}

export function parseManifestJson(text: string): SpiderEggManifest {
  if (encoder.encode(text).byteLength > MAX_MANIFEST_BYTES) contract("Manifest exceeds the manifest size limit");
  const value = parseStrictJson(text);
  validateManifest(value);
  if (canonicalJson(value) !== text) contract("Manifest JSON must use canonical serialization without a BOM or trailing newline");
  return value;
}
