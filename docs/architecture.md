# Architecture

See README.md sections 5 (architecture principle) and 7 (repo structure) — this
file tracks decisions/deviations as they happen, not a restatement.

Current state: scaffold only. Webhook → router → (pillar stubs, not yet
implemented). Claude client (`src/core/claude-client.ts`) loads versioned
prompts from `src/core/prompts/` and returns text/JSON — never a computed
statement figure.
