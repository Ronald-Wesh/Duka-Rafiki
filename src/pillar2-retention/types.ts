/**
 * P2 — Retention: types.
 *
 * Ledger types (`Customer`, `Transaction`, `Channel`, `TransactionType`) are
 * owned by P1/P0 in `src/core/types.ts` and are merely re-exported here so P2
 * modules have a single import site. **P2 does not define ledger shapes.** If a
 * field is missing, ask P1 to add it to `core/types.ts` rather than widening
 * anything in this folder (README §9).
 *
 * Everything below the re-export is P2's own output, which P2 owns outright.
 */

import type { Channel, Customer } from '../core/types';

export type { Channel, Customer, Transaction, TransactionType } from '../core/types';

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
  channels: Channel[];
  /** True if any contributing row had `confirmed = 0`. Surfaced, never hidden. */
  includesUnconfirmed: boolean;
}

/** One customer's line in the weekly summary, with the ranking applied. */
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
   *
   * **Not owner-facing.** It is never shown to Claude and never appears in a
   * WhatsApp message, precisely because an owner reading it would reasonably
   * mistake it for her weekly takings. Use it only where that distinction is
   * understood.
   */
  namedCustomerSpend: number;
  /** True if any contributing row was unconfirmed. */
  includesUnconfirmed: boolean;
  /**
   * Regulars whose `daysSinceLastVisit` has crossed `LAPSED_AFTER_DAYS` — the
   * ones worth a promo. Ranked, and **not** necessarily a subset of `regulars`:
   * someone who has gone quiet is by definition absent from this week's list.
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
