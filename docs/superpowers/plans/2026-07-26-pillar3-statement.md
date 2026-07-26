# P3 Statement Pillar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn ledger data into a shareable one-page HTML transaction record the kiosk owner sends to a lender from WhatsApp.

**Architecture:** Five modules in `src/pillar3-statement/`, split at the data edge — SQL in one file, pure arithmetic in another with no runtime imports, Claude phrasing in a third, HTML/SVG string building in a fourth, orchestration and the Express route in `index.ts`. Generation computes everything once and stores a full snapshot in `statements.summary_json`; viewing is a single-row read with no recomputation.

**Tech Stack:** TypeScript (CommonJS), Express 4, better-sqlite3, `@anthropic-ai/sdk`, ts-node. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-26-pillar3-statement-design.md`

## Global Constraints

- **No score, band, rating, or creditworthiness.** Those four words appear nowhere in code, comments, HTML, or prompts. The artifact is a "transaction record".
- **The model never computes a number that appears in the statement.** It receives computed figures and phrases them.
- **P3 writes only the `statements` table.** It reads `transactions`, `customers`, `daily_reconciliations`. Never INSERT/UPDATE those three.
- **Every day-bucketing query uses `date(created_at, '+3 hours')`.** `created_at` is UTC; `daily_reconciliations.date` is a Nairobi calendar date. Kenya has no DST, so fixed +3 is correct year-round.
- **`RECONCILIATION_TOLERANCE_KES = 50`** — a named exported constant, never a literal inside a query.
- **`statement-metrics.ts` has no runtime imports.** `import type` only.
- Money renders as `KES 1,250`. Rates render as whole percentages.
- Branch: `pillar3-statement`. Commit after every task.

---

### Task 1: Fixture seed — 28 days of ledger history

Nothing in P3 can be seen working until data exists. `demo/seed-data.ts` inserts 2 rows dated today; a 28-day statement over that renders an empty page. This task also installs dependencies, since nothing runs without them.

**Files:**
- Create: `demo/seed-statement.ts`
- Modify: `package.json` (add `seed:statement` script)

**Interfaces:**
- Consumes: `src/core/db` (default export `db`, named export `initDb`)
- Produces: a populated `./duka.db` — ~28 days of `transactions`, ~10 `customers`, ~24 `daily_reconciliations` rows. Every later task reads this.

- [ ] **Step 1: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` appears, no errors. `better-sqlite3` compiles a native binding — if it fails, you need build tools (`sudo apt install build-essential python3`).

- [ ] **Step 2: Write the seed script**

Create `demo/seed-statement.ts`:

```ts
import db, { initDb } from "../src/core/db";

// P3 fixture seed. 28 days of realistic kiosk activity so the statement has
// something to describe before P1's parsing lands.
//
// Deterministic on purpose: a seeded PRNG, never Math.random(), so every run
// produces identical figures and the demo is reproducible.

const DAYS = 28;
const TOLERANCE_KES = 50;

// mulberry32 — small, seeded, good enough for fixtures.
function makeRng(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260726);

const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)];

const CUSTOMERS = [
  "Mary Wanjiku", "John Kamau", "Grace Achieng", "Peter Otieno", "Faith Njeri",
  "Samuel Mwangi", "Esther Adhiambo", "Daniel Kiptoo", "Lucy Waithera", "Brian Omondi",
];

const ITEMS = ["unga", "maziwa", "mkate", "sukari", "sabuni", "mafuta", "chai", "mchele"];

/** Nairobi local date, `offset` days before today, as YYYY-MM-DD. */
function nairobiDate(offset: number): string {
  const ms = Date.now() + 3 * 3600_000 - offset * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A Nairobi wall-clock time on `date` expressed as the UTC string SQLite stores. */
function utcFor(date: string, hour: number, minute: number): string {
  const utcMs = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`)
    - 3 * 3600_000;
  return new Date(utcMs).toISOString().slice(0, 19).replace("T", " ");
}

initDb();

// Demo database — wipe and rebuild so runs are reproducible.
db.exec(`
  DELETE FROM statements;
  DELETE FROM daily_reconciliations;
  DELETE FROM transactions;
  DELETE FROM customers;
`);

