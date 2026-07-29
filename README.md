# Duka Ledger (WhatsApp Business Companion)

Shared instruction set for Claude Code across this repo. **Every team member has
Claude Code read this file first in any session.** Keep it updated if scope changes
— stale instructions are worse than none.

Built for the Claude Community Nairobi "AI Mashinani" overnight hackathon.
Track: **Biashara (Small Business)**.

---

## 1. Project in one paragraph

A WhatsApp-only companion for Kenyan kiosk owners (persona: "Mama Njeri") who use
Pochi la Biashara / Buy Goods tills and cash, and have no POS. The bot turns daily
sales logging into three outcomes from one shared ledger: (1) **reconciliation** of
expected vs. reported sales, (2) a **retention list** built passively from M-Pesa
payment SMS (which already contain payer names), and (3) an exportable, explainable
**financial statement** the owner can show a SACCO or digital lender. Reconciliation
is the spine; retention and the statement are downstream consumers of the same
ledger data. It lives where the trader already is — WhatsApp. No app to download.

**Beneficiary (locked):** This helps a cash-based micro-trader — one of the 7.4
million MSMEs that make up 98% of Kenyan businesses — who today has no financial
statement to show a lender, because their business exists only in memory and loose
cash.

## 2. Persona (do NOT redesign mid-hackathon)

Mama Njeri — grocery/general kiosk owner, 2+ years in business, accepts Pochi la
Biashara / Buy Goods + cash. Recognizes ~10–15 regulars by face but can't name or
reach them in bulk. Gives informal *deni* (credit) to a few trusted customers.
Wants to expand but has no bank-usable proof of business viability. Low phone
storage — WhatsApp is the only acceptable interface. **Never suggest a native app
or new install.**

## 3. Scope — what's in, what's out

### Core (must work live)
- **Primary input: forwarded M-Pesa Buy Goods/Pochi SMS + manual cash entries**,
  in English/Swahili/Sheng code-switched text or voice.
- Parse SMS into `{amount, payer_name, till, timestamp}`; parse free-text/voice
  sales into structured transactions.
- **Reconciliation** — daily close: expected (sum of logged) vs. owner-reported
  total, with variance.
- **Retention** — customer profiles built passively from SMS payer names; repeat-
  visit detection; weekly "your regulars" summary + draftable promo message.
- **Debt tracking by name** — tag a sale as *deni* to a named customer (not phone
  number); disambiguator field for duplicate names (e.g. "Mary - blue uniform").
- **Financial statement generator** — compiles confirmed transactions into a
  lender-readable document: sales volume, estimated margin, day-to-day cash-flow
  consistency, outstanding receivables (deni), reconciliation accuracy.

### Optional / stretch (kept in code, NOT load-bearing for the demo)
- **Paper-ledger photo backfill** — Claude vision reads a photographed handwritten
  page into a structured table, for onboarding history. Highest-risk parse, so it
  is a bonus path, never a demo dependency. When used, it gets **per-line
  confidence flagging** (ambiguous digits, shorthand like "50/-", "2 mnd", faded/
  overlapping entries flagged individually), a **verification loop** (bot returns
  the clean version with flagged lines marked; owner corrects only flagged lines
  in plain language, e.g. "line 3 is 56"), and the **unconfirmed-entry rule**:
  entries never confirmed are excluded from the statement or marked "self-reported,
  unconfirmed" — never silently treated as verified.

### Explicitly cut tonight (state out loud if asked)
- **Any numeric credit score, band, or creditworthiness rating.** We are not a
  licensed financial-service provider. The output is a **transaction record /
  financial statement** — descriptive figures over a stated date range, clearly
  labelled as a record. The words "credit score", "band", "rating",
  "creditworthiness" appear **nowhere** in product, schema, or pitch.
- Photo capture of loose products for general inventory (open-ended recognition risk).
- User auth / multi-tenant — single demo shopkeeper is enough.
- Real lender/SACCO API integration — the statement itself is the artifact, not a
  live loan pipeline.

### Long-term roadmap (say this is where the statement becomes primary)
- Accumulated statements mature from "a few weeks of receipts" into portable,
  trader-owned financial history — not gatekept by one lender.
- Partnership model, not lending model: plug statement output into existing
  microfinance / chama / SACCO underwriting rather than scoring ourselves.
- Loose-product photo inventory revisited once there's time to validate it properly.

## 4. The pillars + who owns what

