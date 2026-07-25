/**
 * P2 — Retention: repeat-visit detection, regulars ranking, weekly summary.
 *
 * Contract (README §9): reads `transactions` and `customers`; writes nothing.
 * Every export is pure and offline. This module produces **all the numbers** the
 * weekly WhatsApp message contains — `promo-drafts.ts` only phrases them
 * (README §5).
 */

import {
  buildCustomerProfiles,
  daysBetweenDateKeys,
  REPEAT_VISIT_THRESHOLD,
  round2,
  toEatDateKey,
} from './customer-profile';
import type {
  Customer,
  CustomerProfile,
  RankedRegular,
  RegularsSummary,
  Transaction,
} from './types';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Days in the weekly summary window, inclusive of the as-of date. */
export const SUMMARY_WINDOW_DAYS = 7;

/**
 * How many regulars the WhatsApp message lists.
 *
 * Mama Njeri recognises 10–15 regulars by face (README §2); five is the number
 * that fits a readable WhatsApp message and still feels like *her* list.
 */
export const DEFAULT_REGULARS_LIMIT = 5;

/**
 * A regular not seen for this many days is "lapsing" — the promo trigger.
 *
 * Set slightly longer than the summary window so that a customer who simply
 * hasn't come *yet this week* isn't immediately flagged as drifting away.
 */
export const LAPSED_AFTER_DAYS = 10;

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

export interface DateWindow {
  /** Inclusive, `YYYY-MM-DD` in EAT. */
  startKey: string;
  /** Inclusive, `YYYY-MM-DD` in EAT. */
  endKey: string;
}

/**
 * The trailing N-day window ending on `asOfDateKey`, inclusive both ends.
 *
 * A 7-day window ending 2026-07-26 starts on 2026-07-20 — seven dates, not
 * eight. Off-by-one here would silently change every figure in the summary.
 */
export function trailingWindow(
  asOfDateKey: string,
  days: number = SUMMARY_WINDOW_DAYS,
): DateWindow {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`[p2] trailingWindow needs a positive integer of days, got ${days}`);
  }
  const end = Date.parse(`${asOfDateKey}T00:00:00Z`);
  if (Number.isNaN(end)) {
    throw new Error(`[p2] trailingWindow needs a YYYY-MM-DD date key, got "${asOfDateKey}"`);
  }
  const start = new Date(end - (days - 1) * 86_400_000);
  return { startKey: start.toISOString().slice(0, 10), endKey: asOfDateKey };
}

/** Rows whose EAT calendar date falls inside `window`, inclusive both ends. */
export function filterToWindow(
  transactions: readonly Transaction[],
  window: DateWindow,
): Transaction[] {
  return transactions.filter((txn) => {
    const key = toEatDateKey(txn.created_at);
    return key >= window.startKey && key <= window.endKey;
  });
}

// ---------------------------------------------------------------------------
// Repeat detection
// ---------------------------------------------------------------------------

/**
 * Has this customer been here before *today*?
 *
 * This is the live demo moment (README §12.1): a forwarded Buy Goods SMS lands,
 * P1 writes the transaction, and the bot can immediately say "Mary is back — 4th
 * visit" instead of just "logged".
 *
 * Compares EAT calendar days, so a second purchase the same afternoon correctly
 * reads as *not* a new visit.
 *
 * @param history All ledger rows for this customer, the new one included.
 *                Rows for other customers are ignored, so passing the whole
 *                ledger is safe if wasteful.
 * @param customerId The customer who just transacted.
 * @param asOfTimestamp The new transaction's `created_at`.
 */
export function detectRepeatVisit(
  history: readonly Transaction[],
  customerId: number,
  asOfTimestamp: string,
): { isRepeat: boolean; visitNumber: number; previousVisitDate: string | null } {
  const todayKey = toEatDateKey(asOfTimestamp);
  const days = new Set<string>();

  for (const txn of history) {
    if (txn.customer_id !== customerId) continue;
    if (txn.type === 'restock') continue;
    days.add(toEatDateKey(txn.created_at));
  }
  days.add(todayKey); // the new visit, whether or not it is in `history` yet

  const sorted = [...days].sort();
  const priorDays = sorted.filter((key) => key < todayKey);

  return {
    isRepeat: priorDays.length > 0,
    visitNumber: sorted.length,
    previousVisitDate: priorDays.length > 0 ? priorDays[priorDays.length - 1] : null,
  };
}

