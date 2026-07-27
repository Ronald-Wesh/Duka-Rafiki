Versioned prompt files, one per task. Loaded with `loadPrompt(name)` from
`../claude-client.ts` — call `askClaude("draft-promo", input)` or
`askClaudeJson<T>("parse-transaction", input)`. Tune the file once and every
pillar benefits. **Never inline a prompt string in pillar code** (README §11).

| File | Used by | Returns |
|---|---|---|
| `parse-mpesa-sms.md` | P1 | `ParsedMpesaSms` \| `ParseError` |
| `parse-transaction.md` | P1 | `ParsedTransaction` \| `ParseError` |
| `draft-promo.md` | P2 | message text |
| `phrase-summary.md` | P3 | plain-text summary |

Types are in `../types.ts`. Use `isParseError()` before trusting a parsed shape.

## Conventions

**Parse prompts return `{"error": "reason"}` rather than guessing.** A wrong
amount enters the ledger silently and corrupts the day's takings; an error is
recoverable. `needs_review: true` on `ParsedTransaction` means "saved, but
unconfirmed" — the caller should store `confirmed = 0`.

**Extraction runs at `temperature: 0`** (the client default). Only pass a higher
temperature where wording should genuinely vary, e.g. `draft-promo`.

**The model never computes a number.** Prompts say so explicitly and refuse
rather than multiply — `soda mbili 50` returns an error instead of guessing 100.
All arithmetic is deterministic code in the pillars (README §5). When adding or
editing a prompt, keep that boundary; it's what makes every figure on stage
auditable.

**No scoring language, anywhere.** `phrase-summary.md` forbids score / band /
rating / creditworthy / eligible and any lend-or-not recommendation. We are not
an FSP; the output is a descriptive record. `npm run check:prompts` guards this
across the codebase.

## Not written yet

`parse-ledger-photo.md` — the stretch photo-backfill path. Needs per-line
confidence flagging and a verification loop before it's demo-safe.
