/**
 * P2 — Retention: build customer profiles from ledger rows.
 *
 * Contract (README §9): this module **reads** `transactions` and `customers`.
 * It writes nothing, holds no state, and performs no network calls — every
 * export is a pure function of its arguments. That keeps it unit-testable with
 * no API key and no database, and it keeps the arithmetic auditable (README §5).
 */

import type {
  Customer,
  CustomerProfile,
  DuplicateCandidate,
  Transaction,
  TransactionChannel,
  TransactionType,
} from './types';

// ---------------------------------------------------------------------------
// Tuning constants — single place to change the definitions
// ---------------------------------------------------------------------------

/**
 * Kenya is UTC+03:00 (East Africa Time) and observes no DST, so a fixed offset
 * is exactly correct rather than an approximation.
 *
 * This matters: a 21:30 EAT sale is 18:30 UTC the same day, but a 01:00 EAT sale
 * is 22:00 UTC the *previous* day. Bucketing visits by UTC day would file some
 * evening and early-morning sales under the wrong date and quietly inflate
 * visit counts. All day bucketing in P2 goes through `toEatDateKey`.
 */
export const EAT_UTC_OFFSET_HOURS = 3;

/** Visits needed before a customer counts as a "regular". */
export const REPEAT_VISIT_THRESHOLD = 2;

/** Transaction types that mean the customer physically showed up. */
const VISIT_TYPES: readonly TransactionType[] = ['sale', 'deni', 'deni_repayment'];

/**
 * Transaction types that represent value of goods taken.
 *
 * `deni_repayment` is deliberately excluded — it is payment for goods already
 * counted under `deni`, and including both would double-count spend. `restock`
 * is the owner buying stock and is never customer-linked.
 */
const SPEND_TYPES: readonly TransactionType[] = ['sale', 'deni'];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a ledger timestamp to its EAT calendar date, `YYYY-MM-DD`.
 *
 * Accepts what SQLite hands back for a `DATETIME` column: `"2026-07-20 14:32:11"`
 * (space-separated, no zone — treated as UTC, which is what
 * `CURRENT_TIMESTAMP` stores) as well as ISO-8601 with an explicit offset.
 *
 * @throws if the timestamp is unparseable — a silently-dropped transaction is
 *         worse than a loud failure, because it would understate a real
 *         customer's visit count.
 */
export function toEatDateKey(timestamp: string): string {
  const parsed = parseLedgerTimestamp(timestamp);
  const shifted = new Date(parsed.getTime() + EAT_UTC_OFFSET_HOURS * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

function parseLedgerTimestamp(timestamp: string): Date {
  const raw = timestamp.trim();

  // Already carries a zone or offset — trust it.
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasZone
    ? raw.replace(' ', 'T')
    : `${raw.replace(' ', 'T')}Z`; // bare SQLite DATETIME is UTC

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `[p2] Unparseable transaction timestamp: ${JSON.stringify(timestamp)}. ` +
        `Expected a SQLite DATETIME ("YYYY-MM-DD HH:MM:SS") or ISO-8601.`,
    );
  }
  return date;
}

