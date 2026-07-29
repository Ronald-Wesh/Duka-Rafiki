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
- No writes to `customers` either. `queries.ts` is the only file that touches the
  database and contains no `INSERT`, `UPDATE` or `DELETE`. Duplicate payer names
  are folded together **in memory only** — see [Duplicate names](#duplicate-names).
- Only `promo-drafts.ts` touches Claude, and only for wording (README §5).
- The calculation modules are pure: no DB handle, no global state, no clock reads.
  All impurity is concentrated in `queries.ts` (database) and `service.ts` (clock,
  model availability), which is what keeps the arithmetic testable offline.

## Files

| File | Role | DB? | Network? |
|---|---|---|---|
| `types.ts` | P2's output types; re-exports ledger types from `core/types.ts` | no | no |
| `customer-profile.ts` | EAT bucketing, timestamp/name normalisation, profiles | no | no |
| `repeat-detection.ts` | windowing, repeat-visit detection, ranking, summary | no | no |
| `promo-drafts.ts` | phrasing + promo drafting, with deterministic fallback | no | **yes** |
| `queries.ts` | **the read boundary** — SELECTs, row→type mapping | **yes** | no |
| `service.ts` | **the seam other pillars call** — ties it all together | **yes** | **yes** |
| `smoke-check.ts` | 62 known-answer checks, runs offline | no | no |
| `../core/prompts/regulars-summary.md` | system prompt for the weekly message | no | no |
| `../core/prompts/draft-promo.md` | system prompt for the win-back promo | no | no |

## How to call it

**If you're another pillar or the router, use `service.ts` and nothing else.** It
reads the ledger, computes the figures, phrases them, and hands back a message
that is already sendable:

```ts
import { getWeeklyRegularsMessage, getRepeatVisit } from '../pillar2-retention/service';

// --- Demo beat 3: the weekly regulars message + promo draft ---
const { text, promo, summary, merges } = await getWeeklyRegularsMessage();
// text  -> ready to send
// promo -> present only when a regular has actually gone quiet (a DRAFT, never sent)

// --- Demo beat 1: an SMS just landed — is this a returning face? ---
const visit = getRepeatVisit(customerId, newTxn.created_at);
// -> { isRepeat: true, visitNumber: 4, previousVisitDate: '2026-07-22' }
```

`getWeeklyRegularsMessage()` is safe with **no `ANTHROPIC_API_KEY` and no Twilio
credentials** — it falls back to plainer wording with identical figures. It never
throws on a model failure, because a summary that fails to send is worse than one
that reads a bit flat.

The pure layer is still there if you need to compute over rows you already have
(this is what `smoke-check.ts` drives):

```ts
const summary = buildRegularsSummary(customers, transactions, { asOfDateKey: '2026-07-26' });
const weekly  = await draftRegularsSummary(summary);          // omit the runner = offline
```

`askClaude` is injected rather than imported inside `promo-drafts.ts` on purpose:
importing `core/claude-client` constructs an `Anthropic` client as a side effect,
so importing P2 would otherwise demand an API key. `service.ts` resolves it
lazily, behind a key check.

## Cross-pillar sync

Two places where what P1 actually writes differs from what this pillar assumed.
Both are handled here defensively, and both have a cleaner fix upstream.

### 1. `created_at` arrives in three formats

| Writer | Example | Zone stated? | Means |
|---|---|---|---|
| P1 `parseMpesaSms` | `2026-07-25T22:00:00` | no | **EAT** |
| P1 `parseTransaction` | `2026-07-25T19:00:00.000Z` | yes | UTC |
| SQLite `CURRENT_TIMESTAMP` | `2026-07-25 19:00:00` | no | UTC |

Two of those are zone-less and mean *different things*, and a bare string can't
tell you which. P1's `parse-mpesa-sms.md` tells Claude to "assume Africa/Nairobi"
and its examples emit no suffix, so forwarded-SMS rows are naive EAT while seeded
and cash rows are naive UTC.

`queries.ts` resolves this once, at the read boundary, via
`normalizeCreatedAt(raw, naiveTimestampZone)`. Every timestamp reaching the pure
layer carries an explicit offset. Default is `'utc'` — correct for
`CURRENT_TIMESTAMP`, and harmless for the already-suffixed cash rows.

It is **wrong for M-Pesa rows**: a 22:10 EAT sale gets filed on the next day. The
effect is visible and real — the same ledger reports Peter's last visit as
`2026-07-26` under `'utc'` and `2026-07-25` under `'eat'`.

> **The actual fix is one line in P1's `parse-mpesa-sms.md`: emit
> `2026-07-25T22:00:00+03:00`.** Then every row states its own offset, this option
> stops mattering, and P3 gets the same benefit for free. Until then, `'utc'` is
> the least-wrong default because it only misfiles sales after 21:00 EAT.

### 2. P1 upserts customers on an exact name match

So one human paying twice with different M-Pesa casing — `MARY WANJIKU`, then
`Mary Wanjiku` — becomes two `customers` rows. That fragments the retention list
this pillar exists to build, and on stage it reads as a bug: the owner sees her
best customer listed twice with half her visits each.

`canonicalizeCustomers()` folds those rows together at read time, remapping
`customer_id` in an **in-memory copy**. Nothing is written. Every merge is
reported in `merges` so the collapse is auditable rather than invisible, and a row
carrying a `disambiguator` is never merged — "Mary - blue uniform" and
"Mary - shop next door" are two real people the owner separated deliberately.

> The durable fix is in P1's upsert: match on a normalised name. `normalizeName()`
> is exported from `customer-profile.ts` and ready to use. Once P1 adopts it,
> `canonicalizeCustomers` becomes a no-op.

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

Two functions, doing different jobs:

- `canonicalizeCustomers()` folds them together for presentation, in memory, so
  the weekly list shows one Mary with her real visit count. Used by default on the
  `service.ts` path; disable with `mergeDuplicateNames: false`.
- `findDuplicateCandidates()` **reports** pairs and stops. Use it for anything that
  would change stored data. Pairs separated by different disambiguators come back
  flagged `disambiguated: true`, since those are probably two real people.

Neither writes. Merging the rows for real is a write to `customers`, which is P1's
alone.

Open question for P1: who resolves these durably — a normalised upsert (my
recommendation, `normalizeName` is exported and ready), a bot prompt to the owner,
or a manual fix? P2 can surface them either way.

## Verifying it

```bash
npx tsc --noEmit                                     # clean
npx ts-node src/pillar2-retention/smoke-check.ts     #  62/62 — happy path
npx ts-node src/pillar2-retention/edge-cases.ts      # 196/196 — boundaries
npx ts-node src/pillar2-retention/db-check.ts        #  60/60 — real SQLite
```

**318 checks total**, all offline except `db-check.ts`, which needs a working
`better-sqlite3` binding (fine on the repo's pinned Node 20; on Node 24 you need
`better-sqlite3@^12`). `db-check.ts` builds its own throwaway database and deletes
it, so it never touches `duka.db`.

| Harness | Covers |
|---|---|
| `smoke-check.ts` | the happy path — is the arithmetic right? |
| `edge-cases.ts` | empty inputs, malformed and boundary timestamps, midnight/year-end/leap rollovers, float drift, ties, zero and negative amounts, non-Latin names, orphan rows, future dates, and every way the model can misbehave |
| `db-check.ts` | `queries.ts` + `service.ts` against real rows written the way P1 writes them, plus proof that P2 wrote nothing |

### Two real bugs the edge cases caught

Both were invisible to `tsc` and to the happy-path suite:

1. **`detectRepeatVisit` counted later-dated rows.** `visitNumber` was
   `sorted.length` over *all* visit days, including any dated after the visit
   being reported. Backfilled or out-of-order history — a paper-ledger import, a
   late SMS forward — would make the bot announce "your 5th visit" to someone on
   their 2nd. Now counts only days up to and including the reported visit.
2. **An empty week let Claude say anything.** With no regulars,
   `figuresToPreserve` is empty, so `assertFiguresPreserved` had nothing to match
   and accepted any prose — including a fluent message naming customers who do not
   exist. `draftRegularsSummary` now skips the model entirely when there are no
   regulars, since there is nothing to phrase and nothing to verify against.

Also fixed: `service.ts` typed the promo as `DraftResult`, hiding the
`recipients` field the function actually returns.

### Known limitation, recorded rather than assumed handled

An out-of-range **day** in a timestamp is not rejected — `new Date` rolls it over,
so `2026-02-30` silently becomes 2 March. Catching it needs a component-by-component
round-trip check. Left alone deliberately: SQLite's `DATETIME` cannot produce such a
string, so the only source would be an already-broken writer, and an out-of-range
*month* is caught. Pinned by a test so it stays a known quantity.

`smoke-check.ts` is a known-answer check: every figure is asserted against a
hand-computed expected value, and it runs offline with no API key and no
database. It pins the decisions listed above — the same-day double visit, the
`deni` / `deni_repayment` distinction, the EAT day boundary, the excluded
anonymous sale, the two cross-pillar sync behaviours, and the figure-preservation
guard — so a regression in the retention arithmetic fails there instead of quietly
on stage.

It is not a substitute for a real test suite. `package.json` has no test runner
and adding one is a shared-surface decision, so this is the interim. If the team
adds `vitest` or wires up `node:test`, these cases port over directly.

**It earned its keep immediately:** it caught `figuresToPreserve` requiring the
aggregate `namedCustomerSpend`, a figure the message never prints — which meant
the guard rejected its own fallback text and would have rejected every valid
Claude phrasing, silently forcing the plain path 100% of the time. Typechecking
could never have found that.

## Status

Compiles clean under `strict: true`, passes 62/62 of its own checks, and is wired
into the router's `regulars` intent. Caveats worth knowing:

- **The database path is now verified.** `db-check.ts` runs `queries.ts` and
  `service.ts` against a real SQLite file with rows written exactly as P1's parsers
  write them, and asserts that all four tables are byte-for-byte unchanged
  afterwards. (Done locally with `better-sqlite3@^12` installed via `--no-save`,
  because v11 has no Node 24 prebuild; `package.json` is untouched.)
- **Still unverified: the live WhatsApp round trip.** Nobody has run
  `npm run seed && npm run dev` in WSL and sent "nionyeshe wateja wangu" through
  the Twilio sandbox. Everything up to the router's return value is covered; the
  webhook → Twilio → phone leg is not.
- **No real Claude call yet.** The model seam is exercised with fakes only
  (faithful, dropping, altering, throwing, empty).
- **The weekly summary has no automatic trigger.** It fires when the owner asks
  ("nionyeshe wateja wangu"). Whether it should also fire on a schedule is a team
  decision, not mine to make alone.
- `npm install` needs `--ignore-scripts` on Node 24 — see below.

### Two heads-ups for P0 (both outside my folder, so not fixed here)

**1. `better-sqlite3@11` won't install on Node 24.** No prebuilt binary, so
`npm install` drops to `node-gyp` and fails without Python and MSVC. Node 20 (the
pinned `.nvmrc`) is fine, so this only bites anyone who ignores `nvm use` — but it
bites hard and the error names Python, not Node, so it reads like a machine
problem rather than a version problem. `better-sqlite3@^12` ships Node 24
prebuilds and fixes it; I verified v12 works on Node 24 locally, installed with
`--no-save` so `package.json` is unchanged. Your call whether to bump.

Worth knowing while you're in there: **`better-sqlite3` turns `PRAGMA
foreign_keys` ON by default.** The schema's `REFERENCES customers(id)` is
therefore enforced, so `parseMpesaSms` must create the customer before inserting
the transaction or the insert fails outright. It already does — but a future
writer that doesn't will get a hard `FOREIGN KEY constraint failed`, not a NULL.

**2. `loadPrompt()` breaks in the built output.** It resolves prompts relative to
`__dirname`, so `npm run dev` (ts-node, `__dirname` = `src/core`) finds the `.md`
files, but `npm run build && npm start` will not — `tsc` doesn't copy `.md` into
`dist/`. This will bite whoever runs built output on stage. A `copyfiles`/`cpx`
step in `build`, or anchoring the path outside `__dirname`, both work.

### What I still need from teammates

Ranked by how much damage it does if ignored.

1. **P1 — emit an explicit offset in `parse-mpesa-sms.md`.** Change the
   `timestamp` examples to `2026-07-25T22:00:00+03:00`. One line. Without it,
   every M-Pesa sale after 21:00 EAT is filed on the wrong day in my visit counts,
   and P1's own `date(created_at)` mis-buckets late-night cash the other way. It
   fails silently — the numbers just disagree and nobody knows why. This is the
   single highest-value fix on my list.
2. **P1 — upsert customers on a normalised name.** `normalizeName()` is exported
   and ready. Until then `canonicalizeCustomers` papers over it at read time, but
   the duplicate rows still accumulate in the table and P3 will hit them too.
3. **P0/P1 — real seed data.** Three cases specifically exercise this pillar: a
   customer who visits **twice in one day** (proves visits aren't double-counted),
   one who **lapses mid-period** (proves the promo trigger fires), and one name in
   **two casings** (proves canonicalisation fires). The current 2-row smoke seed
   produces a one-line summary with nothing to demo.
4. **P1 — wire `getRepeatVisit()` into the SMS path.** After `parseMpesaSms`
   writes a row, calling it turns "Nimeandika: Ksh 500 kutoka MARY WANJIKU" into
   "…— amerudi, mara ya 4". That's demo beat 1's whole payoff and it's two lines at
   P1's call site; I can't add it without writing in P1's file.
5. **Anyone — run it in WSL.** `npm run seed && npm run dev`, then send
   "nionyeshe wateja wangu". That's the one thing I cannot verify from here.