const insertCustomer = db.prepare(
  `INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen)
   VALUES (?, NULL, NULL, ?, ?)`
);
const insertTxn = db.prepare(
  `INSERT INTO transactions (customer_id, type, amount, channel, confirmed, raw_input, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const insertRecon = db.prepare(
  `INSERT INTO daily_reconciliations (date, expected_total, reported_total, variance, notes)
   VALUES (?, ?, ?, ?, ?)`
);

const oldest = nairobiDate(DAYS - 1);
const customerIds = CUSTOMERS.map(
  (name) => Number(insertCustomer.run(name, `${oldest} 08:00:00`, `${nairobiDate(0)} 18:00:00`).lastInsertRowid)
);

// Days the owner logged nothing. A real trader misses days, and this is what
// makes the "logged N of M days" note mean something.
const SKIPPED = new Set([nairobiDate(19), nairobiDate(12), nairobiDate(5)]);

let seededDays = 0;

db.transaction(() => {
  for (let offset = DAYS - 1; offset >= 0; offset--) {
    const date = nairobiDate(offset);
    if (SKIPPED.has(date)) continue;
    seededDays++;

    const isWeekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    const saleCount = isWeekend ? randInt(9, 12) : randInt(6, 9);
    let expected = 0;

    for (let i = 0; i < saleCount; i++) {
      const amount = randInt(2, 24) * 25; // KES 50-600, realistic kiosk basket
      const onMpesa = rng() < 0.45;
      const customerId = onMpesa ? pick(customerIds) : null;
      const at = utcFor(date, randInt(7, 19), randInt(0, 59));

      insertTxn.run(
        customerId,
        "sale",
        amount,
        onMpesa ? "mpesa_buygoods" : "cash",
        onMpesa ? 1 : 0, // M-Pesa SMS is its own receipt; cash stays self-reported
        `seed: ${pick(ITEMS)} ${amount}/-`,
        at
      );
      expected += amount;
    }

    // Deni roughly twice a week, always to a named customer.
    if (rng() < 0.3) {
      const amount = randInt(2, 12) * 50;
      insertTxn.run(
        pick(customerIds), "deni", amount, "cash", 0,
        `seed: deni ${amount}/-`, utcFor(date, randInt(9, 18), randInt(0, 59))
      );
    }

    // Repayments, slightly rarer than deni, so receivables stay outstanding.
    if (rng() < 0.22) {
      const amount = randInt(2, 10) * 50;
      insertTxn.run(
        pick(customerIds), "deni_repayment", amount, "cash", 1,
        `seed: amelipa deni ${amount}/-`, utcFor(date, randInt(9, 18), randInt(0, 59))
      );
      expected += amount;
    }

    // Weekly stock-up on Mondays.
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) {
      const amount = randInt(20, 40) * 100;
      insertTxn.run(
        null, "restock", amount, "cash", 1,
        `seed: nimenunua stock ${amount}/-`, utcFor(date, 6, 30)
      );
    }

    // Owner closes most days. Miss a few, and let 3 land outside tolerance so
    // reconciliation accuracy is not a suspicious 100%.
    if (rng() < 0.88) {
      const drift = rng() < 0.12 ? randInt(60, 400) * (rng() < 0.5 ? -1 : 1) : randInt(-40, 40);
      const reported = expected + drift;
      insertRecon.run(date, expected, reported, reported - expected, "seed");
    }
  }
})();

const txns = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
const recons = db.prepare("SELECT COUNT(*) AS n FROM daily_reconciliations").get() as { n: number };
const within = db
  .prepare("SELECT COUNT(*) AS n FROM daily_reconciliations WHERE ABS(variance) <= ?")
  .get(TOLERANCE_KES) as { n: number };

console.log(`Seeded ${txns.n} transactions across ${seededDays} of ${DAYS} days.`);
console.log(`Closed ${recons.n} days, ${within.n} within KES ${TOLERANCE_KES}.`);
console.log(`Period: ${oldest} to ${nairobiDate(0)}`);
```

- [ ] **Step 3: Add the npm script**

In `package.json`, inside `"scripts"`, after the existing `"seed"` line:

```json
    "seed:statement": "ts-node demo/seed-statement.ts",
```

- [ ] **Step 4: Run the seed and verify the shape of the data**

Run: `npm run seed:statement`

Expected output, roughly (exact counts are deterministic but depend on today's weekday):
```
Seeded ~230 transactions across 25 of 28 days.
Closed ~22 days, ~19 within KES 50.
Period: 2026-06-29 to 2026-07-26
```

Sanity-check the three things later tasks depend on:

```bash
npx ts-node -e "
const db = require('./src/core/db').default;
console.log(db.prepare(\"SELECT type, COUNT(*) n, ROUND(SUM(amount)) total FROM transactions GROUP BY type\").all());
console.log(db.prepare(\"SELECT COUNT(DISTINCT date(created_at,'+3 hours')) days FROM transactions\").get());
console.log(db.prepare('SELECT COUNT(*) closed FROM daily_reconciliations').get());
"
```

Expected: all four types present (`sale`, `deni`, `deni_repayment`, `restock`); ~25 distinct days; ~22 closed days. If `days` is 28 or 1, the timezone helper is wrong — fix before moving on.

- [ ] **Step 5: Commit**

```bash
git add demo/seed-statement.ts package.json
git commit -m "feat(P3): deterministic 28-day fixture seed

Unblocks P3 from P1. Seeded PRNG so figures are identical every run.
Mixed cash/M-Pesa, deni and repayments, weekly restock, 3 skipped days,
~22 closed reconciliation days with a few outside tolerance.

Built with Claude Code."
```

---

### Task 2: `statement-queries.ts` — read the ledger

**Files:**
- Create: `src/pillar3-statement/statement-queries.ts`

**Interfaces:**
- Consumes: `src/core/db` (default export `db`)
- Produces:
  - `interface DailyTotal { date: string; total: number }`
  - `interface ClosedDay { date: string; variance: number }`
  - `interface LedgerAggregates` (fields below)
  - `function fetchAggregates(periodStart: string, periodEnd: string): LedgerAggregates`
  - `function defaultPeriod(days?: number): { periodStart: string; periodEnd: string }`

  Task 3 consumes `LedgerAggregates`. Task 6 calls `fetchAggregates` and `defaultPeriod`.

- [ ] **Step 1: Write the file**

Create `src/pillar3-statement/statement-queries.ts`:

```ts
import db from "../core/db";

// All P3 SQL lives here. Raw aggregates only — no derived figures, no rates,
// no notes. Arithmetic belongs in statement-metrics.ts so it stays testable
// without a database.
//
// transactions.created_at is UTC; daily_reconciliations.date is a Nairobi
// calendar date. Every bucketing query must convert. Kenya has no DST.
const NAIROBI_DATE = "date(created_at, '+3 hours')";

export interface DailyTotal {
  date: string;
  total: number;
}

export interface ClosedDay {
  date: string;
  variance: number;
}

export interface LedgerAggregates {
  periodStart: string;
  periodEnd: string;
  daysInPeriod: number;
  totals: {
    sale: number;
    restock: number;
    deni: number;
    deni_repayment: number;
  };
  /** Sales the owner has not confirmed. Reported, never silently counted as verified. */
  unconfirmedSales: number;
  /** Sparse — only days with at least one sale. */
  dailySales: DailyTotal[];
  /** Only days the owner actually closed. */
  closedDays: ClosedDay[];
}

/** The last `days` Nairobi calendar days, ending today. */
export function defaultPeriod(days = 28): { periodStart: string; periodEnd: string } {
  const nairobiNow = Date.now() + 3 * 3600_000;
  const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    periodStart: toDate(nairobiNow - (days - 1) * 86_400_000),
    periodEnd: toDate(nairobiNow),
  };
}

export function fetchAggregates(periodStart: string, periodEnd: string): LedgerAggregates {
  if (periodStart > periodEnd) {
    throw new Error(`periodStart ${periodStart} is after periodEnd ${periodEnd}`);
  }

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'sale' THEN amount END), 0) AS sale,
         COALESCE(SUM(CASE WHEN type = 'restock' THEN amount END), 0) AS restock,
         COALESCE(SUM(CASE WHEN type = 'deni' THEN amount END), 0) AS deni,
         COALESCE(SUM(CASE WHEN type = 'deni_repayment' THEN amount END), 0) AS deni_repayment,
         COALESCE(SUM(CASE WHEN type = 'sale' AND confirmed = 0 THEN amount END), 0) AS unconfirmed_sales
       FROM transactions
       WHERE ${NAIROBI_DATE} BETWEEN ? AND ?`
    )
    .get(periodStart, periodEnd) as {
    sale: number;
    restock: number;
    deni: number;
    deni_repayment: number;
    unconfirmed_sales: number;
  };

  const dailySales = db
    .prepare(
      `SELECT ${NAIROBI_DATE} AS date, COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE type = 'sale' AND ${NAIROBI_DATE} BETWEEN ? AND ?
       GROUP BY 1
       ORDER BY 1`
    )
    .all(periodStart, periodEnd) as DailyTotal[];

  const closedDays = db
    .prepare(
      `SELECT date, variance
       FROM daily_reconciliations
       WHERE date BETWEEN ? AND ? AND reported_total IS NOT NULL
       ORDER BY date`
    )
    .all(periodStart, periodEnd) as ClosedDay[];

  const daysInPeriod =
    Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;

  return {
    periodStart,
    periodEnd,
    daysInPeriod,
    totals: {
      sale: totals.sale,
      restock: totals.restock,
      deni: totals.deni,
      deni_repayment: totals.deni_repayment,
    },
    unconfirmedSales: totals.unconfirmed_sales,
    dailySales,
    closedDays,
  };
}
```

- [ ] **Step 2: Verify against the seeded database**

Run:

```bash
npx ts-node -e "
const q = require('./src/pillar3-statement/statement-queries');
const p = q.defaultPeriod();
const a = q.fetchAggregates(p.periodStart, p.periodEnd);
console.log('period', a.periodStart, '->', a.periodEnd, 'days', a.daysInPeriod);
console.log('totals', a.totals);
console.log('unconfirmed', a.unconfirmedSales);
console.log('sale days', a.dailySales.length, 'closed days', a.closedDays.length);
"
```

Expected: `days 28`; all four totals greater than 0; `unconfirmed` greater than 0 but less than `totals.sale`; `sale days` ~25; `closed days` ~22.

Then check the guard:

```bash
npx ts-node -e "
require('./src/pillar3-statement/statement-queries').fetchAggregates('2026-07-26','2026-07-01')
" 2>&1 | head -2
```

Expected: `Error: periodStart 2026-07-26 is after periodEnd 2026-07-01`

- [ ] **Step 3: Commit**

```bash
git add src/pillar3-statement/statement-queries.ts
git commit -m "feat(P3): ledger aggregate queries

