/**
 * P2 — Retention: edge-case suite.
 *
 *     npx ts-node src/pillar2-retention/edge-cases.ts
 *
 * `smoke-check.ts` proves the happy path is arithmetically right. This file
 * attacks the boundaries: empty inputs, malformed timestamps, midnight and
 * year-end rollovers, leap days, float drift, ties, negative and zero amounts,
 * non-Latin names, orphan rows, future dates, and every way the model can
 * misbehave.
 *
 * Runs offline — no database, no API key. Database behaviour is covered
 * separately by `db-check.ts`.
 *
 * Where a case documents a deliberate design decision rather than an obvious
 * right answer, the comment says so, so a future reader can tell "this is
 * intended" from "nobody thought about it".
 */

import { createCheckRun } from './check-utils';
import {
  buildCustomerProfiles,
  canonicalizeCustomers,
  daysBetweenDateKeys,
  displayNameFor,
  findDuplicateCandidates,
  normalizeCreatedAt,
  normalizeName,
  round2,
  toEatDateKey,
} from './customer-profile';
import {
  assertFiguresPreserved,
  draftRegularsSummary,
  draftWinBackPromo,
  figuresToPreserve,
  formatKes,
  renderFactsBlock,
  renderRegularsSummaryText,
} from './promo-drafts';
import {
  buildRegularsSummary,
  detectRepeatVisit,
  filterToWindow,
  rankRegulars,
  trailingWindow,
} from './repeat-detection';
import type { Customer, RegularsSummary, Transaction } from './types';

const t = createCheckRun();

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// Spread the overrides rather than `over.x ?? default` — several cases below pass
// an explicit `null` (an unnamed customer, an anonymous cash sale) and `??` would
// silently swallow it back to the default, which is exactly the input those cases
// exist to test.
let nextTxnId = 1;
function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: nextTxnId++,
    customer_id: 1,
    type: 'sale',
    amount: 100,
    channel: 'mpesa_buygoods',
    confirmed: 1,
    raw_input: null,
    created_at: '2026-07-22 09:00:00',
    ...over,
  };
}

function cust(over: Partial<Customer> = {}): Customer {
  return {
    id: 1,
    name: 'Mary',
    phone: null,
    disambiguator: null,
    first_seen: null,
    last_seen: null,
    ...over,
  };
}

const AS_OF = '2026-07-26';

// ===========================================================================
// A. Timestamp parsing
// ===========================================================================

t.section('A. toEatDateKey — format tolerance');
t.eq('space-separated SQLite DATETIME', toEatDateKey('2026-07-22 09:00:00'), '2026-07-22');
t.eq('ISO with T', toEatDateKey('2026-07-22T09:00:00'), '2026-07-22');
t.eq('explicit Z', toEatDateKey('2026-07-22T09:00:00Z'), '2026-07-22');
t.eq('milliseconds present', toEatDateKey('2026-07-22T09:00:00.123Z'), '2026-07-22');
t.eq('lowercase z', toEatDateKey('2026-07-22T09:00:00z'), '2026-07-22');
t.eq('explicit +03:00', toEatDateKey('2026-07-22T09:00:00+03:00'), '2026-07-22');
t.eq('offset with no colon (+0300)', toEatDateKey('2026-07-22T09:00:00+0300'), '2026-07-22');
t.eq('a non-Kenyan offset is still honoured', toEatDateKey('2026-07-22T00:30:00-05:00'), '2026-07-22');
t.eq('surrounding whitespace tolerated', toEatDateKey('  2026-07-22 09:00:00  '), '2026-07-22');

t.section('A2. toEatDateKey — EAT day boundaries (the off-by-one zone)');
// 21:00 UTC is exactly midnight in Nairobi.
t.eq('20:59:59Z is still the previous EAT day', toEatDateKey('2026-07-25T20:59:59Z'), '2026-07-25');
t.eq('21:00:00Z is midnight EAT, so the next day', toEatDateKey('2026-07-25T21:00:00Z'), '2026-07-26');
t.eq('00:00 EAT explicit', toEatDateKey('2026-07-26T00:00:00+03:00'), '2026-07-26');
t.eq('23:59:59 EAT explicit', toEatDateKey('2026-07-26T23:59:59+03:00'), '2026-07-26');

t.section('A3. toEatDateKey — calendar rollovers');
t.eq('month end', toEatDateKey('2026-07-31T21:00:00Z'), '2026-08-01');
t.eq('year end', toEatDateKey('2026-12-31T21:00:00Z'), '2027-01-01');
t.eq('leap day exists in 2024', toEatDateKey('2024-02-28T21:00:00Z'), '2024-02-29');
t.eq('and 2026 has no 29 Feb', toEatDateKey('2026-02-28T21:00:00Z'), '2026-03-01');

