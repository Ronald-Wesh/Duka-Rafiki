-- single source of truth for tables (P1 owns changes)

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT,                 -- from M-Pesa SMS payer name, or manually tagged
  phone TEXT,                -- nullable, often unavailable from SMS
  disambiguator TEXT,        -- e.g. "blue uniform" for duplicate names
  first_seen DATETIME,
  last_seen DATETIME
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),  -- nullable for anonymous cash
  type TEXT CHECK(type IN ('sale','deni','deni_repayment','restock')),
  amount REAL NOT NULL,
  channel TEXT CHECK(channel IN ('mpesa_buygoods','cash')),
  confirmed INTEGER DEFAULT 0,  -- 0 = self-reported/unconfirmed, 1 = owner-confirmed
  raw_input TEXT,               -- original message/SMS text, for audit + reparse
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_reconciliations (
  id INTEGER PRIMARY KEY,
  date DATE NOT NULL,
  expected_total REAL,        -- sum of logged transactions
  reported_total REAL,        -- owner-confirmed total at day close
  variance REAL,
  notes TEXT
);

-- Descriptive statement record. NOT a score. No band, no rating.
CREATE TABLE IF NOT EXISTS statements (
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
