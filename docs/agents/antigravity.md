# Google Antigravity Research

**Checked:** 2026-10-04. **Confidence:** high for documented CLI workflows; low for IDE local storage internals.

## Findings

- Current official docs distinguish Antigravity IDE, Antigravity 2.0 desktop command center, and Antigravity CLI/TUI. The CLI docs describe workspace-scoped conversation histories, session picker, `agy -c`/`--continue`, `/resume`, and `/fork`.
- Official IDE Agent docs describe conversations, tools, artifacts, and deletion in the UI, but do not document a local transcript file format or external export/import API in the reviewed page.
- Community reports of SQLite, LevelDB, protobuf, or JSONL files are inconsistent across app versions. Treat paths/formats as unsupported observations; do not build a native adapter on them yet.
- CLI resume is a native Antigravity operation, not a way to import Spider Egg into an existing Antigravity conversation.

## Adapter implications

- Level 3 generic handoff is baseline. Potential Level 2 may be offered by a CLI output/export command, but the official conversation docs reviewed do not specify an export schema.
- Keep CLI and IDE surfaces as separate adapter targets or capability profiles; do not assume shared storage.
- Never reverse engineer or mutate IDE DBs in the initial adapter.

## Unanswered

- Does CLI expose documented JSON/JSONL conversation export, and is it complete for tool calls/results?
- Is the IDE's session storage local, synchronized, encrypted, or product-version dependent?
- What does the Antigravity SDK expose about an existing interactive conversation?

## Sources

- [Antigravity CLI conversation management](https://antigravity.google/docs/cli/conversations)
- [Antigravity Agent overview](https://www.antigravity.google/docs/agent/)
- [Antigravity CLI reference](https://www.antigravity.google/docs/cli/reference/)