t.section('A4. toEatDateKey — rejects the unparseable, loudly');
t.throws('empty string', () => toEatDateKey(''), /Unparseable/);
t.throws('whitespace only', () => toEatDateKey('   '), /Unparseable/);
t.throws('not a date at all', () => toEatDateKey('nimepata 500'), /Unparseable/);
t.throws('impossible month', () => toEatDateKey('2026-13-01 09:00:00'), /Unparseable/);
// KNOWN LIMITATION, not a decision: an out-of-range *day* is not rejected,
// because `new Date` rolls it over rather than failing — 30 Feb becomes 2 March.
// Detecting it would need a component-by-component round-trip check. Left as-is:
// SQLite's DATETIME cannot produce such a string, so the only source would be a
// writer that is already broken, and the month check above catches the common
// typo. Recorded here so the gap is known rather than assumed handled.
t.eq('an impossible DAY silently rolls over', toEatDateKey('2026-02-30 09:00:00'), '2026-03-02');
// Date-only is plausible from a hand-written seed, so it must not explode.
t.eq('date-only is treated as an EAT date key', toEatDateKey('2026-07-22'), '2026-07-22');

// ===========================================================================
// B. normalizeCreatedAt — the read-boundary decision
// ===========================================================================

t.section('B. normalizeCreatedAt');
t.eq('naive + utc', normalizeCreatedAt('2026-07-25 19:00:00', 'utc'), '2026-07-25T19:00:00Z');
t.eq('naive + eat', normalizeCreatedAt('2026-07-25T22:00:00', 'eat'), '2026-07-25T22:00:00+03:00');
t.eq('default mode is utc', normalizeCreatedAt('2026-07-25 19:00:00'), '2026-07-25T19:00:00Z');
t.eq('explicit Z untouched', normalizeCreatedAt('2026-07-25T19:00:00.000Z', 'eat'), '2026-07-25T19:00:00.000Z');
t.eq('explicit offset untouched', normalizeCreatedAt('2026-07-25T22:00:00+03:00', 'utc'), '2026-07-25T22:00:00+03:00');
t.eq('offset without colon untouched', normalizeCreatedAt('2026-07-25T22:00:00+0300', 'utc'), '2026-07-25T22:00:00+0300');
t.eq('lowercase z untouched', normalizeCreatedAt('2026-07-25T19:00:00z', 'eat'), '2026-07-25T19:00:00z');
t.eq('trims', normalizeCreatedAt('  2026-07-25 19:00:00 ', 'utc'), '2026-07-25T19:00:00Z');
// The whole point: a 22:00 EAT M-Pesa sale must land on the 25th, not the 26th.
t.eq(
  'naive EAT read as EAT keeps the right day',
  toEatDateKey(normalizeCreatedAt('2026-07-25T22:00:00', 'eat')),
  '2026-07-25',
);
t.eq(
  'naive EAT read as UTC slips a day (documented hazard)',
  toEatDateKey(normalizeCreatedAt('2026-07-25T22:00:00', 'utc')),
  '2026-07-26',
);
t.eq(
  'an explicit offset makes the mode irrelevant — the upstream fix',
  toEatDateKey(normalizeCreatedAt('2026-07-25T22:00:00+03:00', 'utc')),
  toEatDateKey(normalizeCreatedAt('2026-07-25T22:00:00+03:00', 'eat')),
);

// ===========================================================================
// C. daysBetweenDateKeys
// ===========================================================================

t.section('C. daysBetweenDateKeys');
t.eq('same day', daysBetweenDateKeys('2026-07-26', '2026-07-26'), 0);
t.eq('one day', daysBetweenDateKeys('2026-07-25', '2026-07-26'), 1);
t.eq('backwards is negative', daysBetweenDateKeys('2026-07-26', '2026-07-25'), -1);
t.eq('across a month', daysBetweenDateKeys('2026-07-31', '2026-08-01'), 1);
t.eq('across a year', daysBetweenDateKeys('2026-12-31', '2027-01-01'), 1);
t.eq('across a leap day', daysBetweenDateKeys('2024-02-28', '2024-03-01'), 2);
t.eq('non-leap year has one fewer', daysBetweenDateKeys('2026-02-28', '2026-03-01'), 1);
t.eq('a full year', daysBetweenDateKeys('2026-01-01', '2027-01-01'), 365);

// ===========================================================================
// D. Windowing
// ===========================================================================

t.section('D. trailingWindow / filterToWindow');
t.eq('7 days is inclusive both ends', trailingWindow('2026-07-26', 7), {
  startKey: '2026-07-20',
  endKey: '2026-07-26',
});
t.eq('1 day is a single date', trailingWindow('2026-07-26', 1), {
  startKey: '2026-07-26',
  endKey: '2026-07-26',
});
t.eq('window spanning a year boundary', trailingWindow('2027-01-02', 7), {
  startKey: '2026-12-27',
  endKey: '2027-01-02',
});
t.throws('zero days rejected', () => trailingWindow('2026-07-26', 0), /positive integer/);
t.throws('negative days rejected', () => trailingWindow('2026-07-26', -3), /positive integer/);
t.throws('fractional days rejected', () => trailingWindow('2026-07-26', 2.5), /positive integer/);
t.throws('garbage date key rejected', () => trailingWindow('not-a-date', 7), /YYYY-MM-DD/);

