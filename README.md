# Spider Web

**Spider Web connects AI agents. Spider Egg carries their session state.**

Spider Web is a local-first, agent-neutral interoperability layer for AI coding sessions. It is a separate project from Spider Agent, and does not require Spider Agent. The generic Spider Session and Spider Egg core is under development; there are no supported capture adapters yet.

```text
Claude reaches a quota limit
        ↓
spider-web session capture claude
        ↓
Spider Session → Spider Egg
        ↓
Codex receives a compact handoff
        ↓
Continue the task in the existing working tree
```

The goal is to preserve working state—objective, completed and unfinished work, decisions, files, commands, tests, blockers, and next action—not to paste an entire transcript into a new model. Spider Web is a protocol and CLI, not an AI agent. Version 0.1 will work locally without an account, API key, server, or cloud synchronization.

## Project state

This repository contains the Phase 0 protocol and agent research, the provider-neutral session core, the Spider Egg APIs, and the Phase 3 local session repository. The CLI stores sessions in a platform-appropriate local data directory, lists and inspects them, exports a stored session as a `.spider-egg`, imports an Egg into the repository, and validates/exports/inspects Egg files. Egg contents remain in memory; the reader does not extract files. No agent adapter is claimed as supported.

```bash
spider-web session list
spider-web session inspect <session-id>
spider-web session export <session-id> ./session.spider-egg --confirm-sensitive
spider-web session import ./session.spider-egg --confirm-sensitive
spider-web session delete <session-id>

spider-web egg export session.json ./session.spider-egg --confirm-sensitive
spider-web egg import ./session.spider-egg ./session.json --confirm-sensitive
spider-web egg inspect ./session.spider-egg
spider-web session validate session.json
```

The library exports the Spider Session core (`createEmptySession`, `validateSession`, `serializeSession`, `parseSessionJson`), the Egg APIs (`writeSpiderEgg`, `readSpiderEgg`, `writeSpiderEggFile`, `readSpiderEggFile`), and the repository (`LocalSessionRepository`, `SessionRepository`, `SessionSummary`). Export and import preview metadata and require confirmation for sensitive session content; the Egg reader never executes commands from an Egg.

## Local session repository

Sessions live under the platform data directory as canonical `sessions/<session-id>/session.json` files, with a rebuildable `index.json` discovery cache:

- Linux: `$XDG_DATA_HOME/spider-web`, falling back to `~/.local/share/spider-web`
- macOS: `~/Library/Application Support/spider-web`
- Windows: `%LOCALAPPDATA%\Spider Web`
- Override for tests or isolated environments: `SPIDER_WEB_DATA_DIR`

The index is a cache, not the source of truth. If `index.json` is missing, malformed, or stale (for example, a session file was written but the index update failed), the repository rebuilds it from the canonical session files on the next read. Session files are written atomically: creation is exclusive (existing files are never overwritten) and updates replace the file via a synced temporary file and rename, so a failed update always leaves the previous valid session intact. Concurrent writes to the same session are last-write-wins at the file level; there is no cross-process locking in this phase.

`findActive()` reports sessions whose status is `in_progress` or `blocked` over the existing schema statuses (`in_progress`, `blocked`, `completed`, `unknown`); it invents no new lifecycle states.

## Planned CLI shape

```text
spider-web session list
spider-web session capture claude
spider-web session inspect <session-id>
spider-web session export <session-id> [--output project.spider-egg] [--confirm-sensitive]
spider-web session import <file.spider-egg>
spider-web session delete <session-id>
spider-web session handoff <id-or-egg> [--confirm-sensitive]
spider-web session continue <file.spider-egg> --agent codex [--confirm-sensitive]
```

`continue` will prepare a handoff and tell the user exactly how it enters the target agent. It must not imply a native resume unless that adapter declares and verifies native resume support. The executable name `spider-web` is provisional pending an npm registry check; network access to npm was unavailable during Phase 0. A project with the same name exists on GitHub in an unrelated domain, so the README and package metadata must clearly identify this project.

## Phase 0 documents

- [Architecture](ARCHITECTURE.md)
- [Resolved 0.1 decisions](DECISIONS.md)
- [Protocol draft](PROTOCOL.md)
- [Adapter boundary](ADAPTERS.md)
- [Security model](SECURITY.md)
- [Contribution guide](CONTRIBUTING.md)
- [Agent research](docs/agents/)

## License

Not selected yet.