/** Whole days from `fromKey` to `toKey`, both `YYYY-MM-DD`. Negative if future. */
export function daysBetweenDateKeys(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Normalise an M-Pesa payer name for comparison.
 *
 * Buy Goods SMS names arrive shouty and inconsistently spaced —
 * `"MARY  WANJIKU"`, `"Mary Wanjiku"`, `"mary wanjiku."` — and each spelling
 * would otherwise become a separate "customer", fragmenting the retention list
 * that is the whole point of this pillar.
 *
 * Comparison only. Never store the normalised form as the customer's name; the
 * owner should see the name they recognise.
 */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // drop combining accents left behind by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation and stray symbols -> space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The name the owner sees. Appends the disambiguator when present, because
 * "Mary" and "Mary" in the same list is useless to her.
 */
export function displayNameFor(customer: Customer): string {
  const base = customer.name?.trim() || `Customer #${customer.id}`;
  const tag = customer.disambiguator?.trim();
  return tag ? `${base} (${tag})` : base;
}

/**
 * Find customer rows that normalise to the same name.
 *
 * Reports only — see {@link DuplicateCandidate}. Merging is a write to
 * `customers`, which is P1's alone (README §9).
 *
 * Pairs where a disambiguator already tells them apart are still returned, but
 * flagged `disambiguated: true`, because "Mary - blue uniform" and
 * "Mary - kiosk next door" are probably two real people the owner already
 * separated on purpose.
 */
export function findDuplicateCandidates(customers: readonly Customer[]): DuplicateCandidate[] {
  const buckets = new Map<string, Customer[]>();

  for (const customer of customers) {
    const key = normalizeName(customer.name);
    if (!key) continue; // unnamed rows can't be matched by name
    const bucket = buckets.get(key);
    if (bucket) bucket.push(customer);
    else buckets.set(key, [customer]);
  }

  const candidates: DuplicateCandidate[] = [];
  for (const [normalizedName, group] of buckets) {
    if (group.length < 2) continue;
    // Every unordered pair in the group.
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        const tagA = a.disambiguator?.trim() ?? '';
        const tagB = b.disambiguator?.trim() ?? '';
        candidates.push({
          a,
          b,
          normalizedName,
          reason: 'exact-normalized-match',
          disambiguated: tagA !== '' && tagB !== '' && tagA !== tagB,
        });
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface BuildProfilesOptions {
  /**
   * Date all "days since" figures are measured from, `YYYY-MM-DD` in EAT.
   * Required — passed in rather than read from the clock so that results are
   * reproducible and testable, and so the demo can run against seeded history.
   */
  asOfDateKey: string;
  /**
   * Include rows with `confirmed = 0`.
   *
   * Defaults to `true`: retention is advisory, and an owner who hasn't yet
   * confirmed today's close still wants to see who came in. The strict
   * unconfirmed-entry rule (README §3) governs the **statement**, which is P3's
   * surface, not this one. Either way the profile carries
   * `includesUnconfirmed` so the distinction is never hidden.
   */
  includeUnconfirmed?: boolean;
}

/**
 * Build one profile per named customer that has at least one qualifying row.
 *
 * Customers with no visits in the supplied transaction set are omitted rather
 * than returned with zeroes — an empty regulars list is a truthful "nobody came
 * this week", whereas a list of zero-visit names reads like a bug.
 *
 * Anonymous cash (`customer_id = null`) is skipped: P2 structurally cannot
 * attribute it, and guessing would corrupt the retention list.
 *
 * @param transactions Ledger rows. Pre-filter to a window for windowed figures;
 *                     this function does no windowing of its own.
 */
export function buildCustomerProfiles(
  customers: readonly Customer[],
  transactions: readonly Transaction[],
  options: BuildProfilesOptions,
): CustomerProfile[] {
  const { asOfDateKey, includeUnconfirmed = true } = options;

  const byId = new Map<number, Customer>();
  for (const customer of customers) byId.set(customer.id, customer);

  interface Accumulator {
    visitDays: Set<string>;
    totalSpend: number;
    channels: Set<TransactionChannel>;
    includesUnconfirmed: boolean;
  }
  const accumulators = new Map<number, Accumulator>();

  for (const txn of transactions) {
    if (txn.customer_id === null || txn.customer_id === undefined) continue;
    if (!byId.has(txn.customer_id)) continue; // orphan row; P1's to reconcile
    if (!VISIT_TYPES.includes(txn.type)) continue;
    if (!includeUnconfirmed && txn.confirmed !== 1) continue;

    let acc = accumulators.get(txn.customer_id);
    if (!acc) {
      acc = {
        visitDays: new Set(),
        totalSpend: 0,
        channels: new Set(),
        includesUnconfirmed: false,
      };
      accumulators.set(txn.customer_id, acc);
    }

    acc.visitDays.add(toEatDateKey(txn.created_at));
    acc.channels.add(txn.channel);
    if (txn.confirmed !== 1) acc.includesUnconfirmed = true;
    if (SPEND_TYPES.includes(txn.type)) acc.totalSpend += txn.amount;
  }

  const profiles: CustomerProfile[] = [];
  for (const [customerId, acc] of accumulators) {
    const customer = byId.get(customerId)!;
    const visitDays = [...acc.visitDays].sort();
    const visitCount = visitDays.length;
    const lastVisit = visitDays[visitCount - 1];
    const totalSpend = round2(acc.totalSpend);

    profiles.push({
      customerId,
      displayName: displayNameFor(customer),
      visitCount,
      totalSpend,
      averageSpend: visitCount > 0 ? round2(totalSpend / visitCount) : 0,
      firstVisit: visitDays[0],
      lastVisit,
      daysSinceLastVisit: daysBetweenDateKeys(lastVisit, asOfDateKey),
      isRepeat: visitCount >= REPEAT_VISIT_THRESHOLD,
      channels: [...acc.channels].sort(),
      includesUnconfirmed: acc.includesUnconfirmed,
    });
  }

  return profiles;
}

/** Round to 2dp without float drift, so KES figures add up on screen. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