const window = trailingWindow(AS_OF, 7);
t.eq(
  'filterToWindow includes both boundary days and excludes just outside',
  filterToWindow(
    [
      txn({ created_at: '2026-07-19 09:00:00' }), // day before start
      txn({ created_at: '2026-07-20 09:00:00' }), // start
      txn({ created_at: '2026-07-26 09:00:00' }), // end
      txn({ created_at: '2026-07-27 09:00:00' }), // day after end
    ],
    window,
  ).map((x) => toEatDateKey(x.created_at)),
  ['2026-07-20', '2026-07-26'],
);
t.eq('filterToWindow on an empty ledger', filterToWindow([], window), []);

// ===========================================================================
// E. Name normalisation
// ===========================================================================

t.section('E. normalizeName');
t.eq('null', normalizeName(null), '');
t.eq('undefined', normalizeName(undefined), '');
t.eq('empty', normalizeName(''), '');
t.eq('whitespace only', normalizeName('   '), '');
t.eq('tabs and newlines collapse', normalizeName('MARY\t\nWANJIKU'), 'mary wanjiku');
t.eq('case folded', normalizeName('MaRy WaNjIkU'), 'mary wanjiku');
t.eq('double spacing collapsed', normalizeName('MARY   WANJIKU'), 'mary wanjiku');
t.eq('trailing punctuation dropped', normalizeName('Mary Wanjiku.'), 'mary wanjiku');
t.eq('hyphen becomes a space', normalizeName('Mary-Jane'), 'mary jane');
t.eq('apostrophe removed', normalizeName("M'Mary"), 'm mary');
t.eq('accents folded', normalizeName('José'), 'jose');
t.eq('digits kept (some payer names carry them)', normalizeName('Mary 2'), 'mary 2');
t.eq('punctuation-only normalises to empty', normalizeName('...'), '');
// Non-Latin names normalise to empty. That means they can never be *matched*,
// which is the safe direction: they are simply never merged, rather than all
// being merged together.
t.eq('non-Latin script normalises to empty', normalizeName('李明'), '');

t.section('E2. displayNameFor');
t.eq('plain name', displayNameFor(cust({ name: 'Mary' })), 'Mary');
t.eq('name is trimmed', displayNameFor(cust({ name: '  Mary  ' })), 'Mary');
t.eq('disambiguator appended', displayNameFor(cust({ name: 'Mary', disambiguator: 'blue uniform' })), 'Mary (blue uniform)');
t.eq('blank disambiguator ignored', displayNameFor(cust({ name: 'Mary', disambiguator: '   ' })), 'Mary');
t.eq('null name falls back to id', displayNameFor(cust({ id: 7, name: null })), 'Customer #7');
t.eq('blank name falls back to id', displayNameFor(cust({ id: 8, name: '   ' })), 'Customer #8');

// ===========================================================================
// F. Duplicate reporting
// ===========================================================================

t.section('F. findDuplicateCandidates');
t.eq('empty input', findDuplicateCandidates([]), []);
t.eq('single customer', findDuplicateCandidates([cust()]), []);
t.eq(
  'unnamed rows are never paired',
  findDuplicateCandidates([cust({ id: 1, name: null }), cust({ id: 2, name: null })]),
  [],
);
t.eq(
  'three same-name rows produce three pairs',
  findDuplicateCandidates([
    cust({ id: 1, name: 'Mary' }),
    cust({ id: 2, name: 'MARY' }),
    cust({ id: 3, name: 'mary' }),
  ]).length,
  3,
);
t.eq(
  'differing disambiguators flag as deliberate',
  findDuplicateCandidates([
    cust({ id: 1, name: 'Mary', disambiguator: 'blue uniform' }),
    cust({ id: 2, name: 'Mary', disambiguator: 'shop next door' }),
  ])[0]?.disambiguated,
  true,
);
t.eq(
  'identical disambiguators are NOT deliberate separation',
  findDuplicateCandidates([
    cust({ id: 1, name: 'Mary', disambiguator: 'blue uniform' }),
    cust({ id: 2, name: 'Mary', disambiguator: 'blue uniform' }),
  ])[0]?.disambiguated,
  false,
);

// ===========================================================================
// G. Canonicalisation
// ===========================================================================

t.section('G. canonicalizeCustomers');
const emptyCanon = canonicalizeCustomers([], []);
t.eq('empty input yields no merges', emptyCanon.merges, []);
t.eq('empty input yields empty customers', emptyCanon.customers, []);

const noDupes = canonicalizeCustomers([cust({ id: 1, name: 'Mary' }), cust({ id: 2, name: 'Otieno' })], []);
t.eq('distinct names are untouched', noDupes.merges, []);
t.eq('and all rows survive', noDupes.customers.length, 2);

const threeWay = canonicalizeCustomers(
  [cust({ id: 3, name: 'mary' }), cust({ id: 1, name: 'MARY' }), cust({ id: 2, name: 'Mary' })],
  [txn({ id: 1, customer_id: 3 }), txn({ id: 2, customer_id: 2 })],
);
t.eq('three-way merge collapses to one row', threeWay.customers.length, 1);
t.eq('canonical is the lowest id regardless of input order', threeWay.merges[0]?.canonicalId, 1);
t.eq('both other ids recorded', threeWay.merges[0]?.mergedIds, [2, 3]);
t.eq('all transactions remapped to the canonical id', threeWay.transactions.map((x) => x.customer_id), [1, 1]);