/**
 * Sort profiles into the owner-facing regulars order and take the top `limit`.
 *
 * Ordering: visits desc → spend desc → most recent visit desc → name asc. The
 * final name tiebreak makes the ranking fully deterministic, so the same ledger
 * always produces the same message — which matters when the demo is re-run on
 * stage.
 */
export function rankRegulars(
  profiles: readonly CustomerProfile[],
  limit: number = DEFAULT_REGULARS_LIMIT,
): RankedRegular[] {
  return [...profiles]
    .sort(
      (a, b) =>
        b.visitCount - a.visitCount ||
        b.totalSpend - a.totalSpend ||
        (a.lastVisit < b.lastVisit ? 1 : a.lastVisit > b.lastVisit ? -1 : 0) ||
        a.displayName.localeCompare(b.displayName),
    )
    .slice(0, Math.max(0, limit))
    .map((profile, index) => ({ ...profile, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

export interface RegularsSummaryOptions {
  /** `YYYY-MM-DD` in EAT. The window ends here. Passed in, never read from the clock. */
  asOfDateKey: string;
  windowDays?: number;
  limit?: number;
  includeUnconfirmed?: boolean;
}

/**
 * Assemble the deterministic payload behind the weekly "your regulars" message.
 *
 * Ranking uses **in-window** visit counts, so the list answers "who came this
 * week" rather than "who has ever come most". `daysSinceLastVisit` and the
 * lapsing check, however, are measured against each customer's **full** history
 * — otherwise a customer absent all week would show `daysSinceLastVisit` capped
 * at the window length and could never be detected as lapsing.
 *
 * @param customers All customer rows.
 * @param transactions The **full** ledger, unwindowed. This function windows.
 */
export function buildRegularsSummary(
  customers: readonly Customer[],
  transactions: readonly Transaction[],
  options: RegularsSummaryOptions,
): RegularsSummary {
  const {
    asOfDateKey,
    windowDays = SUMMARY_WINDOW_DAYS,
    limit = DEFAULT_REGULARS_LIMIT,
    includeUnconfirmed = true,
  } = options;

  const window = trailingWindow(asOfDateKey, windowDays);
  const profileOptions = { asOfDateKey, includeUnconfirmed };

  const inWindow = buildCustomerProfiles(
    customers,
    filterToWindow(transactions, window),
    profileOptions,
  );

  // Lifetime profiles supply true recency for the lapsing check.
  const lifetimeByCustomer = new Map<number, CustomerProfile>();
  for (const profile of buildCustomerProfiles(customers, transactions, profileOptions)) {
    lifetimeByCustomer.set(profile.customerId, profile);
  }

  const regulars = rankRegulars(inWindow, limit).map((ranked) => {
    const lifetime = lifetimeByCustomer.get(ranked.customerId);
    return lifetime
      ? { ...ranked, lastVisit: lifetime.lastVisit, daysSinceLastVisit: lifetime.daysSinceLastVisit }
      : ranked;
  });

  // Lapsing is a property of every known regular, not only those listed this
  // week — the ones worth a promo are precisely the ones who went quiet.
  const lapsing = rankRegulars(
    [...lifetimeByCustomer.values()].filter(
      (profile) =>
        profile.visitCount >= REPEAT_VISIT_THRESHOLD &&
        profile.daysSinceLastVisit >= LAPSED_AFTER_DAYS,
    ),
    limit,
  );

  return {
    periodStart: window.startKey,
    periodEnd: window.endKey,
    regulars,
    repeatCustomerCount: inWindow.filter((p) => p.visitCount >= REPEAT_VISIT_THRESHOLD).length,
    namedCustomerCount: inWindow.length,
    namedCustomerSpend: round2(inWindow.reduce((sum, p) => sum + p.totalSpend, 0)),
    includesUnconfirmed: inWindow.some((p) => p.includesUnconfirmed),
    lapsing,
  };
}

/** Days since a customer's last visit, or `null` if they have never visited. */
export function daysSinceLastVisit(
  profile: CustomerProfile | undefined,
  asOfDateKey: string,
): number | null {
  if (!profile) return null;
  return daysBetweenDateKeys(profile.lastVisit, asOfDateKey);
}