All P3 SQL in one file. Nairobi date bucketing via date(created_at,'+3 hours')
since created_at is UTC and daily_reconciliations.date is local.

Built with Claude Code."
```

---

### Task 3: `statement-metrics.ts` — the six figures (TDD)

The only task with real logic risk. Test first — it costs three minutes and these are the numbers going on a projector.

**Files:**
- Create: `src/pillar3-statement/statement-metrics.test.ts`
- Modify: `src/pillar3-statement/statement-metrics.ts` (replace P0's stub entirely)
- Modify: `package.json` (add `test:p3` script)

**Interfaces:**
- Consumes: `LedgerAggregates`, `DailyTotal` from Task 2 — **type-only imports**
- Produces:
  - `const RECONCILIATION_TOLERANCE_KES = 50`
  - `interface StatementBreakdown { row: Omit<Statement,"id"|"generated_at">; dailySales: DailyTotal[]; daysWithActivity: number; daysInPeriod: number; daysClosed: number; deniRepaymentRate: number; unconfirmedSales: number }`
  - `function computeStatementMetrics(agg: LedgerAggregates): StatementBreakdown`

  Task 5 and Task 6 consume `StatementBreakdown`.

- [ ] **Step 1: Write the failing test**

Create `src/pillar3-statement/statement-metrics.test.ts`:

```ts
import assert from "assert";
import { computeStatementMetrics, RECONCILIATION_TOLERANCE_KES } from "./statement-metrics";
import type { LedgerAggregates } from "./statement-queries";

function aggregates(over: Partial<LedgerAggregates> = {}): LedgerAggregates {
  return {
    periodStart: "2026-07-01",
    periodEnd: "2026-07-30",
    daysInPeriod: 30,
    totals: { sale: 50_000, restock: 20_000, deni: 4_000, deni_repayment: 1_000 },
    unconfirmedSales: 12_000,
    dailySales: Array.from({ length: 26 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      total: 1_000,
    })),
    closedDays: [
      { date: "2026-07-01", variance: 0 },
      { date: "2026-07-02", variance: -30 },
      { date: "2026-07-03", variance: 200 },
      { date: "2026-07-04", variance: 45 },
    ],
    ...over,
  };
}

// Known input -> exact expected figures.
{
  const b = computeStatementMetrics(aggregates());
  assert.strictEqual(b.row.total_sales, 50_000);
  assert.strictEqual(b.row.estimated_margin, 30_000, "sales 50k less restock 20k");
  assert.strictEqual(b.row.outstanding_receivables, 3_000, "deni 4k less repaid 1k");
  assert.strictEqual(b.deniRepaymentRate, 0.25);
  assert.strictEqual(b.row.reconciliation_accuracy, 0.75, "3 of 4 closed days within 50");
  assert.strictEqual(b.daysWithActivity, 26);
  assert.strictEqual(b.daysClosed, 4);
  assert.strictEqual(b.unconfirmedSales, 12_000);
  assert.strictEqual(
    b.row.cashflow_consistency_note,
    "Sales logged on 26 of 30 days in this period."
  );
  assert.strictEqual(b.row.period_start, "2026-07-01");
  assert.strictEqual(b.row.period_end, "2026-07-30");
}

// A variance of exactly the tolerance counts as within it.
{
  const b = computeStatementMetrics(
    aggregates({
      closedDays: [
        { date: "2026-07-01", variance: RECONCILIATION_TOLERANCE_KES },
        { date: "2026-07-02", variance: -RECONCILIATION_TOLERANCE_KES },
      ],
    })
  );
  assert.strictEqual(b.row.reconciliation_accuracy, 1, "boundary is inclusive");
}