const mixedTags = canonicalizeCustomers(
  [
    cust({ id: 1, name: 'Mary' }),
    cust({ id: 2, name: 'MARY' }),
    cust({ id: 3, name: 'Mary', disambiguator: 'blue uniform' }),
  ],
  [],
);
t.eq('only the untagged rows merge', mixedTags.merges[0]?.mergedIds, [2]);
t.eq('the tagged row survives', mixedTags.customers.some((c) => c.id === 3), true);
t.eq('leaving two customers', mixedTags.customers.length, 2);

t.eq(
  'rows that are all tagged never merge',
  canonicalizeCustomers(
    [
      cust({ id: 1, name: 'Mary', disambiguator: 'blue uniform' }),
      cust({ id: 2, name: 'Mary', disambiguator: 'shop next door' }),
    ],
    [],
  ).merges,
  [],
);
t.eq(
  'unnamed rows never merge with each other',
  canonicalizeCustomers([cust({ id: 1, name: null }), cust({ id: 2, name: '  ' })], []).merges,
  [],
);
t.eq(
  'anonymous transactions are left alone by remapping',
  canonicalizeCustomers(
    [cust({ id: 1, name: 'Mary' }), cust({ id: 2, name: 'MARY' })],
    [txn({ customer_id: null })],
  ).transactions[0]?.customer_id,
  null,
);
// Canonicalisation must be idempotent, or repeated calls would drift.
const once = canonicalizeCustomers(
  [cust({ id: 1, name: 'Mary' }), cust({ id: 2, name: 'MARY' })],
  [txn({ customer_id: 2 })],
);
const twice = canonicalizeCustomers(once.customers, once.transactions);
t.eq('re-running finds nothing left to merge', twice.merges, []);
t.eq('and changes nothing', twice.transactions[0]?.customer_id, 1);

// ===========================================================================
// H. Profiles
// ===========================================================================

t.section('H. buildCustomerProfiles');
t.eq('no customers, no transactions', buildCustomerProfiles([], [], { asOfDateKey: AS_OF }), []);
t.eq(
  'customers with no transactions are omitted, not zero-filled',
  buildCustomerProfiles([cust()], [], { asOfDateKey: AS_OF }),
  [],
);
t.eq(
  'orphan transactions (customer_id not in customers) are skipped',
  buildCustomerProfiles([cust({ id: 1 })], [txn({ customer_id: 99 })], { asOfDateKey: AS_OF }),
  [],
);
t.eq(
  'anonymous cash produces no profile',
  buildCustomerProfiles([cust()], [txn({ customer_id: null })], { asOfDateKey: AS_OF }),
  [],
);
t.eq(
  'restock alone is not a visit',
  buildCustomerProfiles([cust()], [txn({ type: 'restock', amount: 5000 })], { asOfDateKey: AS_OF }),
  [],
);

const repayOnly = buildCustomerProfiles(
  [cust()],
  [txn({ type: 'deni_repayment', amount: 400 })],
  { asOfDateKey: AS_OF },
);
t.eq('a repayment counts as a visit', repayOnly[0]?.visitCount, 1);
t.eq('but contributes no spend', repayOnly[0]?.totalSpend, 0);
t.eq('so average spend is 0, not NaN', repayOnly[0]?.averageSpend, 0);

const unconf = [txn({ confirmed: 0, amount: 100 }), txn({ confirmed: 1, amount: 50 })];
t.eq(
  'unconfirmed included by default',
  buildCustomerProfiles([cust()], unconf, { asOfDateKey: AS_OF })[0]?.totalSpend,
  150,
);
t.eq(
  'and flagged',
  buildCustomerProfiles([cust()], unconf, { asOfDateKey: AS_OF })[0]?.includesUnconfirmed,
  true,
);
t.eq(
  'excluding unconfirmed drops them from spend',
  buildCustomerProfiles([cust()], unconf, { asOfDateKey: AS_OF, includeUnconfirmed: false })[0]?.totalSpend,
  50,
);
t.eq(
  'and clears the flag',
  buildCustomerProfiles([cust()], unconf, { asOfDateKey: AS_OF, includeUnconfirmed: false })[0]?.includesUnconfirmed,
  false,
);
t.eq(
  'excluding unconfirmed can remove a customer entirely',
  buildCustomerProfiles([cust()], [txn({ confirmed: 0 })], { asOfDateKey: AS_OF, includeUnconfirmed: false }),
  [],
);

t.section('H2. buildCustomerProfiles — amounts');
t.eq(
  'float amounts do not drift',
  buildCustomerProfiles([cust()], [txn({ amount: 0.1 }), txn({ amount: 0.2 })], { asOfDateKey: AS_OF })[0]
    ?.totalSpend,
  0.3,
);
t.eq(
  'zero-amount sale still counts as a visit',
  buildCustomerProfiles([cust()], [txn({ amount: 0 })], { asOfDateKey: AS_OF })[0]?.visitCount,
  1,
);
t.eq(
  'a negative amount (correction) is summed, not dropped',
  buildCustomerProfiles([cust()], [txn({ amount: 500 }), txn({ amount: -200 })], { asOfDateKey: AS_OF })[0]
    ?.totalSpend,
  300,
);
t.eq(
  'average is spend over VISITS, not over transactions',
  // Two sales the same day = one visit, so average equals the day's total.
  buildCustomerProfiles(
    [cust()],
    [
      txn({ amount: 100, created_at: '2026-07-22 09:00:00' }),
      txn({ amount: 300, created_at: '2026-07-22 15:00:00' }),
    ],
    { asOfDateKey: AS_OF },
  )[0]?.averageSpend,
  400,
);

