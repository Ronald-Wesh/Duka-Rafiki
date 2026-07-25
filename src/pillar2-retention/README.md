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
| `types.ts` | P2's own types, plus temporary ledger mirrors (see below) | no |
| `customer-profile.ts` | EAT date bucketing, name normalisation, profile building | no |
| `repeat-detection.ts` | windowing, repeat-visit detection, ranking, weekly summary | no |
| `promo-drafts.ts` | phrasing + promo drafting, with a deterministic fallback | **yes** |
| `../core/prompts/p2-retention.v1.ts` | versioned prompts (README §11) | no |

## How to call it

```ts
import { buildRegularsSummary, detectRepeatVisit } from './pillar2-retention/repeat-detection';
import { draftRegularsSummary, draftWinBackPromo } from './pillar2-retention/promo-drafts';

// --- Demo beat 1: an SMS just landed, is this customer a returning face? ---
const visit = detectRepeatVisit(allTransactions, customerId, newTxn.created_at);
// -> { isRepeat: true, visitNumber: 4, previousVisitDate: '2026-07-22' }

// --- Demo beat 3: the weekly message ---
const summary = buildRegularsSummary(customers, allTransactions, {
  asOfDateKey: '2026-07-26',   // EAT, always passed in — never Date.now()
});
const weekly = await draftRegularsSummary(summary, claude);  // omit `claude` for offline text
const promo  = await draftWinBackPromo(summary, 'sukari punguzo kidogo wiki hii', claude);

// weekly.source === 'claude' | 'deterministic-fallback'
// weekly.rejectedReason is set when Claude's phrasing was rejected — see below
```

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

## Status

Working, unverified. Honest state of things:

- The deterministic logic is complete and written to be unit-testable offline.
- **Nothing has been compiled or run yet.** There is no `package.json` or
  `tsconfig.json` in the repo — those are P0's to create (README §7), and I'm not
  going to squat on shared surface area. Node isn't installed on my machine
  either. Expect a first-compile round of small type fixes.
- No tests yet. The pure functions are the easy win once a test runner exists.

### What I need from teammates

- **P0** — `package.json` + `tsconfig.json`, and `src/core/claude-client.ts`. If
  it satisfies the `LanguageModel` interface in `promo-drafts.ts`, this pillar
  wires up with no changes.
- **P0** — seed data (`demo/seed-data.ts`) with named payers spread across
  several weeks. I specifically need: one customer who visits twice in one day
  (proves visits aren't double-counted), one who lapses mid-period (proves the
  promo trigger fires), and one name in two casings (proves duplicate detection
  fires).
- **P1** — `src/core/types.ts` with `Customer` and `Transaction`. Until then,
  `types.ts` mirrors README §8 under a clearly marked `LEDGER MIRRORS` heading.
  **Those mirrors are a stand-in, not a fork** — delete them and switch to the
  import the moment the real types land. If they ever disagree with
  `schema.sql`, `schema.sql` is right.
- **P1** — confirmation that bare `created_at` values are UTC. If P1 writes local
  EAT strings instead, `toEatDateKey` would double-shift and every visit count
  would be subtly wrong. This is the assumption most likely to bite us.
