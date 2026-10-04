# Claude Code Research

**Checked:** 2026-10-04. **Confidence:** medium; public docs expose CLI/session APIs but do not establish a stable local transcript contract.

## Findings

- Official CLI docs support `--continue` for the most recent session, `--resume <session-id>`/`-r`, and print output formats including JSON and stream-JSON. These are useful for user-controlled continuation and scripted output. They are not a Spider Egg import API.
- Anthropic's Compliance API documentation describes local Claude Code sessions server-side for Enterprise and says transcripts include user prompts, assistant text, tool calls, and text tool results, subject to truncation. It explicitly says transcript data omits thinking, system prompt content, tool definitions/MCP configuration, and binary/structured content; it also does not capture local actions never sent to the API. This API requires organization access and network, so it is outside the local-first adapter.
- Session files/path formats are not established as a supported public contract by the primary documentation reviewed. Community/source observations of JSONL in `~/.claude/projects` should remain experimental and platform/path discovery must not be hardcoded as stable.

## Adapter implications

- Level 2 is available via documented CLI output for a controlled run; user's historical interactive transcript import requires further official format evidence.
- Resume is native only within Claude Code via its own session identifiers. Resuming a Spider Egg in Claude is not yet documented.
- Do not promise exact tool-result or changed-file recovery from server transcripts. Read Git separately and label source/provenance.
- Potential v0.1: generic `handoff.md` consumed by a user-started Claude session; native capture remains gated on format validation.

## Unanswered

- Is interactive transcript JSONL a supported public interface? What is the compatibility policy?
- Can official CLI stream-json safely capture full interactive tool events, or only print-mode invocation events?
- Which content is persisted locally across supported Claude Code surfaces and versions?

## Sources

- [Claude Code CLI usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Retrieve session transcripts (Compliance API)](https://platform.claude.com/docs/en/manage-claude/compliance-sessions)
- [Claude Code FAQ: export and local operation](https://support.claude.com/en/articles/14554922-claude-code-user-faq)