t.section('H3. buildCustomerProfiles — dates and channels');
const future = buildCustomerProfiles(
  [cust()],
  [txn({ created_at: '2026-07-30 09:00:00' })],
  { asOfDateKey: AS_OF },
);
t.eq('a future-dated row yields negative daysSinceLastVisit', future[0]?.daysSinceLastVisit, -4);
t.eq(
  'channels are deduped and sorted',
  buildCustomerProfiles(
    [cust()],
    [txn({ channel: 'mpesa_buygoods' }), txn({ channel: 'cash' }), txn({ channel: 'cash' })],
    { asOfDateKey: AS_OF },
  )[0]?.channels,
  ['cash', 'mpesa_buygoods'],
);
t.eq(
  'firstVisit and lastVisit bracket the range regardless of input order',
  buildCustomerProfiles(
    [cust()],
    [
      txn({ created_at: '2026-07-24 09:00:00' }),
      txn({ created_at: '2026-07-20 09:00:00' }),
      txn({ created_at: '2026-07-22 09:00:00' }),
    ],
    { asOfDateKey: AS_OF },
  ).map((p) => [p.firstVisit, p.lastVisit])[0],
  ['2026-07-20', '2026-07-24'],
);
t.eq('exactly 2 visits makes a regular',
  buildCustomerProfiles(
    [cust()],
    [txn({ created_at: '2026-07-22 09:00:00' }), txn({ created_at: '2026-07-23 09:00:00' })],
    { asOfDateKey: AS_OF },
  )[0]?.isRepeat,
  true,
);
t.eq(
  'one visit is not',
  buildCustomerProfiles([cust()], [txn()], { asOfDateKey: AS_OF })[0]?.isRepeat,
  false,
);
t.throws(
  'one malformed timestamp fails loudly rather than silently undercounting',
  () => buildCustomerProfiles([cust()], [txn({ created_at: 'yesterday' })], { asOfDateKey: AS_OF }),
  /Unparseable/,
);

t.section('H4. round2');
t.eq('classic float artefact', round2(0.1 + 0.2), 0.3);
t.eq('rounds half up', round2(1.005), 1.01);
t.eq('negative', round2(-1.005), -1);
t.eq('integer unchanged', round2(500), 500);
t.eq('zero', round2(0), 0);

// ===========================================================================
// I. Ranking
// ===========================================================================

t.section('I. rankRegulars');
const profileFor = (name: string, visits: number, spend: number, last: string) => ({
  customerId: name.length,
  displayName: name,
  visitCount: visits,
  totalSpend: spend,
  averageSpend: spend / Math.max(1, visits),
  firstVisit: '2026-07-20',
  lastVisit: last,
  daysSinceLastVisit: 0,
  isRepeat: visits >= 2,
  channels: [] as never[],
  includesUnconfirmed: false,
});

t.eq('empty input', rankRegulars([]), []);
t.eq('limit 0 returns nothing', rankRegulars([profileFor('A', 3, 300, '2026-07-25')], 0), []);
t.eq('negative limit is clamped to 0', rankRegulars([profileFor('A', 3, 300, '2026-07-25')], -5), []);
t.eq(
  'limit larger than the list is fine',
  rankRegulars([profileFor('A', 3, 300, '2026-07-25')], 99).length,
  1,
);
t.eq(
  'visits beat spend',
  rankRegulars([profileFor('Big', 1, 9999, '2026-07-25'), profileFor('Loyal', 5, 100, '2026-07-25')]).map(
    (r) => r.displayName,
  ),
  ['Loyal', 'Big'],
);
t.eq(
  'equal visits fall back to spend',
  rankRegulars([profileFor('Low', 3, 100, '2026-07-25'), profileFor('High', 3, 900, '2026-07-25')]).map(
    (r) => r.displayName,
  ),
  ['High', 'Low'],
);
t.eq(
  'equal visits and spend fall back to recency',
  rankRegulars([profileFor('Older', 3, 100, '2026-07-20'), profileFor('Newer', 3, 100, '2026-07-25')]).map(
    (r) => r.displayName,
  ),
  ['Newer', 'Older'],
);
t.eq(
  'a total tie falls back to name, so the order is deterministic',
  rankRegulars([profileFor('Zawadi', 3, 100, '2026-07-25'), profileFor('Amina', 3, 100, '2026-07-25')]).map(
    (r) => r.displayName,
  ),
  ['Amina', 'Zawadi'],
);
t.eq(
  'ranks are 1-based and contiguous',
  rankRegulars([
    profileFor('A', 1, 10, '2026-07-25'),
    profileFor('B', 2, 10, '2026-07-25'),
    profileFor('C', 3, 10, '2026-07-25'),
  ]).map((r) => r.rank),
  [1, 2, 3],
);
t.eq(
  'ranking does not mutate the input array order',
  (() => {
    const input = [profileFor('B', 1, 10, '2026-07-25'), profileFor('A', 9, 10, '2026-07-25')];
    rankRegulars(input);
    return input.map((p) => p.displayName);
  })(),
  ['B', 'A'],
);

