# Spider Web

**Spider Web connects AI agents. Spider Egg carries their session state.**

Spider Web is a local-first, agent-neutral interoperability layer for AI coding sessions. It is a separate project from Spider Agent, and does not require Spider Agent. Version 0.1 is in architecture and research: there are no supported capture adapters yet.

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

This repository currently contains Phase 0 decisions, architecture, protocol and research. Agent research is linked under [`docs/agents`](docs/agents/). Details derived from undocumented local storage or source code are labeled accordingly. No adapter is claimed as supported.

## Planned CLI shape

```text
spider-web session list
spider-web session capture claude
spider-web session inspect <id-or-egg>
spider-web session export <id> [--output project.spider-egg] [--confirm-sensitive]
spider-web session import <file.spider-egg>
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