// Empty period: zeros everywhere, no throw, no NaN.
{
  const b = computeStatementMetrics(
    aggregates({
      totals: { sale: 0, restock: 0, deni: 0, deni_repayment: 0 },
      unconfirmedSales: 0,
      dailySales: [],
      closedDays: [],
    })
  );
  assert.strictEqual(b.row.total_sales, 0);
  assert.strictEqual(b.row.estimated_margin, 0);
  assert.strictEqual(b.row.outstanding_receivables, 0);
  assert.strictEqual(b.deniRepaymentRate, 0, "no deni means 0, never NaN");
  assert.strictEqual(b.row.reconciliation_accuracy, 0, "no closed days means 0, never NaN");
  assert.strictEqual(
    b.row.cashflow_consistency_note,
    "Sales logged on 0 of 30 days in this period."
  );
}

// Repayments can exceed outstanding deni; receivables floor at zero, never negative.
{
  const b = computeStatementMetrics(
    aggregates({ totals: { sale: 100, restock: 0, deni: 500, deni_repayment: 900 } })
  );
  assert.strictEqual(b.row.outstanding_receivables, 0);
}

// Restock can exceed sales in a heavy stock-up period. Margin goes negative,
// which is the honest figure — do not clamp it.
{
  const b = computeStatementMetrics(
    aggregates({ totals: { sale: 1_000, restock: 4_000, deni: 0, deni_repayment: 0 } })
  );
  assert.strictEqual(b.row.estimated_margin, -3_000);
}

console.log("statement-metrics: all assertions passed");
```

- [ ] **Step 2: Add the test script and run it to verify it fails**

In `package.json` `"scripts"`:

```json
    "test:p3": "ts-node src/pillar3-statement/statement-metrics.test.ts",
```

Run: `npm run test:p3`

Expected: FAIL. P0's stub throws `Error: not implemented — P3`, and `RECONCILIATION_TOLERANCE_KES` is not exported.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `src/pillar3-statement/statement-metrics.ts`:

```ts
import type { Statement } from "../core/types";
import type { DailyTotal, LedgerAggregates } from "./statement-queries";

// P3 owns this. Pure function of ledger data — no hidden state, no I/O, no
// runtime imports, so every figure is testable with a literal object.
// Descriptive record only. NO score/band (README sections 5, 9, 13).

/** A day is reconciled when the owner's count is within this many KES. */
export const RECONCILIATION_TOLERANCE_KES = 50;

export interface StatementBreakdown {
  /** Exactly the statements table columns, ready to insert. */
  row: Omit<Statement, "id" | "generated_at">;
  dailySales: DailyTotal[];
  daysWithActivity: number;
  daysInPeriod: number;
  daysClosed: number;
  /** 0-1. Lives in summary_json; the table has no column for it. */
  deniRepaymentRate: number;
  unconfirmedSales: number;
}