// ===========================================================================
// J. Weekly summary
// ===========================================================================

t.section('J. buildRegularsSummary');
const emptySummary = buildRegularsSummary([], [], { asOfDateKey: AS_OF });
t.eq('empty ledger: no regulars', emptySummary.regulars, []);
t.eq('empty ledger: zero counts', [emptySummary.namedCustomerCount, emptySummary.repeatCustomerCount], [0, 0]);
t.eq('empty ledger: zero spend', emptySummary.namedCustomerSpend, 0);
t.eq('empty ledger: nothing lapsing', emptySummary.lapsing, []);
t.eq('empty ledger: not flagged unconfirmed', emptySummary.includesUnconfirmed, false);
t.eq('empty ledger: window still reported', [emptySummary.periodStart, emptySummary.periodEnd], [
  '2026-07-20',
  AS_OF,
]);

// A regular entirely outside the window: absent from `regulars`, present in `lapsing`.
const lapsedOnly = buildRegularsSummary(
  [cust({ id: 1, name: 'Grace' })],
  [
    txn({ customer_id: 1, created_at: '2026-07-05 09:00:00' }),
    txn({ customer_id: 1, created_at: '2026-07-10 09:00:00' }),
  ],
  { asOfDateKey: AS_OF },
);
t.eq('nobody came this week', lapsedOnly.regulars, []);
t.eq('but the lapsed regular is surfaced', lapsedOnly.lapsing.map((r) => r.displayName), ['Grace']);
t.eq('with full-history recency', lapsedOnly.lapsing[0]?.daysSinceLastVisit, 16);

// Exactly on the lapsing threshold.
const atThreshold = buildRegularsSummary(
  [cust({ id: 1, name: 'Edge' })],
  [
    txn({ customer_id: 1, created_at: '2026-07-10 09:00:00' }),
    txn({ customer_id: 1, created_at: '2026-07-16 09:00:00' }), // exactly 10 days before AS_OF
  ],
  { asOfDateKey: AS_OF },
);
t.eq('exactly LAPSED_AFTER_DAYS counts as lapsing', atThreshold.lapsing.length, 1);

const justInside = buildRegularsSummary(
  [cust({ id: 1, name: 'Edge' })],
  [
    txn({ customer_id: 1, created_at: '2026-07-10 09:00:00' }),
    txn({ customer_id: 1, created_at: '2026-07-17 09:00:00' }), // 9 days
  ],
  { asOfDateKey: AS_OF },
);
t.eq('nine days is not yet lapsing', justInside.lapsing, []);

// A one-visit customer who vanished is NOT a lapsing "regular".
t.eq(
  'a single-visit customer is never called lapsing',
  buildRegularsSummary(
    [cust({ id: 1, name: 'Passerby' })],
    [txn({ customer_id: 1, created_at: '2026-06-01 09:00:00' })],
    { asOfDateKey: AS_OF },
  ).lapsing,
  [],
);

t.eq(
  'limit truncates the list but not the counts',
  (() => {
    const customers = [1, 2, 3, 4].map((id) => cust({ id, name: `C${id}` }));
    const txns = customers.flatMap((c) => [
      txn({ customer_id: c.id, created_at: '2026-07-22 09:00:00' }),
      txn({ customer_id: c.id, created_at: '2026-07-23 09:00:00' }),
    ]);
    const s = buildRegularsSummary(customers, txns, { asOfDateKey: AS_OF, limit: 2 });
    return [s.regulars.length, s.namedCustomerCount, s.repeatCustomerCount];
  })(),
  [2, 4, 4],
);
t.eq(
  'anonymous cash never reaches namedCustomerSpend',
  buildRegularsSummary(
    [cust({ id: 1, name: 'Mary' })],
    [txn({ customer_id: 1, amount: 100 }), txn({ customer_id: null, amount: 999 })],
    { asOfDateKey: AS_OF },
  ).namedCustomerSpend,
  100,
);
t.eq(
  'windowDays 1 sees only the as-of day',
  buildRegularsSummary(
    [cust({ id: 1, name: 'Mary' })],
    [txn({ customer_id: 1, created_at: '2026-07-25 09:00:00' })],
    { asOfDateKey: AS_OF, windowDays: 1 },
  ).regulars,
  [],
);

// ===========================================================================
// K. Live repeat detection
// ===========================================================================

t.section('K. detectRepeatVisit');
const first = detectRepeatVisit([], 1, '2026-07-26 09:00:00');
t.eq('empty history is not a repeat', first.isRepeat, false);
t.eq('and counts as visit 1', first.visitNumber, 1);
t.eq('with no previous date', first.previousVisitDate, null);

