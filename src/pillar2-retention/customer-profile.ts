/**
 * P2 — Retention: build customer profiles from ledger rows.
 *
 * Contract (README §9): this module **reads** `transactions` and `customers`.
 * It writes nothing, holds no state, and performs no network calls — every
 * export is a pure function of its arguments. That keeps it unit-testable with
 * no API key and no database, and it keeps the arithmetic auditable (README §5).
 *
 * Replaces P0's `getCustomerProfile` placeholder. Rows are passed in rather than
 * fetched here, so the caller — the webhook, or a test — decides what slice of
 * the ledger is in scope.
 */

import type {
  CanonicalLedger,
  Channel,
  Customer,
  CustomerMerge,
  CustomerProfile,
  DuplicateCandidate,
  Transaction,
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
 * evening and early-morning sales under the wrong date and quietly inflate visit
 * counts. All day bucketing in P2 goes through `toEatDateKey`.
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
 * (space-separated, no zone — treated as UTC, which is what `CURRENT_TIMESTAMP`
 * stores) as well as ISO-8601 with an explicit offset.
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
  const normalized = hasZone ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`;

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

/** Does this timestamp already state its offset? */
const HAS_EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * What a timestamp with no stated offset should be taken to mean.
 *
 * The `transactions.created_at` column currently receives three different
 * serialisations, two of which are zone-less and mean different things:
 *
 * | Writer                        | Example                      | Naive? | Means |
 * |-------------------------------|------------------------------|--------|-------|
 * | P1 `parseMpesaSms`            | `2026-07-25T22:00:00`        | yes    | EAT   |
 * | P1 `parseTransaction`         | `2026-07-25T19:00:00.000Z`   | no     | UTC   |
 * | SQLite `CURRENT_TIMESTAMP`    | `2026-07-25 19:00:00`        | yes    | UTC   |
 *
 * P1's `parse-mpesa-sms.md` instructs Claude to "assume Africa/Nairobi" and its
 * examples emit no suffix, so forwarded-SMS rows are naive **EAT** while seeded
 * and cash rows are naive **UTC**. A bare string cannot be told apart, so this
 * is a judgement the caller must make explicitly rather than something P2 can
 * infer.
 */
export type NaiveTimestampZone = 'utc' | 'eat';

/**
 * Give a ledger timestamp an explicit offset so nothing downstream has to guess.
 *
 * Timestamps that already state a zone are returned untouched. This is applied
 * once, at the read boundary (`queries.ts`), so the pure functions below only
 * ever see unambiguous values — the ambiguity is resolved in exactly one place
 * instead of being re-litigated per call site.
 *
 * The real fix is upstream and is one line: have `parse-mpesa-sms.md` emit
 * `2026-07-25T22:00:00+03:00`. Once it does, every row carries its own offset
 * and this function becomes a no-op regardless of which mode is passed.
 */
export function normalizeCreatedAt(
  raw: string,
  naiveZone: NaiveTimestampZone = 'utc',
): string {
  const trimmed = raw.trim();
  if (HAS_EXPLICIT_ZONE.test(trimmed)) return trimmed;
  const isoish = trimmed.replace(' ', 'T');
  return naiveZone === 'eat' ? `${isoish}+03:00` : `${isoish}Z`;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Normalise an M-Pesa payer name for comparison.
 *
 * Buy Goods SMS names arrive shouty and inconsistently spaced — `"MARY  WANJIKU"`,
 * `"Mary Wanjiku"`, `"mary wanjiku."` — and each spelling would otherwise become
 * a separate "customer", fragmenting the retention list that is the whole point
 * of this pillar.
 *
 * Comparison only. Never store the normalised form as the customer's name; the
 * owner should see the name she recognises.
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
 * flagged `disambiguated: true`, because "Mary - blue uniform" and "Mary - shop
 * next door" are probably two real people the owner separated on purpose.
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

/**
 * Collapse `customers` rows that are obviously the same person, at read time.
 *
 * P1 upserts customers on an **exact** `name` match, so the same human paying
 * twice with differently-cased M-Pesa names — `MARY WANJIKU` then
 * `Mary Wanjiku` — becomes two rows. That fragments the retention list this
 * pillar exists to build, and on stage it reads as a bug: the owner sees her
 * best customer listed twice with half her visits each.
 *
 * This does **not** write to the database. P1 is the only writer of `customers`
 * (README §9); this remaps ids in an in-memory copy for presentation only, and
 * every merge is reported in `merges` so nothing collapses silently. The durable
 * fix belongs in P1's upsert — matching on a normalised name instead of an exact
 * one — at which point this becomes a harmless no-op.
 *
 * Conservative on purpose: a row carrying a `disambiguator` is **never** merged.
 * "Mary - blue uniform" and "Mary - shop next door" are two real people the
 * owner deliberately separated, and overriding that would be worse than the
 * duplicate. Only rows with no disambiguator at all are candidates.
 */
export function canonicalizeCustomers(
  customers: readonly Customer[],
  transactions: readonly Transaction[],
): CanonicalLedger {
  const groups = new Map<string, Customer[]>();
  for (const customer of customers) {
    const key = normalizeName(customer.name);
    if (!key) continue; // unnamed rows are never merged
    const group = groups.get(key);
    if (group) group.push(customer);
    else groups.set(key, [customer]);
  }

  const remap = new Map<number, number>();
  const merges: CustomerMerge[] = [];

  for (const group of groups.values()) {
    // Only rows the owner has NOT deliberately distinguished.
    const mergeable = group.filter((c) => !c.disambiguator?.trim());
    if (mergeable.length < 2) continue;

    const sorted = [...mergeable].sort((a, b) => a.id - b.id);
    const canonical = sorted[0]; // earliest sighting wins the display name
    const mergedIds = sorted.slice(1).map((c) => c.id);
    for (const id of mergedIds) remap.set(id, canonical.id);

    merges.push({
      canonicalId: canonical.id,
      mergedIds,
      displayName: displayNameFor(canonical),
    });
  }

  if (remap.size === 0) {
    return { customers: [...customers], transactions: [...transactions], merges };
  }

  return {
    customers: customers.filter((c) => !remap.has(c.id)),
    transactions: transactions.map((txn) =>
      txn.customer_id !== null && remap.has(txn.customer_id)
        ? { ...txn, customer_id: remap.get(txn.customer_id)! }
        : txn,
    ),
    merges,
  };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface BuildProfilesOptions {
  /**
   * Date all "days since" figures are measured from, `YYYY-MM-DD` in EAT.
   * Required — passed in rather than read from the clock so results are
   * reproducible and testable, and so the demo can run against seeded history.
   */
  asOfDateKey: string;
  /**
   * Include rows with `confirmed = 0`.
   *
   * Defaults to `true`: retention is advisory, and an owner who hasn't yet
   * confirmed today's close still wants to see who came in. The strict
   * unconfirmed-entry rule (README §3) governs the **statement**, which is P3's
   * surface, not this one. Either way the profile carries `includesUnconfirmed`
   * so the distinction is never hidden.
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
    channels: Set<Channel>;
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
        visitDays: new Set<string>(),
        totalSpend: 0,
        channels: new Set<Channel>(),
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
