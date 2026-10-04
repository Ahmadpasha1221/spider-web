# Contributing

Spider Web is in Phase 0 design. Contributions should preserve the product boundary: a provider-neutral local protocol, not another coding agent.

## Before proposing an adapter

1. Add a research note under `docs/agents/` with primary sources, date checked, stable/unstable claims, and explicit unknowns.
2. Separate documented API behavior from observations of private local storage.
3. Include sanitized, redistributable fixtures and a license/provenance note before proposing parser behavior.
4. List fields that cannot be captured and avoid inferred claims without provenance.
5. Never include real user transcripts, credentials, source code, or identifiers in issues and fixtures.

When implementation starts, the planned stack is TypeScript/Node.js with ESLint, Prettier, Vitest, and a build step. Exact versions and scripts are intentionally not pinned until Phase 1 setup.
