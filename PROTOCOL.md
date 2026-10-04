# Spider Session and Spider Egg Protocol (0.1 draft)

This document is the implementation contract for the initial local format. It remains a draft until TypeScript types, JSON Schema validation, and fixtures are added. The concrete choices are recorded in [DECISIONS.md](DECISIONS.md).

## Spider Session

A single `session.json` stores the canonical session, including all available conversation and normalized tool events. There are no provider-specific core fields. The initial structural schema is [spider-session.schema.json](schemas/spider-session.schema.json).

```json
{
  "schema_version": "1.0",
  "session": {
    "id": "spw_550e8400-e29b-41d4-a716-446655440000",
    "created_at": "2026-01-01T12:00:00Z",
    "updated_at": "2026-01-01T12:10:00Z",
    "source_agent": "claude-code",
    "project": { "name": "service", "root_hint": "." }
  },
  "objective": { "goal": "Fix refresh token handling", "status": "in_progress" },
  "state": {
    "current_task": "Trace refresh flow",
    "completed": [], "in_progress": [], "blocked": []
  },
  "conversation": [
    { "id": "e1", "sequence": 1, "role": "user", "content": [{ "type": "text", "text": "…" }] }
  ],
  "tool_calls": [],
  "tool_results": [],
  "decisions": [],
  "files": { "created": [], "modified": [], "deleted": [] },
  "artifacts": [],
  "commands": [],
  "tests": [],
  "errors": [],
  "capture": { "omissions": [], "truncations": [] },
  "environment": { "os_family": "windows", "runtime": "node", "shell": "pwsh" },
  "git": { "branch": null, "head": null, "status": "unknown", "files": [] },
  "next_action": { "description": "Inspect token rotation", "evidence": { "source": "user", "confidence": "observed" } },
  "extensions": {}
}
```

### Neutral records

- `conversation` is an ordered list of neutral messages. Roles are `system`, `developer`, `user`, `assistant`, or `other`; content parts are text or references/unavailable markers. Binary content is referenced as an artifact and never silently inlined. `handoff_relevant` defaults to false. Adapters mark the newest user request and latest assistant response; they may also mark explicit decision/failure/blocker exchanges using documented, deterministic rules. Users can edit the flags.
- Conversation messages, tool calls/results, commands, tests, and errors each have a unique event `id` and globally monotonic session `sequence` (starting at 1). Sequence reflects source order where available and adapter observation order otherwise; it never implies more precise timing than the source provides.
- `tool_calls` and `tool_results` are separate arrays linked by a session-local `tool_call_id`. Tool call status and result status are distinct; each result also has its own event `id`. Unknown provider tool shapes may be represented as bounded opaque data in the adapter extension, not as new core provider-shaped keys.
- `state` holds the current task and explicit completed/in-progress/blocked items. Blockers describe work that cannot proceed; `errors` preserve observed failures as evidence.
- `decisions`, `files`, `commands`, `tests`, `errors`, and `next_action` may contain `evidence.source`, `evidence.confidence`, and optional source event ID. `files` describes attributed actions. `git.files` describes the observed worktree/index snapshot. Never derive one from the other.
- `artifacts` record identifier, kind, source path only where safe, content digest, inclusion status, and Egg entry path when included. Default capture does not attach arbitrary files.
- Portable file/artifact paths are relative POSIX paths under the project. Do not serialize absolute, drive-letter, UNC, or parent-traversal paths. A selected file outside the project has no source path in the portable Session.
- Inline tool result output is limited to 64 KiB UTF-8; longer output is truncated with an explicit capture truncation and may be preserved as a separately selected artifact. Command stdout/stderr is not inlined by default; it is an optional artifact.
- `environment` is restricted to allowlisted non-secret facts: OS family/version, runtime name/version, and shell executable name. It has no environment variable bag.
- `session.source_agent` is provenance, not a type of message. Native source session IDs and unknown provider data belong in `extensions["<adapter-id>"]` when useful and safe.

All captured fields are best-effort evidence. Unsupported, truncated, or unavailable values must be identified as such; never invent decisions, test outcomes, changed files, or tool results. Secret/thinking content is excluded by default. Core extension values are optional and cannot be required to understand the objective or current work state.

