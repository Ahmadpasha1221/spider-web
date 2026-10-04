# Cline Research

**Checked:** 2026-10-04. **Confidence:** medium; official documentation describes task semantics and local history but not a stable third-party export contract.

## Findings

- Official Cline task documentation says tasks have IDs and dedicated storage directories, full conversation history, command executions and decisions, can be resumed across sessions, and use Git-based checkpoints for file changes.
- Official docs describe local task history and resume behavior. They do not in the reviewed material define a stable external transcript schema or promise compatibility for another tool reading internal storage.
- Repository paths and internal JSON/SQLite details reported in issues/community material are implementation details and are not treated as supported API.

## Adapter implications

- Level 3 handoff is reliable baseline. File/export adapter can be considered if official schema/export documentation or a maintained SDK contract is found.
- Task content, tool output, and checkpoint state are distinct; checkpoint history is not equivalent to current working tree. Capture Git separately.
- Do not mutate Cline task DB or checkpoint data.

## Unanswered

- Is there a built-in portable task export and documented schema?
- Can Cline extension/SDK expose conversation events with tool inputs and outputs under a supported API?
- Are task snapshots readable outside Cline and versioned?

## Sources

- [Cline task management](https://docs.cline.bot/core-workflows/task-management) (current repository docs: [task-management.mdx](https://github.com/cline/cline/blob/main/docs/core-workflows/task-management.mdx))
