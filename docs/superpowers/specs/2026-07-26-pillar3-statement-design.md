# P3 — Statement Pillar: Design

Date: 2026-07-26
Owner: Person C (Ronald)
Branch: `pillar3-statement`

## 1. What P3 does

Turn ledger data into a one-page **transaction record** the kiosk owner can show a
SACCO or lender. Owner sends "nataka ripoti" on WhatsApp; bot replies with a link
to an HTML page listing descriptive figures over a date range.

Not a credit score. No band, no rating, no creditworthiness judgement. The words
"credit score", "band", "rating", "creditworthiness" appear nowhere in the code,
the page, or the pitch.

## 2. Contract with the other pillars

P3 **reads** `transactions`, `customers`, `daily_reconciliations`.
P3 **writes** `statements` only. It never writes ledger tables.

Every figure is a pure function of ledger data — same ledger in, same figures out,
no hidden state. The model is never asked to compute a number that appears in the
statement; it is handed computed numbers and asked only to phrase them.

## 3. Flow

```
"nataka ripoti"
  -> generateStatement(periodStart, periodEnd)
       1. statement-queries.fetchAggregates()   SQL reads
       2. statement-metrics.compute()           pure arithmetic
       3. statement-narrative.phrase()          Claude, given final numbers
       4. INSERT INTO statements                -> id
  -> WhatsApp reply: {PUBLIC_BASE_URL}/statement/{id}

GET /statement/:id
  -> SELECT one row -> statement-html.render() -> HTML
```

`summary_json` holds the full snapshot: metrics, the daily sales series for the
chart, the narrative text, and the unconfirmed total.

Consequences, all intended:

- **The report is immutable.** A statement generated in week 3 renders identically
  in week 6 after the ledger has grown. That is what makes it a record rather than
  a live dashboard.
- **Page load does no work.** One row read. No Claude call, no aggregation. The
  projector cannot stall during the demo.
- Generate once at 2am, then reload the URL freely while styling it.

## 4. Modules

```
src/pillar3-statement/
  statement-queries.ts     all SQL, returns raw aggregates   imports: core/db
  statement-metrics.ts     all arithmetic, pure              imports: types only
  statement-narrative.ts   Claude phrasing                   imports: core/claude-client
  statement-html.ts        HTML + inline SVG strings         imports: nothing
  index.ts                 orchestrate, persist, route       imports: the above
demo/seed-statement.ts     4 weeks of fixture data
```

`statement-metrics.ts` having **no runtime imports** is the load-bearing
constraint — `import type` is fine, anything executable is not. Every
figure is then testable with a literal object and no database. That is the
"inspectable and explainable" requirement made mechanical rather than aspirational.

These three extra files sit inside P3's own folder, so this is not the
"don't restructure" case in README §7 — but flag it in the first PR.

## 5. Interfaces

```ts
// statement-queries.ts
export interface LedgerAggregates {
  periodStart: string;              // YYYY-MM-DD, Nairobi calendar
  periodEnd: string;
  daysInPeriod: number;
  totals: {
    sale: number;
    restock: number;
    deni: number;
    deni_repayment: number;
  };
  unconfirmedSales: number;         // SUM(amount) where type='sale' AND confirmed=0
  dailySales: DailyTotal[];         // sparse: only days with activity
  closedDays: ClosedDay[];          // days with a reported_total
}

export interface DailyTotal { date: string; total: number }
export interface ClosedDay { date: string; variance: number }

export function fetchAggregates(periodStart: string, periodEnd: string): LedgerAggregates;
```

```ts
// statement-metrics.ts  — type-only imports, no runtime imports
export const RECONCILIATION_TOLERANCE_KES = 50;

export interface StatementBreakdown {
  row: Omit<Statement, "id" | "generated_at">;  // exactly the DB columns
  dailySales: DailyTotal[];
  daysWithActivity: number;
  daysInPeriod: number;
  daysClosed: number;
  deniRepaymentRate: number;                    // 0-1
  unconfirmedSales: number;
}

export function computeStatementMetrics(agg: LedgerAggregates): StatementBreakdown;
```

P0's stub signature was `computeStatementMetrics(periodStart, periodEnd)`. Taking
an aggregates object instead is what buys the zero-import purity. Same exported
name, same file, and nothing calls it yet (it throws), so nothing breaks.

```ts
// statement-narrative.ts
export function phraseSummary(b: StatementBreakdown): Promise<string>;

// statement-html.ts
export function renderStatementPage(s: Statement): string;

// index.ts
export function generateStatement(periodStart: string, periodEnd: string):
  Promise<{ id: number; url: string; summary: string }>;
export const statementRouter: Router;   // GET /statement/:id
```

## 6. The figures