## Spider Egg v0.1

`.spider-egg` is a standard, uncompressed ZIP archive. It contains one canonical state file and derived/export assets; the conversation is not duplicated in a second transcript file.

```text
manifest.json                 format and entry integrity metadata
session.json                  complete canonical Spider Session
handoff.md                    deterministic compact view of the session
artifacts/<sha256>            optional, explicitly selected files only
```

The manifest shape is validated by [spider-egg-manifest.schema.json](schemas/spider-egg-manifest.schema.json). It is UTF-8 canonical JSON and has exactly these required fields:

```json
{
  "format": "spider-egg",
  "format_version": "0.1",
  "schema_version": "1.0",
  "session_id": "spw_…",
  "required_features": [],
  "entries": [
    { "path": "handoff.md", "media_type": "text/markdown; charset=utf-8", "size": 1234, "sha256": "<64 lowercase hex>" },
    { "path": "session.json", "media_type": "application/json", "size": 2345, "sha256": "<64 lowercase hex>" }
  ]
}
```

`entries` lists every file except `manifest.json`, sorted by POSIX path. Artifacts use content-addressed `artifacts/<sha256>` names and the Session artifact record points to that path. Manifest itself is not hashed or signed. Hashes detect modification, not origin, and do not encrypt data.

The manifest is limited to 1 MiB. An Egg contains at most 2,000 entries including `manifest.json`, and expanded payload bytes total at most 256 MiB. Required features are empty in 0.1; readers reject any unknown required feature. `session.json` and `handoff.md` are mandatory and use `application/json` and `text/markdown; charset=utf-8` respectively. Every declared artifact must be explicitly selected by the caller, and its path suffix must equal its SHA-256 digest. Unreferenced, undeclared payloads are rejected.

### Determinism

Serialize JSON using RFC 8785 JSON Canonicalization Scheme (UTF-8, no BOM, no trailing newline); reject duplicate JSON member names before canonicalization. Markdown is UTF-8 without BOM with LF endings. ZIP entries are sorted by path, use the fixed DOS timestamp `1980-01-01T00:00:00`, fixed Unix host/version marker, regular-file mode `0644`, UTF-8 filename flag, no extra fields/comments/directories/data descriptors/ZIP64, and `ZIP_STORED` (no compression). Manifest has no generated-at or producer field. Thus identical canonical session and attachment bytes produce identical archive bytes. This prioritizes reproducibility over compressed size.

### Validation and extraction

Reject absolute paths, `..`, backslashes, duplicate names, symlinks, encryption, compression methods other than STORED, malformed manifests, invalid sizes or hashes, more than 2,000 total ZIP entries (including the manifest), more than 256 MiB total expanded content, and unsupported major format versions or unrecognized required features. Validate archive metadata first, then stream entries into a private staging directory while checking actual sizes and SHA-256; atomically rename staging to the requested new, absent destination only after all checks pass. Clean up staging on failure. Preserve unknown non-required Session extension fields; unknown archive entries are rejected in 0.1 so their security and meaning cannot be guessed.

## Compact handoff

`handoff.md` is a deterministic projection, not a second source of truth and not an AI-generated summary. Render sections in this order: objective/status; current task; next action; blockers; completed/in-progress; decisions; attributed file changes; Git snapshot; tests/errors/commands; allowlisted environment; relevant conversation excerpts. Include only messages explicitly marked `handoff_relevant`, newest first. The whole document has a hard limit of 12,000 Unicode characters. Fill sections in the stated order, truncate a record only at a Unicode code-point boundary, reserve space for a final omission/truncation notice, and stop adding lower-priority records once full. Handoff generator performs no network call.

## Versioning and conversion

`schema_version` and `format_version` use `major.minor`. Phase 1 supports only session schema `1.0` and Egg format `0.1`; readers reject all other versions until their schema and semantics are shipped. Core objects reject unknown fields. Provider-specific optional data is preserved only within `extensions`. Egg `required_features` is empty for 0.1; non-empty values are rejected until defined. Every adapter reports omissions, truncations, and uncertain mappings. Conversion never claims lossless round-trip unless demonstrated by fixtures.