| Pillar | Owner | Core job |
|---|---|---|
| P1 — Reconciliation | Person A | Ingest M-Pesa SMS forwards + manual cash entries; parse into transactions; run daily reconciliation; **own the shared ledger schema** |
| P2 — Retention | Person B | Build customer profiles from parsed payer names; detect repeat visits; generate weekly "your regulars" summaries + draftable promos |
| P3 — Statement | Person C | Compute the descriptive statement metrics from ledger data; generate the PDF/shareable report |
| P0 — Platform/Infra | Person D | WhatsApp webhook, message router, shared Claude client, DB setup, demo seed data, deploy/glue |

Pillars 1–3 all read/write the **same shared ledger tables** (P1's schema). Do not
fork the data model — extend via migration, and flag schema changes to the team
before merging.

## 5. Architecture principle (non-negotiable)

The model does **language**: parse SMS/voice/text, extract handwriting (stretch),
phrase summaries and promos. All **arithmetic and records** are deterministic code:
running totals, variance, margins, received-vs-paid balances, every figure in the
statement. **The model is never asked to compute a number that appears in the
statement** — it is handed computed numbers and asked only to phrase them. This
keeps every figure on stage correct and auditable, and keeps the statement metrics
inspectable (a requirement, not a preference — "explainable record" is core to the pitch).

## 6. Tech stack (keep it boring — it's a hackathon)

- **Interface**: **Twilio WhatsApp sandbox** (chosen — faster to demo, no business
  verification). Do not also build the Meta Cloud API path.
- **Backend**: Node.js + Express (or Fastify). TypeScript preferred; plain JS fine
  under time pressure.
- **AI**: Anthropic API (Claude) for: parsing free-text/voice into structured
  transactions, parsing forwarded M-Pesa SMS into `{amount, payer_name, till,
  timestamp}`, drafting promos, phrasing summaries, and (stretch) ledger-photo
  extraction.
- **DB**: SQLite for the demo (file-based, easy to seed and reset). No Postgres
  unless someone already has it running — speed over correctness.
- **Reports**: `pdfkit`, or `puppeteer` rendering an HTML template — or a clean
  shareable HTML page if PDF eats too much time. A pre-designed template populated
  with confirmed numbers is acceptable and looks identical on stage.
- **Hosting for demo**: ngrok (or similar) tunnel for the webhook. No production deploy.
- **Local testing**: `npm install && npm run dev` starts both the bot (:3000) and the
  Next console (:3001) from one command — open `http://localhost:3001`. Bypasses ngrok
  and Meta entirely. A no-build fallback page also lives at `http://localhost:3000/test`.
- **Deploy**: `vercel.json` deploys the console only; the bot stays local because the
  SQLite ledger needs a writable disk. Set `BOT_API_BASE` to your tunnel URL. See
  `docs/deploy.md`.
- **Language**: the bot detects English vs Swahili per message and replies in the same
  language — write either.

## 7. Repo structure (build inside these folders; don't restructure without discussion)

```
/src
  /webhook          # P0: WhatsApp inbound/outbound, message routing
    router.ts
    whatsapp-client.ts
  /core             # P0 + shared: DB access, Claude client, shared types, prompts
    db.ts
    claude-client.ts
    types.ts          # Transaction, Customer, ReconciliationResult, Statement
    config.ts
    /prompts          # versioned prompt files — NOT inline strings
  /pillar1-reconciliation   # P1
    parse-transaction.ts
    parse-mpesa-sms.ts
    reconcile.ts
  /pillar2-retention        # P2
    customer-profile.ts
    repeat-detection.ts
    promo-drafts.ts
  /pillar3-statement        # P3
    statement-metrics.ts     # descriptive, inspectable — NO score/band
    report-generator.ts      # PDF/HTML statement
  /pillar-optional          # stretch: paper-ledger backfill
    parse-ledger-photo.ts
  /db
    schema.sql          # single source of truth for tables
    migrations/
/demo
  seed-data.ts           # 3-4 weeks of mock SMS + cash, Swahili/Sheng phrasing
  demo-script.md         # exact WhatsApp conversation flow for the live demo
/docs
  architecture.md
  data-model.md
.env.example
CLAUDE.md               # this file
README.md
```

## 8. Shared data model (P1 owns changes)

```sql
-- db/schema.sql
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT,                 -- from M-Pesa SMS payer name, or manually tagged
  phone TEXT,                -- nullable, often unavailable from SMS
  disambiguator TEXT,        -- e.g. "blue uniform" for duplicate names
  first_seen DATETIME,
  last_seen DATETIME
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),  -- nullable for anonymous cash
  type TEXT CHECK(type IN ('sale','deni','deni_repayment','restock')),
  amount REAL NOT NULL,
  channel TEXT CHECK(channel IN ('mpesa_buygoods','cash')),
  confirmed INTEGER DEFAULT 0,  -- 0 = self-reported/unconfirmed, 1 = owner-confirmed
  raw_input TEXT,               -- original message/SMS text, for audit + reparse
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE daily_reconciliations (
  id INTEGER PRIMARY KEY,
  date DATE NOT NULL,
  expected_total REAL,        -- sum of logged transactions
  reported_total REAL,        -- owner-confirmed total at day close
  variance REAL,
  notes TEXT
);

-- Descriptive statement record. NOT a score. No band, no rating.
CREATE TABLE statements (
  id INTEGER PRIMARY KEY,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  period_start DATE,
  period_end DATE,
  total_sales REAL,
  estimated_margin REAL,
  cashflow_consistency_note TEXT,   -- descriptive, e.g. "sales logged 26 of 30 days"
  outstanding_receivables REAL,     -- total deni owed to the trader
  reconciliation_accuracy REAL,     -- % of days reconciled within tolerance
  summary_json TEXT                 -- plain-English breakdown for the document
);
```

Anyone adding a column: update `schema.sql` AND add a one-line note in
`docs/data-model.md`. Do not silently diverge.

## 9. Pillar interfaces (contract — keep stable)

- **P1** exposes `reconcileDay(date): ReconciliationResult` and is the **only writer**
  of `transactions` + `daily_reconciliations`.
- **P2** reads `transactions` + `customers` only. Never writes reconciliation or
  statement tables.
- **P3** reads `transactions`, `customers`, `daily_reconciliations`; writes
  `statements`. Metrics must be a **pure function of ledger data** — no hidden
  state — so they're explainable in the document and the pitch.
- If P2/P3 needs a field P1 hasn't exposed, ask P1 to add it to `types.ts` rather
  than reaching into the DB with ad-hoc queries.

## 10. Branching & workflow

- `main` — always demo-able. Nobody pushes directly.
- Branches: `pillar1-reconciliation`, `pillar2-retention`, `pillar3-statement`,
  `platform-infra` (P0).

1. Branch from `main`; work in your pillar folder only. Changes to `/core` or
   `schema.sql` are shared surface area — heads-up to the team first.
2. Small, frequent PRs into `main` — not one giant end-of-night merge. Conflicts at
   hour 20 kill demos.
3. Before merging: pull latest `main`, run the seed script, confirm your pillar
   still works against current shared types/schema.
4. P0 merges first and most often — webhook/core is everyone's foundation.
5. Sync every 2–3 hours, even a 5-minute "does main still boot" check.

## 11. Claude Code usage notes

- Claude Code is the primary way code gets written across all branches — it's the
  hackathon's build constraint. Keep it visible in commit/PR messages where "built
  with Claude Code" may matter to judging.
- Starting a session on a pillar branch: point Claude Code at this file + the
  relevant pillar folder + `core/types.ts`. Don't let it re-derive the schema.
- Keep parsing/phrasing prompts in `/src/core/prompts/` as versioned files, not
  inline strings scattered across pillars — tune once, everyone benefits.
- Statement metrics (P3) stay descriptive and inspectable — no scoring model, no
  band. Product requirement, not just style.

## 12. Demo — definition of done

One narrative, under 3 minutes:
1. A forwarded M-Pesa Buy Goods SMS auto-creates/updates a customer record (payer
   name lifted from the SMS — a clean live moment).
2. A few more seeded days of mixed cash + Buy Goods activity roll in.
3. Owner gets a weekly "your top regulars" WhatsApp message with a draftable promo.
4. Owner sends "nataka report" → bot returns a one-page PDF/link: sales trend,
   reconciliation accuracy, deni repayment rate, outstanding receivables — clearly
   labelled a **transaction record over [date range]**, with plain-English reasoning.
   **No score, no band.**

Demo discipline:
- `/demo/seed-data.ts` produces 3–4 weeks of realistic history (Swahili/Sheng
  phrasing) so the flow works on a fresh clone. Shared P0 responsibility; every
  pillar sanity-checks its piece against it before the final run.
- Pre-flight the Twilio sandbox join + ngrok tunnel well before stage time — the
  demo phone must already be joined, the tunnel must stay up. Do this at ~2 am, not 3:25.
- If demoing the optional ledger-photo path, pre-test the ONE photo at ~2 am and
  know exactly which lines flag. Never shoot a fresh page live for the first time.

## 13. Things to explicitly avoid (time sinks that don't serve the pitch)

- No native app or PWA — WhatsApp-only is the point.
- No real lender/SACCO API — the statement is the artifact, not a loan pipeline.
- No auth/multi-tenant — one demo shopkeeper.
- No ML/black-box scoring — descriptive, inspectable record wins the pitch.
- No numeric credit score or band, anywhere — we are not an FSP.
- Don't let `/core` become a bikeshed — P0 makes the call; others raise concerns via
  PR comment, not by rewriting it.