export function computeStatementMetrics(agg: LedgerAggregates): StatementBreakdown {
  const { sale, restock, deni, deni_repayment } = agg.totals;

  const daysWithActivity = agg.dailySales.length;
  const daysClosed = agg.closedDays.length;
  const withinTolerance = agg.closedDays.filter(
    (d) => Math.abs(d.variance) <= RECONCILIATION_TOLERANCE_KES
  ).length;

  return {
    row: {
      period_start: agg.periodStart,
      period_end: agg.periodEnd,
      total_sales: round2(sale),
      // Sales less stock purchases over the same period. Negative in a heavy
      // restock week, and that is the honest figure — not clamped.
      estimated_margin: round2(sale - restock),
      cashflow_consistency_note:
        `Sales logged on ${daysWithActivity} of ${agg.daysInPeriod} days in this period.`,
      outstanding_receivables: round2(Math.max(0, deni - deni_repayment)),
      // Denominator is days the owner actually closed. A day never closed is
      // not a failed reconciliation — it shows up in the consistency note above.
      reconciliation_accuracy: daysClosed === 0 ? 0 : round2(withinTolerance / daysClosed),
      summary_json: "", // filled by index.ts once the narrative exists
    },
    dailySales: agg.dailySales,
    daysWithActivity,
    daysInPeriod: agg.daysInPeriod,
    daysClosed,
    deniRepaymentRate: deni === 0 ? 0 : round2(deni_repayment / deni),
    unconfirmedSales: round2(agg.unconfirmedSales),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:p3`

Expected: `statement-metrics: all assertions passed`

- [ ] **Step 5: Check the figures against real seeded data**

Run:

```bash
npx ts-node -e "
const q = require('./src/pillar3-statement/statement-queries');
const m = require('./src/pillar3-statement/statement-metrics');
const p = q.defaultPeriod();
const b = m.computeStatementMetrics(q.fetchAggregates(p.periodStart, p.periodEnd));
console.log(b.row);
console.log('deni rate', b.deniRepaymentRate, 'unconfirmed', b.unconfirmedSales);
"
```

Expected: `total_sales` in the tens of thousands; `reconciliation_accuracy` between 0.8 and 1 but **not** exactly 1; the note reading "Sales logged on ~25 of 28 days". If accuracy is exactly 1, the seed's drift branch never fired — check Task 1.

- [ ] **Step 6: Commit**

```bash
git add src/pillar3-statement/statement-metrics.ts src/pillar3-statement/statement-metrics.test.ts package.json
git commit -m "feat(P3): statement metrics with assert-based tests

Pure function, type-only imports, so the figures are testable without a DB.
Tolerance is a named constant. Accuracy denominator is closed days only.
Covers empty period, zero deni, tolerance boundary, negative margin.

Built with Claude Code."
```

---

### Task 4: `statement-html.ts` — the report page

**Files:**
- Create: `src/pillar3-statement/statement-html.ts`

**Interfaces:**
- Consumes: `Statement` from `../core/types` (type-only), `DailyTotal` from Task 2 (type-only)
- Produces:
  - `interface StatementSnapshot { metrics: Omit<Statement,"id"|"generated_at">; dailySales: DailyTotal[]; daysWithActivity: number; daysInPeriod: number; daysClosed: number; deniRepaymentRate: number; unconfirmedSales: number; narrative: string }`
  - `function renderStatementPage(statement: Statement): string`

  Task 6 writes `StatementSnapshot` into `summary_json` and calls `renderStatementPage`.

- [ ] **Step 1: Write the file**

Create `src/pillar3-statement/statement-html.ts`:

```ts
import type { Statement } from "../core/types";
import type { DailyTotal } from "./statement-queries";

// Server-rendered HTML. No template engine, no chart library, no new
// dependency. Print CSS included so the owner can save a PDF from the
// browser if a lender wants a file.

/** The full snapshot stored in statements.summary_json at generation time. */
export interface StatementSnapshot {
  metrics: Omit<Statement, "id" | "generated_at">;
  dailySales: DailyTotal[];
  daysWithActivity: number;
  daysInPeriod: number;
  daysClosed: number;
  deniRepaymentRate: number;
  unconfirmedSales: number;
  narrative: string;
}

const kes = (n: number) =>
  `KES ${n.toLocaleString("en-KE", { maximumFractionDigits: 0 })}`;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One bar per day of sales. Raw SVG, no chart library. */
function salesChart(daily: DailyTotal[]): string {
  if (daily.length === 0) {
    return `<p class="muted">No sales logged in this period.</p>`;
  }

  const width = 680;
  const height = 140;
  const gap = 2;
  const max = Math.max(...daily.map((d) => d.total));
  const barWidth = Math.max(2, (width - gap * (daily.length - 1)) / daily.length);

  const bars = daily
    .map((d, i) => {
      const barHeight = max === 0 ? 0 : Math.max(1, (d.total / max) * (height - 20));
      const x = i * (barWidth + gap);
      const y = height - barHeight;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1"><title>${d.date}: ${kes(d.total)}</title></rect>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart" role="img"
         aria-label="Daily sales from ${daily[0].date} to ${daily[daily.length - 1].date}">
      ${bars}
    </svg>
    <div class="chart-axis"><span>${daily[0].date}</span><span>peak ${kes(max)}</span><span>${daily[daily.length - 1].date}</span></div>`;
}

export function renderStatementPage(statement: Statement): string {
  const snapshot = JSON.parse(statement.summary_json) as StatementSnapshot;
  const m = snapshot.metrics;

  const rows: Array<[string, string]> = [
    ["Total sales", kes(m.total_sales)],
    ["Estimated margin (sales less stock purchases)", kes(m.estimated_margin)],
    ["Outstanding receivables (deni owed to the trader)", kes(m.outstanding_receivables)],
    ["Deni repayment rate", pct(snapshot.deniRepaymentRate)],
    ["Days reconciled within KES 50", pct(m.reconciliation_accuracy)],
    ["Days with logged activity", `${snapshot.daysWithActivity} of ${snapshot.daysInPeriod}`],
  ];

  const tableRows = rows
    .map(([label, value]) => `<tr><td>${label}</td><td class="num">${value}</td></tr>`)
    .join("");

  const accuracyNote =
    snapshot.daysClosed === 0
      ? `<p class="muted">No days were closed in this period, so no reconciliation figure is available.</p>`
      : `<p class="muted">Based on ${snapshot.daysClosed} day${snapshot.daysClosed === 1 ? "" : "s"} the owner closed and counted.</p>`;

  const unconfirmedNote =
    snapshot.unconfirmedSales > 0
      ? `<p class="muted">Of total sales, ${kes(snapshot.unconfirmedSales)} is self-reported and not yet confirmed.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transaction Record — ${m.period_start} to ${m.period_end}</title>
<style>
  :root { color-scheme: light; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 28px 20px; color: #16181d; background: #f6f7f9; }
  main { max-width: 720px; margin: 0 auto; background: #fff; padding: 32px;
         border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -.01em; }
  .period { color: #5b6270; margin: 0 0 24px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 20px; }
  td { padding: 11px 0; border-bottom: 1px solid #eceef1; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em;
       color: #5b6270; margin: 28px 0 8px; }
  .chart { width: 100%; height: auto; }
  .chart rect { fill: #2f6f4f; }
  .chart-axis { display: flex; justify-content: space-between;
                font-size: 12px; color: #5b6270; margin-top: 6px; }
  .muted { color: #5b6270; font-size: 14px; margin: 6px 0; }
  .summary { background: #f2f6f4; border-left: 3px solid #2f6f4f;
             padding: 14px 16px; border-radius: 0 6px 6px 0; margin: 8px 0 0; }
  footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid #eceef1;
           font-size: 12px; color: #6b7280; }
  @media print {
    body { background: #fff; padding: 0; }
    main { box-shadow: none; padding: 0; max-width: none; }
  }
</style>
</head>
<body>
<main>
  <h1>Transaction Record</h1>
  <p class="period">${m.period_start} to ${m.period_end} &middot; generated ${escapeHtml(statement.generated_at)}</p>

  <table>${tableRows}</table>

  <h2>Daily sales</h2>
  ${salesChart(snapshot.dailySales)}
  <p class="muted">${escapeHtml(m.cashflow_consistency_note)}</p>
  ${accuracyNote}
  ${unconfirmedNote}

  <h2>Summary</h2>
  <p class="summary">${escapeHtml(snapshot.narrative)}</p>

  <footer>
    This is a record of transactions logged by the trader over the stated period.
    It is a descriptive record, not an assessment, and every figure above is
    computed directly from the underlying entries.
  </footer>
</main>
</body>
</html>`;
}
```

- [ ] **Step 2: Render a page from real data and eyeball it**

Run:

```bash
npx ts-node -e "
const fs = require('fs');
const q = require('./src/pillar3-statement/statement-queries');
const mm = require('./src/pillar3-statement/statement-metrics');
const h = require('./src/pillar3-statement/statement-html');
const p = q.defaultPeriod();
const b = mm.computeStatementMetrics(q.fetchAggregates(p.periodStart, p.periodEnd));
const snapshot = {
  metrics: b.row, dailySales: b.dailySales, daysWithActivity: b.daysWithActivity,
  daysInPeriod: b.daysInPeriod, daysClosed: b.daysClosed,
  deniRepaymentRate: b.deniRepaymentRate, unconfirmedSales: b.unconfirmedSales,
  narrative: 'Placeholder summary for layout checking.',
};
const html = h.renderStatementPage({ ...b.row, id: 1, generated_at: '2026-07-26 02:00:00', summary_json: JSON.stringify(snapshot) });
fs.writeFileSync('/tmp/statement-preview.html', html);
console.log('wrote /tmp/statement-preview.html', html.length, 'bytes');
"
xdg-open /tmp/statement-preview.html
```

Expected: a card with the six figures right-aligned, a green bar chart with roughly 25 bars of varying height, the consistency note, the unconfirmed line, and the footer disclaimer. Check the page for the words "score", "band", "rating" — there should be none:

```bash
grep -icE 'credit score|\bband\b|rating|creditworth' /tmp/statement-preview.html
```

Expected: `0`

- [ ] **Step 3: Commit**

```bash
git add src/pillar3-statement/statement-html.ts
git commit -m "feat(P3): HTML statement report with inline SVG chart

Server-rendered string, no template engine or chart library. Print CSS so
the browser can produce a PDF. StatementSnapshot is the summary_json shape.

Built with Claude Code."
```

---

### Task 5: `statement-narrative.ts` — Claude phrases the figures

**Files:**
- Create: `src/core/prompts/statement-summary.md`
- Create: `src/pillar3-statement/statement-narrative.ts`

**Interfaces:**
- Consumes: `askClaude` from `../core/claude-client`, `StatementBreakdown` from Task 3
- Produces: `function phraseSummary(b: StatementBreakdown): Promise<string>`

  Task 6 calls it.

- [ ] **Step 1: Write the prompt file**

Create `src/core/prompts/statement-summary.md`:

```markdown
<!-- v1 — owner: P3. Used by pillar3-statement/statement-narrative.ts -->

You write the summary paragraph of a Kenyan kiosk owner's transaction record —
a document she may show a SACCO or a lender. You are handed figures that have
already been computed. You are a writer, not a calculator.

Return plain text only. No JSON, no markdown, no headings, no bullet points.

Rules:
- EVERY number you write must appear verbatim in the JSON you were given.
  Never add, subtract, average, round, or infer a figure. If a number is not
  in the input, it does not go in the paragraph.
- 3 to 4 sentences, under 90 words. Clear plain English — this one is read by
  a lender, not by the owner, so do not code-switch here.
- Format money as "KES 1,250" and rates as whole percentages.
- Describe what the record shows. Do not evaluate, recommend, approve, or
  predict. Never say the trader is reliable, creditworthy, low-risk, or a good
  borrower.
- The words "credit score", "band", "rating", and "creditworthiness" are
  forbidden.
- If some sales are unconfirmed, say so plainly in one clause.
- If no days were closed, say the reconciliation figure is unavailable rather
  than calling it 0%.
```

- [ ] **Step 2: Write the module**

Create `src/pillar3-statement/statement-narrative.ts`:

```ts
import { askClaude } from "../core/claude-client";
import type { StatementBreakdown } from "./statement-metrics";

// The model is handed computed figures and asked only to phrase them
// (README section 5). It never calculates anything that appears here.

const kes = (n: number) => `KES ${n.toLocaleString("en-KE", { maximumFractionDigits: 0 })}`;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * Deterministic fallback. A statement must always generate — the paragraph is
 * decoration, the figures are the product. Used when Claude is slow, rate
 * limited, or the API key is missing on demo night.
 */
export function templateSummary(b: StatementBreakdown): string {
  const parts = [
    `Between ${b.row.period_start} and ${b.row.period_end}, this trader logged ${kes(b.row.total_sales)} in sales across ${b.daysWithActivity} of ${b.daysInPeriod} days.`,
    `Stock purchases over the same period leave an estimated margin of ${kes(b.row.estimated_margin)}.`,
    b.row.outstanding_receivables > 0
      ? `Customer credit outstanding stands at ${kes(b.row.outstanding_receivables)}, with ${pct(b.deniRepaymentRate)} of credit extended repaid so far.`
      : `No customer credit is outstanding at the end of the period.`,
    b.daysClosed === 0
      ? `No days were closed and counted, so a reconciliation figure is not available.`
      : `Of the ${b.daysClosed} days closed and counted, ${pct(b.row.reconciliation_accuracy)} matched the logged total within KES 50.`,
  ];
  if (b.unconfirmedSales > 0) {
    parts.push(`${kes(b.unconfirmedSales)} of these sales are self-reported and not yet confirmed.`);
  }
  return parts.join(" ");
}

export async function phraseSummary(b: StatementBreakdown): Promise<string> {
  const facts = {
    period_start: b.row.period_start,
    period_end: b.row.period_end,
    total_sales_kes: b.row.total_sales,
    estimated_margin_kes: b.row.estimated_margin,
    outstanding_receivables_kes: b.row.outstanding_receivables,
    unconfirmed_sales_kes: b.unconfirmedSales,
    deni_repayment_rate_percent: Math.round(b.deniRepaymentRate * 100),
    reconciliation_accuracy_percent: Math.round(b.row.reconciliation_accuracy * 100),
    days_with_activity: b.daysWithActivity,
    days_in_period: b.daysInPeriod,
    days_closed: b.daysClosed,
  };

  try {
    const text = await askClaude("statement-summary", JSON.stringify(facts), 400);
    const clean = text.trim();
    if (clean.length === 0) return templateSummary(b);
    return clean;
  } catch (err) {
    console.error("[P3] narrative failed, using template:", err);
    return templateSummary(b);
  }
}
```

- [ ] **Step 3: Verify the fallback works with no API key**

The fallback is the path that runs if the demo goes wrong, so test it first.

Run:

```bash
npx ts-node -e "
const q = require('./src/pillar3-statement/statement-queries');
const m = require('./src/pillar3-statement/statement-metrics');
const n = require('./src/pillar3-statement/statement-narrative');
const p = q.defaultPeriod();
const b = m.computeStatementMetrics(q.fetchAggregates(p.periodStart, p.periodEnd));
console.log(n.templateSummary(b));
"
```

Expected: 4–5 grammatical sentences with real figures, no `undefined`, no `NaN`.

- [ ] **Step 4: Verify the Claude path**

Requires `ANTHROPIC_API_KEY` in `.env`. Run:

```bash
npx ts-node -e "
const q = require('./src/pillar3-statement/statement-queries');
const m = require('./src/pillar3-statement/statement-metrics');
const n = require('./src/pillar3-statement/statement-narrative');
const p = q.defaultPeriod();
const b = m.computeStatementMetrics(q.fetchAggregates(p.periodStart, p.periodEnd));
n.phraseSummary(b).then(s => console.log(s));
"
```

Expected: a 3–4 sentence paragraph. **Check every number in it appears in the metrics output from Task 3 Step 5.** If Claude invented or rounded a figure, tighten the prompt's first rule — do not accept it.

If no key is set, expect the error log followed by the template paragraph. That is correct behaviour, not a failure.

- [ ] **Step 5: Commit**

```bash
git add src/core/prompts/statement-summary.md src/pillar3-statement/statement-narrative.ts
git commit -m "feat(P3): Claude-phrased statement summary with deterministic fallback

Versioned prompt file, not an inline string. Model receives computed figures
only. templateSummary() guarantees a statement always generates if the API
call fails on demo night.

Built with Claude Code."
```

---

### Task 6: `index.ts` — orchestrate, persist, serve, wire in

**Files:**
- Create: `src/pillar3-statement/index.ts`
- Modify: `src/core/config.ts` (add `publicBaseUrl`)
- Modify: `.env.example` (add `PUBLIC_BASE_URL`)
- Modify: `src/index.ts` (mount the route)
- Modify: `src/webhook/router.ts:26-29` (replace the P3 TODO)

**Interfaces:**
- Consumes: `fetchAggregates`, `defaultPeriod` (Task 2); `computeStatementMetrics` (Task 3); `renderStatementPage`, `StatementSnapshot` (Task 4); `phraseSummary` (Task 5)
- Produces:
  - `function generateStatement(periodStart?, periodEnd?): Promise<{ id: number; url: string; summary: string }>`
  - `const statementRouter: Router` serving `GET /statement/:id`

  P0's `router.ts` calls `generateStatement`. P0's `src/index.ts` mounts `statementRouter`.

- [ ] **Step 1: Add `publicBaseUrl` to config**

In `src/core/config.ts`, add one line inside the `config` object, after `dbPath`:

```ts
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
```

In `.env.example`, after the `DB_PATH` line:

```
# ngrok tunnel URL — used to build the statement link sent over WhatsApp
PUBLIC_BASE_URL=http://localhost:3000
```

`config.ts` is P0's shared surface (README §10). This is additive and breaks nothing, but say so in the PR.

- [ ] **Step 2: Write the orchestrator**

Create `src/pillar3-statement/index.ts`:

```ts
import { Router, Request, Response } from "express";
import db from "../core/db";
import { config } from "../core/config";
import type { Statement } from "../core/types";
import { defaultPeriod, fetchAggregates } from "./statement-queries";
import { computeStatementMetrics } from "./statement-metrics";
import { phraseSummary } from "./statement-narrative";
import { renderStatementPage, StatementSnapshot } from "./statement-html";

// P3 public surface. P0 calls generateStatement() from the webhook router and
// mounts statementRouter in src/index.ts.
//
// P3 writes the statements table and nothing else.

export interface GeneratedStatement {
  id: number;
  url: string;
  summary: string;
}

export async function generateStatement(
  periodStart?: string,
  periodEnd?: string
): Promise<GeneratedStatement> {
  const period =
    periodStart && periodEnd ? { periodStart, periodEnd } : defaultPeriod();

  const breakdown = computeStatementMetrics(
    fetchAggregates(period.periodStart, period.periodEnd)
  );
  const narrative = await phraseSummary(breakdown);

  // The whole snapshot is stored, so viewing recomputes nothing and the
  // document stays identical no matter how the ledger grows afterwards.
  const snapshot: StatementSnapshot = {
    metrics: breakdown.row,
    dailySales: breakdown.dailySales,
    daysWithActivity: breakdown.daysWithActivity,
    daysInPeriod: breakdown.daysInPeriod,
    daysClosed: breakdown.daysClosed,
    deniRepaymentRate: breakdown.deniRepaymentRate,
    unconfirmedSales: breakdown.unconfirmedSales,
    narrative,
  };

  const info = db
    .prepare(
      `INSERT INTO statements
         (period_start, period_end, total_sales, estimated_margin,
          cashflow_consistency_note, outstanding_receivables,
          reconciliation_accuracy, summary_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      breakdown.row.period_start,
      breakdown.row.period_end,
      breakdown.row.total_sales,
      breakdown.row.estimated_margin,
      breakdown.row.cashflow_consistency_note,
      breakdown.row.outstanding_receivables,
      breakdown.row.reconciliation_accuracy,
      JSON.stringify(snapshot)
    );

  const id = Number(info.lastInsertRowid);
  return { id, url: `${config.publicBaseUrl}/statement/${id}`, summary: narrative };
}

export const statementRouter = Router();

statementRouter.get("/statement/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).send("Invalid statement id");
    return;
  }

  const statement = db
    .prepare("SELECT * FROM statements WHERE id = ?")
    .get(id) as Statement | undefined;

  if (!statement) {
    res.status(404).send("Statement not found");
    return;
  }

  res.type("html").send(renderStatementPage(statement));
});

export default statementRouter;
```

- [ ] **Step 3: Mount the route**

In `src/index.ts`, add the import next to the existing `webhookRouter` import:

```ts
import { statementRouter } from "./pillar3-statement";
```

and mount it directly after `app.use(webhookRouter);`:

```ts
app.use(statementRouter);
```

- [ ] **Step 4: Wire the WhatsApp keyword**

In `src/webhook/router.ts`, replace lines 26–29:

```ts
  if (text === "nataka report") {
    // TODO(P3): generate statement, return link/summary
    return "Report generation not wired up yet.";
  }
```

with:

```ts
  if (/\b(ripoti|report|statement|taarifa)\b/.test(text)) {
    const { generateStatement } = await import("../pillar3-statement");
    const statement = await generateStatement();
    return `${statement.summary}\n\n${statement.url}`;
  }
```

`router.ts` is P0's file. This is the hook README §12 step 4 requires — flag it in the PR. The dynamic `import` keeps P3 out of the startup path, so a P3 error can never stop the server booting.

- [ ] **Step 5: Generate a statement end to end**

Run:

```bash
npx ts-node -e "
require('./src/pillar3-statement').generateStatement().then(s => console.log(s));
"
```

Expected: `{ id: 1, url: 'http://localhost:3000/statement/1', summary: '...' }`

- [ ] **Step 6: Serve it and check the page**

Run the server:

```bash
npm run dev
```

In another terminal:

```bash
curl -s localhost:3000/health
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/statement/1
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/statement/9999
curl -s localhost:3000/statement/1 | grep -icE 'credit score|\bband\b|rating|creditworth'
```

Expected: `{"ok":true}`, then `200`, then `404`, then `0`.

Open `http://localhost:3000/statement/1` in a browser. Confirm the figures match Task 3 Step 5, and that `Ctrl+P` shows a clean single-page print preview with no card shadow.

- [ ] **Step 7: Commit**

```bash
git add src/pillar3-statement/index.ts src/core/config.ts .env.example src/index.ts src/webhook/router.ts
git commit -m "feat(P3): statement generation, persistence and GET /statement/:id

Stores the full snapshot in summary_json so viewing recomputes nothing and
the record is immutable. Adds config.publicBaseUrl, mounts statementRouter,
and hooks the ripoti/report keyword in P0's webhook router via dynamic
import so P3 can never block server startup.

Built with Claude Code.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Demo hardening

Everything works. This is the pass that keeps it working at 3:25am in front of judges.

**Files:**
- Modify: `demo/demo-script.md`
- Modify: `docs/data-model.md`

**Interfaces:**
- Consumes: everything above
- Produces: no code, documentation only

- [ ] **Step 1: Full cold-run from a clean database**

```bash
rm -f duka.db && npm run seed:statement && npm run test:p3
npx ts-node -e "require('./src/pillar3-statement').generateStatement().then(s=>console.log(s.url))"
```

Expected: seed counts, `all assertions passed`, a URL. Any failure here is a failure on stage.

- [ ] **Step 2: Verify the empty-database case does not crash**

```bash
rm -f /tmp/empty.db
DB_PATH=/tmp/empty.db npx ts-node -e "
require('./src/pillar3-statement').generateStatement().then(s => console.log('ok', s.id, '|', s.summary));
"
```

Expected: a statement generates with zero figures and a sentence saying no days were closed. No throw, no `NaN`, no `undefined`. Then restore the seeded database: `npm run seed:statement`.

- [ ] **Step 3: Record the P3 section in `docs/data-model.md`**

Append:

```markdown
## statements (P3)

Written only by P3, in `src/pillar3-statement/index.ts`.

`summary_json` holds a `StatementSnapshot` (see `statement-html.ts`): the metrics
row, the daily sales series behind the chart, day counts, the deni repayment rate,
the unconfirmed sales total, and the narrative paragraph. The whole snapshot is
written at generation time so `GET /statement/:id` recomputes nothing and an
issued record never changes as the ledger grows.

Two figures live only in `summary_json` because the table has no column for them:
`deniRepaymentRate` and `unconfirmedSales`.

Reconciliation accuracy counts only days with a non-null `reported_total`.
Tolerance is `RECONCILIATION_TOLERANCE_KES = 50`, exported from
`statement-metrics.ts`. **P1 should import that constant rather than redefining
it** — if the two drift, the statement and the daily close will disagree on stage.
```

- [ ] **Step 4: Write the P3 beat of the demo script**

Append to `demo/demo-script.md`:

```markdown
## P3 — the statement (README §12 step 4)

**Owner types:** `nataka ripoti`

**Bot replies:** the summary paragraph, then the link.

**Presenter opens the link on the projector and says:**
- "This is a transaction record, not a score. Every number here is computed from
  entries she logged on WhatsApp."
- Point at the bar chart: "twenty-five of twenty-eight days logged — that is the
  cash-flow consistency a lender cannot see today."
- Point at reconciliation accuracy: "she closed twenty-two days and matched her
  own count within fifty shillings on most of them."
- Point at the unconfirmed line: "we never present self-reported cash as verified."

**Pre-flight, do this at 2am not 3:25:**
1. `npm run seed:statement`
2. Generate one statement and leave the tab open as a fallback
3. Confirm `PUBLIC_BASE_URL` is the live ngrok URL, not localhost, or the link
   the phone receives will be dead
4. Send `nataka ripoti` from the demo phone once, end to end

**If Claude is slow or down:** the paragraph falls back to a deterministic
template. Figures are unaffected. Nobody watching can tell.
```

- [ ] **Step 5: Commit and push**

```bash
git add demo/demo-script.md docs/data-model.md
git commit -m "docs(P3): demo script beat, data model notes, cold-run verified

Built with Claude Code."
git push -u origin pillar3-statement
```

- [ ] **Step 6: Open the PR and flag shared-surface changes**

The PR description must name the three files outside P3's folder, so nobody is surprised at merge:

- `src/core/config.ts` — added `publicBaseUrl` (additive)
- `src/index.ts` — mounted `statementRouter` (one line)
- `src/webhook/router.ts` — replaced the P3 TODO with the `ripoti` handler

And one ask for P1: import `RECONCILIATION_TOLERANCE_KES` from
`statement-metrics.ts` instead of defining a second tolerance, and confirm that
day-close writes `reported_total` — without it, live reconciliation accuracy
reads 0% no matter how good the seeded history looks.

---

## Open dependency on P1

P3 is complete and demoable on its own after Task 7. Two things only P1 can supply:

1. **Live transactions.** Until parsing lands, the statement describes seeded history only. The demo still works; the numbers just are not from tonight's messages.
2. **`reported_total` at day close.** The seed writes `daily_reconciliations` directly. If P1's `reconcileDay()` never persists a reported total, reconciliation accuracy over live-only data is 0%.

Neither blocks any task in this plan.