t.eq(
  'other customers rows are ignored',
  detectRepeatVisit([txn({ customer_id: 2, created_at: '2026-07-20 09:00:00' })], 1, '2026-07-26 09:00:00')
    .isRepeat,
  false,
);
t.eq(
  'a restock does not make someone a returning customer',
  detectRepeatVisit(
    [txn({ customer_id: 1, type: 'restock', created_at: '2026-07-20 09:00:00' })],
    1,
    '2026-07-26 09:00:00',
  ).isRepeat,
  false,
);
t.eq(
  'a second purchase the same day is not a new visit',
  detectRepeatVisit(
    [txn({ customer_id: 1, created_at: '2026-07-26 08:00:00' })],
    1,
    '2026-07-26 15:00:00',
  ),
  { isRepeat: false, visitNumber: 1, previousVisitDate: null },
);
t.eq(
  'the new row need not already be in history',
  detectRepeatVisit(
    [txn({ customer_id: 1, created_at: '2026-07-20 09:00:00' })],
    1,
    '2026-07-26 09:00:00',
  ),
  { isRepeat: true, visitNumber: 2, previousVisitDate: '2026-07-20' },
);
t.eq(
  'duplicate history rows for one day count once',
  detectRepeatVisit(
    [
      txn({ customer_id: 1, created_at: '2026-07-20 09:00:00' }),
      txn({ customer_id: 1, created_at: '2026-07-20 18:00:00' }),
    ],
    1,
    '2026-07-26 09:00:00',
  ).visitNumber,
  2,
);
// A row dated after the visit being reported must not inflate "visit number N".
t.eq(
  'later-dated rows do not inflate this visit number',
  detectRepeatVisit(
    [
      txn({ customer_id: 1, created_at: '2026-07-20 09:00:00' }),
      txn({ customer_id: 1, created_at: '2026-07-30 09:00:00' }),
    ],
    1,
    '2026-07-26 09:00:00',
  ).visitNumber,
  2,
);

// ===========================================================================
// L. Money formatting
// ===========================================================================

t.section('L. formatKes');
t.eq('zero', formatKes(0), 'KES 0');
t.eq('thousands separator', formatKes(1250), 'KES 1,250');
t.eq('millions', formatKes(1234567), 'KES 1,234,567');
t.eq('cents round away', formatKes(1250.4), 'KES 1,250');
t.eq('cents round up', formatKes(1250.6), 'KES 1,251');
t.eq('sub-shilling collapses to zero', formatKes(0.4), 'KES 0');
t.eq('negative', formatKes(-250), '-KES 250');
t.eq('no non-breaking space survives', / | /.test(formatKes(1250)), false);

// ===========================================================================
// M. The figure-preservation guard
// ===========================================================================

function summaryWith(regulars: Array<[string, number, number]>, lapsing: string[] = []): RegularsSummary {
  const mk = (name: string, visits: number, spend: number, rank: number) => ({
    ...profileFor(name, visits, spend, '2026-07-25'),
    rank,
  });
  return {
    periodStart: '2026-07-20',
    periodEnd: AS_OF,
    regulars: regulars.map(([n, v, s], i) => mk(n, v, s, i + 1)),
    repeatCustomerCount: regulars.filter(([, v]) => v >= 2).length,
    namedCustomerCount: regulars.length,
    namedCustomerSpend: regulars.reduce((sum, [, , s]) => sum + s, 0),
    includesUnconfirmed: false,
    lapsing: lapsing.map((n, i) => mk(n, 2, 100, i + 1)),
  };
}

t.section('M. figuresToPreserve / assertFiguresPreserved');
const oneRegular = summaryWith([['Mary Wanjiku', 3, 1000]]);
t.eq('name and money are required', figuresToPreserve(oneRegular).includes('KES 1,000'), true);
t.eq('the aggregate spend is NOT required', figuresToPreserve(oneRegular).includes('KES 1,000,000'), false);
t.eq('deterministic text passes', assertFiguresPreserved(renderRegularsSummaryText(oneRegular), oneRegular).ok, true);
t.eq(
  'an altered figure is caught',
  assertFiguresPreserved(renderRegularsSummaryText(oneRegular).replace('KES 1,000', 'KES 1,100'), oneRegular).ok,
  false,
);
t.eq(
  'a dropped name is caught',
  assertFiguresPreserved('Mambo! Wateja wako 3 visits KES 1,000', oneRegular).missing,
  ['Mary Wanjiku'],
);
t.eq(
  'rewrapped whitespace still passes',
  assertFiguresPreserved(
    renderRegularsSummaryText(oneRegular).replace(/\n/g, '   \n  '),
    oneRegular,
  ).ok,
  true,
);
t.eq(
  'a non-breaking space in the model output still passes',
  assertFiguresPreserved('Mary Wanjiku 3 visits KES 1,000', oneRegular).ok,
  true,
);
// An empty week has no figures, so substring matching cannot protect anything.
// The model is skipped entirely in that case — see draftRegularsSummary.
t.eq('an empty summary has nothing to preserve', figuresToPreserve(summaryWith([])), []);

