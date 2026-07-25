/**
 * P2 — Retention: types.
 *
 * Two groups live here:
 *
 *  1. LEDGER MIRRORS (`Customer`, `Transaction`) — a temporary transcription of
 *     README §8 / `src/db/schema.sql`. P0 has not landed `src/core/types.ts` yet
 *     and P2 must not block on it. **The moment that file exists, delete the
 *     mirrors below and import instead:**
 *
 *         import type { Customer, Transaction } from '../core/types';
 *
 *     P1 owns the ledger shape. These mirrors are a stand-in, never a fork — if
 *     they disagree with `schema.sql`, `schema.sql` is right.
 *
 *  2. P2-OWNED TYPES (`CustomerProfile`, `RegularsSummary`, …) — the retention
 *     pillar's own outputs. P2 owns these outright.
 */

// ---------------------------------------------------------------------------
// 1. LEDGER MIRRORS — delete once src/core/types.ts exists
// ---------------------------------------------------------------------------

export type TransactionType = 'sale' | 'deni' | 'deni_repayment' | 'restock';

export type TransactionChannel = 'mpesa_buygoods' | 'cash';

/** `customers` table (README §8). */
export interface Customer {
  id: number;
  /** Lifted from the M-Pesa SMS payer name, or manually tagged. */
  name: string | null;
  /** Usually absent — Buy Goods SMS gives a name, not a number. */
  phone: string | null;
  /** Free text separating same-named customers, e.g. "blue uniform". */
  disambiguator: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

/** `transactions` table (README §8). */
export interface Transaction {
  id: number;
  /** Null for anonymous cash — those transactions are invisible to retention. */
  customer_id: number | null;
  type: TransactionType;
  amount: number;
  channel: TransactionChannel;
  /** 0 = self-reported/unconfirmed, 1 = owner-confirmed. */
  confirmed: 0 | 1;
  raw_input: string | null;
  /** SQLite DATETIME. Assumed UTC — see `EAT_UTC_OFFSET_HOURS`. */
  created_at: string;
}

// ---------------------------------------------------------------------------
// 2. P2-OWNED TYPES
// ---------------------------------------------------------------------------

/**
 * What P2 knows about one customer, derived purely from ledger rows.
 *
 * Every field is computed by deterministic code (README §5). Claude is handed
 * these numbers to phrase; it never produces them.
 */
export interface CustomerProfile {
  customerId: number;
  /** `name` plus disambiguator, e.g. "Mary (blue uniform)". Never null. */
  displayName: string;
  /**
   * Distinct **EAT calendar days** on which this customer transacted. Three
   * purchases in one afternoon is one visit, not three — this is the number the
   * owner would recognise as "how often they come".
   */
  visitCount: number;
  /**
   * Value of goods taken: `sale` + `deni` amounts. Excludes `deni_repayment`,
   * which is money for goods already counted, and `restock`, which is the owner
   * buying stock and never customer-linked.
   */
  totalSpend: number;
  /** `totalSpend / visitCount`, rounded to 2dp. 0 when visitCount is 0. */
  averageSpend: number;
  /** ISO date (YYYY-MM-DD, EAT) of first and most recent visit. */
  firstVisit: string;
  lastVisit: string;
  /** Whole EAT days between `lastVisit` and the reference date. 0 = today. */
  daysSinceLastVisit: number;
  /** `visitCount >= REPEAT_VISIT_THRESHOLD`. */
  isRepeat: boolean;
  /** Channels seen, sorted, deduped. Useful for "reachable via M-Pesa?". */
  channels: TransactionChannel[];
  /** True if any contributing row had `confirmed = 0`. Surfaced, never hidden. */
  includesUnconfirmed: boolean;
}

/**
 * One customer's line in the weekly summary, with the ranking already applied.
 */
export interface RankedRegular extends CustomerProfile {
  /** 1-based position in the summary. */
  rank: number;
}

/**
 * The deterministic payload behind the weekly "your regulars" WhatsApp message.
 *
 * This object contains every figure the owner will see. `promo-drafts.ts` hands
 * it to Claude for phrasing only.
 */
export interface RegularsSummary {
  /** Inclusive EAT date window the figures cover. */
  periodStart: string;
  periodEnd: string;
  regulars: RankedRegular[];
  /** Customers with >= REPEAT_VISIT_THRESHOLD visits in the window. */
  repeatCustomerCount: number;
  /** Distinct named customers seen in the window, repeat or not. */
  namedCustomerCount: number;
  /**
   * Total value of goods taken by *named* customers in the window. Anonymous
   * cash is excluded by definition — P2 can only see customer-linked rows, so
   * this is deliberately NOT the shop's total sales. P1 owns that figure.
   */
  namedCustomerSpend: number;
  /** True if any contributing row was unconfirmed. */
  includesUnconfirmed: boolean;
  /**
   * Regulars whose `daysSinceLastVisit` has crossed `LAPSED_AFTER_DAYS` —
   * the ones worth a promo. Subset of `regulars`.
   */
  lapsing: RankedRegular[];
}

/**
 * Two customer rows that look like the same human, e.g. "MARY WANJIKU" and
 * "Mary Wanjiku".
 *
 * P2 **reports** these and stops. Merging means writing to `customers`, which
 * only P1 may do (README §9). Hand these to P1 or to the owner for a decision;
 * never silently collapse two people into one.
 */
export interface DuplicateCandidate {
  a: Customer;
  b: Customer;
  /** The shared normalised form that triggered the match. */
  normalizedName: string;
  /** Why it matched, for the owner-facing prompt. */
  reason: 'exact-normalized-match';
  /** True if a disambiguator already distinguishes them — likely NOT a dupe. */
  disambiguated: boolean;
}
