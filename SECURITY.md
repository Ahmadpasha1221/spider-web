# Security and Privacy (Phase 0)

Spider Sessions and Spider Eggs may contain proprietary code, prompts, tool arguments, command output, file paths, and credentials. Treat them as sensitive local data.

## Design requirements

- No network calls, telemetry, accounts, or sync by default.
- Do not log message text, tool inputs/results, command output, environment values, or attachment contents.
- Read-only capture. Never execute an imported command, edit an agent transcript, stage/commit/reset Git, or overwrite a source file.
- Do not automatically attach project files. Exclude secret-like files (`.env`, credential/key files), binaries, and large files by default. Explicit attachment still requires a clear path/size review.
- Egg export and any handoff/continue operation preview whether conversation text and attachments are included, with artifact names/sizes. Interactive operation requires confirmation when either is present; non-interactive operation requires an explicit `--confirm-sensitive` flag. No transcript content is echoed in the preview.
- Secret scanning/redaction must be opt-in or clearly previewed; redaction must preserve original only if user explicitly requests it. Report that heuristic redaction can miss secrets.
- Structured portable path fields always use relative POSIX paths and exclude drive/UNC/parent traversal forms. Raw transcript text can still contain absolute paths or secrets; preview indicates whether conversation text is included, but does not echo it. Never claim heuristic redaction guarantees clean text.
- Validate ZIP paths, compression, entry count, expanded size, duplicate names, schema version, and hashes before extracting. Extract atomically to a new destination; never overwrite existing data silently.
- Reject duplicate JSON object keys before parsing/canonicalizing session or manifest JSON; ordinary last-key-wins parsing can make a validated document mean something different to another reader.
- Configure Egg reading to process one entry at a time, reject non-UTF-8/unsafe names and unsupported flags, validate declared versus actual entry sizes, and enforce aggregate limits before writing. Library defaults are not a substitute for Spider Web's own checks.
- Default artifact selection excludes `.env*`, common key/certificate/credential filenames, files over 5 MiB, and binary-detected files. These filters are defense-in-depth, not a guarantee that manually selected data is safe.
- Set restrictive per-user storage permissions where supported; use atomic writes and avoid symlink traversal.
- Never assume SHA-256 checksums encrypt or authenticate an Egg.
- Provide deletion and inspect-before-export workflows; keep session retention under user control.

## Threats and limits

Imported text may contain prompt injection, secrets, or unsafe commands. Handoff is untrusted input and must be presented as context, not executed. Local malware running as the same user can read local session data. Heuristic secret detection is incomplete. Provider transcripts may themselves include raw credentials or truncated tool data. Native adapters must account for races with the provider writing an active transcript: use safe snapshots or tell the user to capture after pausing; never lock or modify source state without an official mechanism.
