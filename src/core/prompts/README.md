Versioned prompt files, one per task (e.g. `parse-mpesa-sms.md`, `parse-transaction.md`,
`draft-promo.md`). Loaded via `loadPrompt()` in `claude-client.ts`. Tune once here —
every pillar that calls `askClaude("parse-mpesa-sms", ...)` benefits. Do not inline
prompt strings in pillar code.
