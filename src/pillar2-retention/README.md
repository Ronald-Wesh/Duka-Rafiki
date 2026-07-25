# P2 — Retention

Owner: **Person B** (`@arthuradinder`)

Builds customer profiles from parsed payer names, detects repeat visits, and
generates the weekly "your regulars" summary plus a draftable win-back promo.

Covers demo beat 1 (a forwarded Buy Goods SMS shows "Mary is back — 4th visit")
and beat 3 (the weekly regulars message with a promo) from README §12.

---

## Contract

Per README §9, P2 **reads `transactions` and `customers`. It writes nothing.**

- No writes to `daily_reconciliations` or `statements` — those are P1's and P3's.
- No writes to `customers` either. Duplicate payer names are **reported**, never
  merged — see [Duplicate names](#duplicate-names).
- Every module here is a pure function of its arguments. No DB handle, no global
  state, no clock reads. The "as of" date is always passed in, which is what
  makes the weekly message reproducible when the demo is re-run on stage.
- Only `promo-drafts.ts` touches Claude, and only for wording (README §5).

## Files

| File | Role | Network? |
|---|---|---|
| `types.ts` | P2's own output types; re-exports ledger types from `core/types.ts` | no |
| `customer-profile.ts` | EAT date bucketing, name normalisation, profile building | no |
| `repeat-detection.ts` | windowing, repeat-visit detection, ranking, weekly summary | no |
| `promo-drafts.ts` | phrasing + promo drafting, with a deterministic fallback | **yes** |
| `../core/prompts/regulars-summary.md` | system prompt for the weekly message | no |
| `../core/prompts/draft-promo.md` | system prompt for the win-back promo | no |

These three files replace P0's `getCustomerProfile` / `detectRepeatVisits` /
`draftPromo` placeholders, which threw `not implemented — P2`. Nothing on `main`
referenced those names, so no caller breaks. The signatures changed on purpose:
the placeholders took ids and window sizes, whereas these take ledger rows and
return the figures the message needs, so a caller never has to re-query to turn
an id back into something the owner would recognise.

## How to call it

```ts
import { askClaude } from '../core/claude-client';
import { buildRegularsSummary, detectRepeatVisit } from './repeat-detection';
import { draftRegularsSummary, draftWinBackPromo } from './promo-drafts';

// --- Demo beat 1: an SMS just landed, is this customer a returning face? ---
const visit = detectRepeatVisit(allTransactions, customerId, newTxn.created_at);
// -> { isRepeat: true, visitNumber: 4, previousVisitDate: '2026-07-22' }

// --- Demo beat 3: the weekly message ---
const summary = buildRegularsSummary(customers, allTransactions, {
  asOfDateKey: '2026-07-26',   // EAT, always passed in — never Date.now()
});
const weekly = await draftRegularsSummary(summary, askClaude);
const promo  = await draftWinBackPromo(summary, 'sukari punguzo kidogo wiki hii', askClaude);

// weekly.source === 'claude' | 'deterministic-fallback'
// weekly.rejectedReason is set when Claude's phrasing was rejected — see below
```

`askClaude` is injected rather than imported inside `promo-drafts.ts` on purpose:
importing `core/claude-client` constructs an `Anthropic` client as a side effect,
so importing P2 would otherwise demand an API key. **Omit the last argument
entirely** and every function returns deterministic text with no network call —
which is how these functions are testable, and how the demo survives a dead
tunnel.

Pass the **full, unwindowed** ledger to `buildRegularsSummary`; it windows
internally. It needs full history to tell "hasn't come this week" from
"hasn't come in three weeks".

## Definitions (deliberate, and worth arguing with)

These choices decide every number in the weekly message, so they are stated
rather than buried in the code:

- **A visit is a distinct EAT calendar day** on which the customer transacted.
  Three purchases in one afternoon is one visit — that's what the owner means by
  "how often they come".
- **Timezone matters.** Kenya is UTC+03:00 with no DST. Bare SQLite `DATETIME`
  values are treated as UTC and shifted, because bucketing by UTC day would file
  evening sales under the wrong date and inflate visit counts. All bucketing goes
  through `toEatDateKey`.
- **Spend counts `sale` + `deni`** (value of goods taken). `deni_repayment` is
  excluded — it pays for goods already counted under `deni`, and counting both
  would double-count. `restock` is the owner buying stock.
- **A visit for counting purposes** includes `deni_repayment`: she came in.
- **A regular** is `visitCount >= 2` (`REPEAT_VISIT_THRESHOLD`).
- **Lapsing** is a regular unseen for `>= 10` days (`LAPSED_AFTER_DAYS`) —
  longer than the 7-day window so someone who simply hasn't come *yet this week*
  isn't flagged as drifting away.
- **Ranking** is visits desc → spend desc → recency desc → name asc. The name
  tiebreak makes it fully deterministic.
- **Anonymous cash is invisible to P2.** Rows with `customer_id = null` cannot be
  attributed, so `namedCustomerSpend` is *not* the shop's total sales. P1 owns
  that figure and P2 must never be quoted as if it were.
- **Unconfirmed rows are included by default**, because retention is advisory —
  but every profile and summary carries `includesUnconfirmed` so the distinction
  is visible. The strict unconfirmed-entry rule governs the **statement** (P3),
  not this pillar.

## Why Claude's output gets checked

`promo-drafts.ts` computes the message deterministically first, then optionally
asks Claude to phrase it. Before the phrased version is used,
`assertFiguresPreserved` confirms every computed figure still appears verbatim.
If anything was dropped, rounded, or invented, the deterministic text is sent
instead and `rejectedReason` records why.

Two consequences worth knowing:

1. **The demo works with no API key.** Every function returns sendable text with
   the model argument omitted. A dead network at 3am degrades the wording, not
   the flow.
2. **A fluent message with a wrong number cannot reach the owner.** That is the
   failure mode README §5 exists to prevent, enforced in code rather than trusted.

## Duplicate names

M-Pesa payer names arrive inconsistently — `MARY WANJIKU`, `Mary Wanjiku`,
`mary  wanjiku.` — and each spelling would otherwise become a separate
"customer", fragmenting the very list this pillar exists to build.

`findDuplicateCandidates` reports likely-same-person pairs and stops there.
Merging is a write to `customers`, which is P1's alone. Pairs already separated
by different disambiguators are returned flagged `disambiguated: true`, since
"Mary - blue uniform" and "Mary - shop next door" are probably two real people
the owner separated on purpose.

Open question for P1: who resolves these — a bot prompt to the owner, or a manual
fix? P2 can surface them either way.

## Verifying it

```bash
npx tsc --noEmit                                    # clean
npx ts-node src/pillar2-retention/smoke-check.ts    # 43/43 checks pass
```

`smoke-check.ts` is a known-answer check: every figure is asserted against a
hand-computed expected value, and it runs offline with no API key and no
database. It pins the decisions listed above — the same-day double visit, the
`deni` / `deni_repayment` distinction, the EAT day boundary, the excluded
anonymous sale, and the figure-preservation guard — so a regression in the
retention arithmetic fails there instead of quietly on stage.

It is not a substitute for a real test suite. `package.json` has no test runner
and adding one is a shared-surface decision, so this is the interim. If the team
adds `vitest` or wires up `node:test`, these cases port over directly.

**It earned its keep immediately:** it caught `figuresToPreserve` requiring the
aggregate `namedCustomerSpend`, a figure the message never prints — which meant
the guard rejected its own fallback text and would have rejected every valid
Claude phrasing, silently forcing the plain path 100% of the time. Typechecking
could never have found that.

## Status

Compiles clean under `strict: true` and passes its own checks. Caveats worth
knowing:

- The 43 checks cover the deterministic arithmetic thoroughly and the model seam
  with fakes. **Nothing here has run against a real Claude call or a real SQLite
  row** — only against fixtures.
- Not yet wired into the webhook. `src/webhook/router.ts` is P0's, and the
  weekly-summary trigger needs a decision about *when* it fires (cron? an owner
  asking? a demo command?) that isn't mine to make alone.
- `npm install` needs `--ignore-scripts` on Node 24 — see below.

### Two heads-ups for P0 (both outside my folder, so not fixed here)

**1. `better-sqlite3@11` won't install on current Node LTS.** Node 24 has no
prebuilt binary for it, so `npm install` drops to `node-gyp` and fails without
Python and MSVC build tools. I got a working install with
`npm install --ignore-scripts`, which is fine for typechecking but leaves the
native module unbuilt — so it won't actually open a database. Bumping to
`better-sqlite3@^12` (which ships Node 24 prebuilds) or pinning the team to Node
22 both fix it. Worth settling before someone hits it at 3am.

**2. `loadPrompt()` breaks in the built output.** It resolves prompts relative to
`__dirname`, so `npm run dev` (ts-node, `__dirname` = `src/core`) finds the `.md`
files, but `npm run build && npm start` will not — `tsc` doesn't copy `.md` into
`dist/`. This will bite whoever runs built output on stage. A `copyfiles`/`cpx`
step in `build`, or anchoring the path outside `__dirname`, both work.

### What I still need from teammates

- **P1** — confirmation that bare `created_at` values are stored **UTC**. If P1
  writes local EAT strings instead, `toEatDateKey` double-shifts and every visit
  count is subtly wrong. This is the assumption most likely to bite us, and it
  fails quietly rather than loudly.
- **P0/P1** — seed data (`demo/seed-data.ts`) with named payers across several
  weeks. Three cases specifically exercise this pillar: one customer who visits
  **twice in one day** (proves visits aren't double-counted), one who **lapses
  mid-period** (proves the promo trigger fires), and one name in **two casings**
  (proves duplicate detection fires).
- **P1** — a decision on who resolves duplicate candidates, per
  [Duplicate names](#duplicate-names). P2 can surface them; only P1 can merge.