| Field | Formula | Notes |
|---|---|---|
| `total_sales` | `SUM(amount) WHERE type='sale'` | |
| `estimated_margin` | `SUM(sale) - SUM(restock)` | Labelled "sales less stock purchases over the period". Restock is lumpy; a long period smooths it. |
| `outstanding_receivables` | `max(0, SUM(deni) - SUM(deni_repayment))` | |
| `deni_repayment_rate` | `repaid / deni`, `0` when `deni = 0` | Lives in `summary_json`, no column exists |
| `reconciliation_accuracy` | days with `abs(variance) <= 50` ÷ days with a `reported_total` | `0` when no day is closed |
| `cashflow_consistency_note` | `"Sales logged on N of M days in this period."` | |
| unconfirmed line | `SUM(sale) WHERE confirmed=0` | Rendered as "of which KES X is self-reported and not yet confirmed" |

Rules baked in:

- **Unconfirmed entries are included in headline totals but always labelled.**
  Never silently treated as verified (README §3). Excluding them would hide most
  of a cash trader's business, since cash sales stay `confirmed=0` until day close.
- **Days the owner never closed are not failures.** They are excluded from the
  accuracy denominator and surface separately in the consistency note. Two honest
  numbers beat one blended one — a trader who logs perfectly but forgets to close
  on Sundays should not look unreliable to a lender.
- `RECONCILIATION_TOLERANCE_KES = 50` is a named exported constant, not a literal
  buried in a query.

## 7. Timezone

`created_at` defaults to `CURRENT_TIMESTAMP`, which is UTC.
`daily_reconciliations.date` is a Nairobi calendar date.

Every query that buckets or joins by day must use:

```sql
date(created_at, '+3 hours')
```

Without it, evening transactions land on the wrong day and the "logged N of M days"
figure and the reconciliation join both drift. Kenya has no DST, so a fixed +3 is
correct year-round.

## 8. Report page

Server-rendered HTML string at `GET /statement/:id`. No template engine, no chart
library, no new dependency.

Contents, in order:

1. Title: **Transaction Record**, and `Period: {start} to {end}`
2. Figures table — the six numbers above, money as `KES 1,250`
3. Daily sales bar chart — inline SVG, one bar per day, built from `dailySales`
4. Consistency note and the unconfirmed line
5. Claude's summary paragraph
6. Footer disclaimer: a descriptive record of logged transactions over the stated
   period, not an assessment; every figure computed directly from the entries

Print-friendly CSS so the owner can save it as a PDF from the browser if a lender
wants a file. That is the PDF path, for free.

## 9. Fixture seed

`demo/seed-statement.ts` — P3 does not wait for P1.

- 28 days ending today, Nairobi dates
- 6–12 transactions per day, weekday/weekend variation, 3–4 days with no activity
  (a real trader misses days — and it makes the consistency note meaningful)
- Mix: `mpesa_buygoods` sales `confirmed=1`, cash sales `confirmed=0`, weekly
  `restock`, occasional `deni` to named customers, some `deni_repayment`
- ~10 named customers so P2 has something too
- `daily_reconciliations` rows for ~24 of 28 days: most within KES 50, 2–3 with a
  real variance so accuracy is not a suspicious 100%
- Deterministic — seeded pseudo-random, not `Math.random()`, so every run produces
  the same numbers and the demo is reproducible
- Idempotent: wipe P3-seeded rows before inserting

Uses raw SQL against P1's tables. Hand it to P1 when they land, and keep the
schema in sync.

## 10. Errors and edges

| Case | Behaviour |
|---|---|
| Empty period, no transactions | All figures `0`, note reads "logged on 0 of 30 days", page renders. No crash, no divide-by-zero. |
| No day closed | `reconciliation_accuracy = 0`, page states "no days closed yet in this period" |
| `deni = 0` | rate `0`, not `NaN` |
| Claude call fails or times out | Fall back to a deterministic template sentence. **A statement must always generate** — the summary is decoration, the figures are the product. |
| `GET /statement/:id` unknown id | 404, plain message |
| `periodStart > periodEnd` | Throw before any query |

## 11. Testing

One runnable check, `src/pillar3-statement/statement-metrics.test.ts`, plain
`assert`, run with `ts-node`. No framework.

Covers: a known aggregates literal produces the exact expected six figures; the
empty-period case returns zeros without throwing; `deni = 0` gives rate `0`;
tolerance boundary — a variance of exactly 50 counts as within.

Possible because `statement-metrics.ts` has no runtime imports. No DB, no fixtures.

## 12. Dependencies on other people

| Need | From | Fallback if it does not land |
|---|---|---|
| Real transactions written by parsing | P1 | Fixture seed — already covers it |
| `reported_total` written at day close | P1 | Seed writes `daily_reconciliations` directly; live accuracy reads 0% |
| Route mounted in `src/index.ts` | P0 | `statementRouter` is self-contained; one-line `app.use()` |
| `"ripoti"` keyword routed to P3 | P0 | Expose `generateStatement()`; P0 wires it |

**Sync with Person A early** on whether day-close writes `reported_total`. If it
does not, seeded history looks right but the live demo moment does not flow into
the accuracy figure.

## 13. Explicitly out of scope

- Any score, band, rating, or creditworthiness figure
- Real lender or SACCO API integration
- Auth or multi-tenant — one demo shopkeeper
- Per-item cost tracking or true COGS margin
- Statement scheduling, emailing, or history browsing UI
