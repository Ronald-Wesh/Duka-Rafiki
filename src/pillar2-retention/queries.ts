/**
 * P2 — Retention: the read boundary.
 *
 * The only file in this pillar that touches the database, and it only ever
 * **reads**. P2 is not a writer of any table (README §9): no INSERT, no UPDATE,
 * no DELETE appears below, and none should be added. Customer identity fixes go
 * to P1's upsert; reconciliation and statement rows are P1's and P3's.
 *
 * Two responsibilities:
 *
 *   1. Turn SQLite rows into the shared `Customer` / `Transaction` types.
 *   2. Give every `created_at` an explicit UTC offset before it reaches the pure
 *      layer, so the naive-timestamp ambiguity is resolved exactly once, here,
 *      rather than guessed at in each calculation. See `normalizeCreatedAt`.
 *
 * Kept separate from the pure modules on purpose: importing `../core/db` opens
 * the SQLite file as a module side effect, so anything importing this needs a
 * real database. `customer-profile.ts`, `repeat-detection.ts` and
 * `promo-drafts.ts` deliberately do not import it, which is what keeps
 * `smoke-check.ts` runnable with no database and no API key.
 */

import db from '../core/db';
import { type NaiveTimestampZone, normalizeCreatedAt } from './customer-profile';
import type { Customer, Transaction } from './types';

export type { NaiveTimestampZone };

export interface LoadOptions {
  /**
   * How to read a `created_at` that states no offset. Defaults to `'utc'`, which
   * is correct for SQLite's `CURRENT_TIMESTAMP` and harmless for the
   * already-suffixed values P1's `parseTransaction` writes.
   *
   * It is **wrong** for P1's forwarded-SMS rows, which are naive Nairobi local
   * time — those land a day late whenever the sale happened after 21:00 EAT.
   * Flip this to `'eat'` only if the team decides SMS rows dominate; the real fix
   * is one line in `parse-mpesa-sms.md` (emit `+03:00`), after which this option
   * stops mattering.
   */
  naiveTimestampZone?: NaiveTimestampZone;
}

/** Shape better-sqlite3 hands back for a `transactions` row. */
interface TransactionRow {
  id: number;
  customer_id: number | null;
  type: string;
  amount: number;
  channel: string;
  confirmed: number;
  raw_input: string | null;
  created_at: string;
}

interface CustomerRow {
  id: number;
  name: string | null;
  phone: string | null;
  disambiguator: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

function toTransaction(row: TransactionRow, naiveZone: NaiveTimestampZone): Transaction {
  return {
    id: row.id,
    customer_id: row.customer_id,
    type: row.type as Transaction['type'],
    amount: row.amount,
    channel: row.channel as Transaction['channel'],
    // SQLite has no boolean; anything non-zero is a confirmation.
    confirmed: row.confirmed === 1 ? 1 : 0,
    raw_input: row.raw_input,
    created_at: normalizeCreatedAt(row.created_at, naiveZone),
  };
}

/** Every customer row, oldest id first. */
export function loadCustomers(): Customer[] {
  const rows = db
    .prepare(
      `SELECT id, name, phone, disambiguator, first_seen, last_seen
         FROM customers
        ORDER BY id`,
    )
    .all() as CustomerRow[];
  return rows;
}

/**
 * Every transaction, oldest first.
 *
 * Deliberately unfiltered and unwindowed: `buildRegularsSummary` needs full
 * history to tell "hasn't come this week" from "hasn't come in three weeks", and
 * it does its own windowing. At kiosk scale — a few thousand rows over a
 * hackathon demo — reading the table is far cheaper than getting the window
 * boundary wrong in SQL, where the same timezone ambiguity would bite again.
 */
export function loadTransactions(options: LoadOptions = {}): Transaction[] {
  const { naiveTimestampZone = 'utc' } = options;
  const rows = db
    .prepare(
      `SELECT id, customer_id, type, amount, channel, confirmed, raw_input, created_at
         FROM transactions
        ORDER BY created_at, id`,
    )
    .all() as TransactionRow[];
  return rows.map((row) => toTransaction(row, naiveTimestampZone));
}

/**
 * One customer's transactions — the cheap path for the live "Mary is back, 4th
 * visit" reply, which does not need the whole ledger.
 */
export function loadTransactionsForCustomer(
  customerId: number,
  options: LoadOptions = {},
): Transaction[] {
  const { naiveTimestampZone = 'utc' } = options;
  const rows = db
    .prepare(
      `SELECT id, customer_id, type, amount, channel, confirmed, raw_input, created_at
         FROM transactions
        WHERE customer_id = ?
        ORDER BY created_at, id`,
    )
    .all(customerId) as TransactionRow[];
  return rows.map((row) => toTransaction(row, naiveTimestampZone));
}

/** Both tables in one call, for the summary path. */
export function loadLedger(options: LoadOptions = {}): {
  customers: Customer[];
  transactions: Transaction[];
} {
  return { customers: loadCustomers(), transactions: loadTransactions(options) };
}

/** Look up a customer by the exact name P1 stored, for the live SMS reply. */
export function findCustomerByName(name: string): Customer | undefined {
  const row = db
    .prepare(
      `SELECT id, name, phone, disambiguator, first_seen, last_seen
         FROM customers
        WHERE name = ?
        ORDER BY id
        LIMIT 1`,
    )
    .get(name) as CustomerRow | undefined;
  return row;
}