t.section('M2. renderRegularsSummaryText / renderFactsBlock');
t.eq(
  'empty week says so plainly',
  renderRegularsSummaryText(summaryWith([])).includes('hakuna customer wa jina'),
  true,
);
t.eq(
  'facts block never leaks the aggregate spend to the model',
  renderFactsBlock(summaryWith([['Mary', 3, 1000]])).includes('Spend by named customers'),
  false,
);
t.eq(
  'unconfirmed entries are disclosed, not hidden',
  renderRegularsSummaryText({ ...summaryWith([['Mary', 3, 1000]]), includesUnconfirmed: true }).includes(
    'hujathibitisha',
  ),
  true,
);
t.eq(
  'singular vs plural visit wording',
  [
    renderRegularsSummaryText(summaryWith([['A', 1, 10]])).includes('1 visit,'),
    renderRegularsSummaryText(summaryWith([['B', 2, 10]])).includes('2 visits,'),
  ],
  [true, true],
);
t.eq(
  'a name with regex metacharacters is handled literally',
  assertFiguresPreserved(
    renderRegularsSummaryText(summaryWith([['Mary (a.b*c)', 2, 100]])),
    summaryWith([['Mary (a.b*c)', 2, 100]]),
  ).ok,
  true,
);

// ===========================================================================
// N. Drafting — every way the model can misbehave
// ===========================================================================

void (async () => {
  t.section('N. draftRegularsSummary — model failure modes');
  const s = summaryWith([['Mary Wanjiku', 3, 1000]], ['Grace']);
  const good = renderRegularsSummaryText(s);

  t.eq('no runner -> deterministic', (await draftRegularsSummary(s)).source, 'deterministic-fallback');
  t.eq(
    'faithful phrasing accepted',
    (await draftRegularsSummary(s, async () => good)).source,
    'claude',
  );
  t.eq(
    'dropped figures rejected',
    (await draftRegularsSummary(s, async () => 'Mambo! Wateja wako wanaendelea vizuri.')).source,
    'deterministic-fallback',
  );
  t.eq(
    'altered figure rejected',
    (await draftRegularsSummary(s, async () => good.replace('KES 1,000', 'KES 9,999'))).source,
    'deterministic-fallback',
  );
  t.eq(
    'thrown error rejected without propagating',
    (
      await draftRegularsSummary(s, async () => {
        throw new Error('ECONNRESET');
      })
    ).source,
    'deterministic-fallback',
  );
  t.eq(
    'a non-Error throw is also survivable',
    (
      await draftRegularsSummary(s, async () => {
        throw 'string failure';
      })
    ).source,
    'deterministic-fallback',
  );
  t.eq(
    'empty model output rejected',
    (await draftRegularsSummary(s, async () => '')).source,
    'deterministic-fallback',
  );
  t.eq(
    'whitespace-only model output rejected',
    (await draftRegularsSummary(s, async () => '   \n  ')).source,
    'deterministic-fallback',
  );
  t.eq(
    'surrounding whitespace is trimmed, not treated as corruption',
    (await draftRegularsSummary(s, async () => `\n\n${good}\n\n`)).source,
    'claude',
  );
  t.eq(
    'fallback text is always non-empty',
    (await draftRegularsSummary(s, async () => '')).text.length > 0,
    true,
  );
  t.eq(
    'the rejection reason names what went missing',
    (await draftRegularsSummary(s, async () => 'nothing useful')).rejectedReason?.includes('KES 1,000'),
    true,
  );
  // With no regulars there are no figures to verify, so the model is not trusted.
  t.eq(
    'an empty week never uses model output',
    (await draftRegularsSummary(summaryWith([]), async () => 'I invented a customer called Fatuma.')).source,
    'deterministic-fallback',
  );

  t.section('N2. draftWinBackPromo');
  const noLapse = summaryWith([['Mary', 3, 1000]], []);
  const withLapse = summaryWith([['Mary', 3, 1000]], ['Grace']);

  t.eq('no lapsing customers -> no recipients', (await draftWinBackPromo(noLapse, 'offer')).recipients, []);
  t.eq(
    'and says a promo is not needed',
    (await draftWinBackPromo(noLapse, 'offer')).text.includes('Hakuna promo'),
    true,
  );
  t.eq(
    'no model call is made when there is nobody to win back',
    (
      await draftWinBackPromo(noLapse, 'offer', async () => {
        throw new Error('should never be called');
      })
    ).source,
    'deterministic-fallback',
  );
  t.eq(
    'the offer is passed through verbatim',
    (await draftWinBackPromo(withLapse, 'sukari punguzo kidogo')).text.includes('sukari punguzo kidogo'),
    true,
  );
  t.eq(
    'an empty offer invents no discount',
    /\d+\s*%|punguzo\s+ya\s+\d/i.test((await draftWinBackPromo(withLapse, '')).text),
    false,
  );
  t.eq(
    'a whitespace-only offer behaves like an empty one',
    (await draftWinBackPromo(withLapse, '    ')).text.includes('Karibu tena wiki hii'),
    true,
  );
  t.eq(
    'empty model output falls back',
    (await draftWinBackPromo(withLapse, 'offer', async () => '   ')).source,
    'deterministic-fallback',
  );
  t.eq(
    'a model failure still yields a sendable draft',
    (
      await draftWinBackPromo(withLapse, 'offer', async () => {
        throw new Error('down');
      })
    ).text.length > 0,
    true,
  );

  t.finish();
})();
