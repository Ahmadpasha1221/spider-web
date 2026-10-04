# Cursor Research

**Checked:** 2026-10-04. **Confidence:** high for user-facing history export and CLI output; low for private database schema stability.

## Findings

- Cursor documents local chat history in SQLite and provides a user-facing Markdown export for preserving chats.
- Cursor checkpoints are local snapshots of Agent changes, separate from Git, track only agent changes (not manual edits), and may be cleaned automatically.
- Cursor CLI documents `cursor-agent ls`, `cursor-agent resume [thread id]`, and `--print --output-format json|stream-json`. The stream includes assistant and tool-call events with session IDs; docs say fields may be added and consumers should ignore unknown fields. This is an execution output format, not automatically a stable historical chat database export.
- Background Agent chats are held remotely and are outside the local-only capture assumption unless explicitly exported through a documented user flow.

## Adapter implications

- Level 2 is feasible from user-exported Markdown and CLI stream output; normalize only content actually present.
- Direct SQLite reads are experimental pending a supported schema/API. Never write Cursor DB or checkpoint stores.
- Native resume is available within Cursor CLI for its own thread IDs. There is no evidence this can import external Spider state.

## Unanswered

- Is the local SQLite schema public/stable? Which DB and tables vary by OS/version?
- Does Markdown export preserve tool calls/results, attachments, and code diffs or only rendered conversation?
- Can checkpoint metadata be exported through documented interface?

## Sources

- [Cursor history](https://docs.cursor.com/en/agent/chat/history)
- [Cursor CLI usage](https://docs.cursor.com/en/cli/using)
- [Cursor CLI output format](https://docs.cursor.com/en/cli/reference/output-format)
- [Cursor checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints)
