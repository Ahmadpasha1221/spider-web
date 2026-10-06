# Codex Research

**Checked:** 2026-10-04. **Confidence:** high for documented CLI commands; medium for local rollout format because it is visible in public source but not presented as a stable third-party import contract.

## Findings

- Codex CLI supports session continuation/resumption through Codex-owned CLI flows. Current command syntax and behavior must be rechecked against official docs at implementation time.
- The public OpenAI Codex source describes append-oriented JSONL rollout recording for later inspection/replay. Entries include session metadata and response items; event lines can represent user/assistant messages, tool calls, and outputs. The format evolves with the CLI and is not a cross-agent session import format.
- Local sessions can include prompt/context metadata and possibly sensitive tool payloads. A parser must allow new record types and version variation, cap reads, and avoid editing source files.
- Codex does not expose a supported mechanism found in this review for importing an arbitrary Spider Session into an existing Codex thread. Safe initial target is a handoff file plus user-started Codex task (e.g. pass/attach the brief). Do not write synthetic rollouts.

## Adapter implications

- Level 1 local capture may be technically possible from rollout JSONL, but mark experimental until format compatibility policy and fixtures are established.
- Native resume capability only addresses a Codex-owned session ID. It does not resume a Claude thread.
- Extract messages/tool events carefully and treat outputs as sensitive. Changes to working tree should come from independent Git inspection, not assumed from transcript tool calls.
- Spider's Phase 5 bounded runner uses the documented `codex exec --json` stream. It starts a new provider thread for cross-agent continuation, normalizes JSONL events, and appends them to the existing Spider session. The runner does not read or write private rollout files.
- The provider-mediated `on-request` approval policy is the default; `never` is available for explicitly non-interactive runs. Full application-controlled approval callbacks require the app-server transport and remain a future extension.

## Unanswered

- Is there a stable supported public API for reading/exporting local rollouts?
- Which Codex surfaces share session files/indexes, and how are archived/compressed rollouts handled?
- What documented CLI flag reliably accepts a handoff file as initial context across platform/version?

## Sources

- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [OpenAI Codex rollout recorder (public source)](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs)
- [Codex CLI resume integration tests (public source)](https://github.com/openai/codex/blob/main/codex-rs/exec/tests/suite/resume.rs)
