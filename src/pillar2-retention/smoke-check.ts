/**
 * P2 — Retention: known-answer smoke check.
 *
 *     npx ts-node src/pillar2-retention/smoke-check.ts
 *
 * Not a substitute for a test suite — `package.json` has no test runner and
 * adding one is a shared-surface decision, so this is the interim. It runs
 * offline with no API key and no database: every figure below is asserted
 * against a hand-computed expected value, so a regression in the retention
 * arithmetic fails loudly here rather than quietly on stage.
 *
 * The cases are chosen to pin the decisions documented in this folder's
 * README — the ones that would otherwise silently drift.
 */

import {
  buildCustomerProfiles,
  canonicalizeCustomers,
  findDuplicateCandidates,
  normalizeCreatedAt,
  normalizeName,
  toEatDateKey,
} from './customer-profile';
import {
  assertFiguresPreserved,
  draftRegularsSummary,
  draftWinBackPromo,
  renderRegularsSummaryText,
} from './promo-drafts';
import { buildRegularsSummary, detectRepeatVisit, trailingWindow } from './repeat-detection';
import type { Customer, Transaction } from './types';

// ---------------------------------------------------------------------------
// Tiny assertion helpers (no dependencies)
// ---------------------------------------------------------------------------

let checks = 0;
const failures: string[] = [];

function eq(label: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
    failures.push(label);
  }
}

// ---------------------------------------------------------------------------
// Fixture. Fictional names, as required by CONTRIBUTING §6.
// ---------------------------------------------------------------------------

const AS_OF = '2026-07-26';

const customers: Customer[] = [
  { id: 1, name: 'Mary Wanjiku', phone: null, disambiguator: null, first_seen: null, last_seen: null },
  // Same human as id 1, different SMS casing — the duplicate-detection case.
  { id: 2, name: 'MARY  WANJIKU', phone: null, disambiguator: null, first_seen: null, last_seen: null },
  { id: 3, name: 'Otieno', phone: null, disambiguator: null, first_seen: null, last_seen: null },
  { id: 4, name: 'Grace', phone: null, disambiguator: null, first_seen: null, last_seen: null },
];

let nextId = 1;
function txn(
  customer_id: number | null,
  type: Transaction['type'],
  amount: number,
  created_at: string,
  confirmed: 0 | 1 = 1,
): Transaction {
  return {
    id: nextId++,
    customer_id,
    type,
    amount,
    channel: 'mpesa_buygoods',
    confirmed,
    raw_input: null,
    created_at,
  };
}

const transactions: Transaction[] = [
  // Mary id 1 — two sales the SAME EAT day: must count as ONE visit.
  txn(1, 'sale', 200, '2026-07-22 09:00:00'),
  txn(1, 'sale', 300, '2026-07-22 12:00:00'),
  // deni counts as spend and as a visit...
  txn(1, 'deni', 400, '2026-07-23 09:00:00'),
  // ...its repayment counts as a visit but NOT again as spend.
  txn(1, 'deni_repayment', 400, '2026-07-24 09:00:00'),
  txn(1, 'sale', 100, '2026-07-24 10:00:00'),
  // restock is the owner buying stock: never a visit, never spend, even though
  // it carries a customer_id here to prove the type filter is what excludes it.
  txn(1, 'restock', 5000, '2026-07-26 08:00:00'),

  // Duplicate-casing row, one visit only.
  txn(2, 'sale', 50, '2026-07-21 09:00:00'),

  // Otieno id 3 — the timezone case. Both rows are 2026-07-25 in UTC, but the
  // second is 01:00 EAT on the 26th. Naive UTC bucketing gives 1 visit; correct
  // EAT bucketing gives 2.
  txn(3, 'sale', 150, '2026-07-25 18:30:00'),
  txn(3, 'sale', 250, '2026-07-25 22:00:00'),

  // Grace id 4 — a regular who has gone quiet. Outside the 7-day window.
  txn(4, 'sale', 300, '2026-07-05 09:00:00'),
  txn(4, 'sale', 200, '2026-07-10 09:00:00'),

  // Anonymous cash: P2 cannot attribute it, so it must not reach any figure.
  txn(null, 'sale', 999, '2026-07-23 15:00:00'),
];

// ---------------------------------------------------------------------------
// 1. Date bucketing
// ---------------------------------------------------------------------------

console.log('\nEAT date bucketing (Kenya is UTC+3, no DST)');
eq('bare SQLite DATETIME treated as UTC then shifted', toEatDateKey('2026-07-25 18:30:00'), '2026-07-25');
eq('22:00 UTC lands on the NEXT EAT day', toEatDateKey('2026-07-25 22:00:00'), '2026-07-26');
eq('explicit +03:00 offset is respected, not double-shifted', toEatDateKey('2026-07-26T01:00:00+03:00'), '2026-07-26');
eq('7-day trailing window is inclusive both ends', trailingWindow(AS_OF, 7), {
  startKey: '2026-07-20',
  endKey: '2026-07-26',
});

// ---------------------------------------------------------------------------
// 2. Name normalisation and duplicate reporting
// ---------------------------------------------------------------------------

console.log('\nPayer-name normalisation');
eq('shouty + double-spaced collapses', normalizeName('MARY  WANJIKU'), 'mary wanjiku');
eq('trailing punctuation dropped', normalizeName('mary wanjiku.'), 'mary wanjiku');
eq('null is safe', normalizeName(null), '');

const dupes = findDuplicateCandidates(customers);
eq('exactly one duplicate pair found', dupes.length, 1);
eq('the pair is ids 1 and 2', [dupes[0]?.a.id, dupes[0]?.b.id], [1, 2]);
eq('not flagged as deliberately disambiguated', dupes[0]?.disambiguated, false);

// ---------------------------------------------------------------------------
// 2b. Cross-pillar sync: timestamp conventions
// ---------------------------------------------------------------------------

console.log('\nRead-boundary timestamp normalisation (P1 writes three formats)');
eq(
  'naive read as UTC (SQLite CURRENT_TIMESTAMP)',
  normalizeCreatedAt('2026-07-25 19:00:00', 'utc'),
  '2026-07-25T19:00:00Z',
);
eq(
  'naive read as EAT (P1 parse-mpesa-sms output)',
  normalizeCreatedAt('2026-07-25T22:00:00', 'eat'),
  '2026-07-25T22:00:00+03:00',
);
eq(
  'an explicit Z is left alone',
  normalizeCreatedAt('2026-07-25T19:00:00.000Z', 'eat'),
  '2026-07-25T19:00:00.000Z',
);
eq(
  'an explicit +03:00 is left alone',
  normalizeCreatedAt('2026-07-25T22:00:00+03:00', 'utc'),
  '2026-07-25T22:00:00+03:00',
);
// The bug this exists to prevent: a 22:00 EAT M-Pesa sale filed a day late.
eq(
  'naive EAT normalised to +03:00 lands on the correct EAT day',
  toEatDateKey(normalizeCreatedAt('2026-07-25T22:00:00', 'eat')),
  '2026-07-25',
);
eq(
  'the same string read as UTC slips to the next day (why the option exists)',
  toEatDateKey(normalizeCreatedAt('2026-07-25T22:00:00', 'utc')),
  '2026-07-26',
);

// ---------------------------------------------------------------------------
// 2c. Cross-pillar sync: P1 upserts customers on exact name
// ---------------------------------------------------------------------------

console.log('\nDuplicate-name canonicalisation (read-time, never written)');
const canonical = canonicalizeCustomers(customers, transactions);
eq('one merge performed', canonical.merges.length, 1);
eq('id 2 folded into id 1 (earliest sighting wins)', canonical.merges[0]?.mergedIds, [2]);
eq('canonical id is the lowest', canonical.merges[0]?.canonicalId, 1);
eq('the merged row is dropped from customers', canonical.customers.some((c) => c.id === 2), false);
eq('no transaction still points at the merged row', canonical.transactions.some((t) => t.customer_id === 2), false);
eq('nothing was lost — same transaction count', canonical.transactions.length, transactions.length);

// A customer the owner deliberately disambiguated must never be merged away.
const withDisambiguator = [
  ...customers,
  { id: 5, name: 'Mary Wanjiku', phone: null, disambiguator: 'shop next door', first_seen: null, last_seen: null },
];
const guarded = canonicalizeCustomers(withDisambiguator, transactions);
eq('a disambiguated same-name row survives', guarded.customers.some((c) => c.id === 5), true);
eq('and is not listed as merged', guarded.merges.flatMap((m) => m.mergedIds).includes(5), false);

// ---------------------------------------------------------------------------
// 3. Profiles
// ---------------------------------------------------------------------------

console.log('\nProfile arithmetic');
const profiles = buildCustomerProfiles(customers, transactions, { asOfDateKey: AS_OF });
const mary = profiles.find((p) => p.customerId === 1);
const otieno = profiles.find((p) => p.customerId === 3);
const grace = profiles.find((p) => p.customerId === 4);

eq('Mary: 2 same-day sales + deni + repayment + sale = 3 visits', mary?.visitCount, 3);
eq('Mary: spend is sale+deni only (200+300+400+100), repayment excluded', mary?.totalSpend, 1000);
eq('Mary: restock on the 26th did not create a visit', mary?.lastVisit, '2026-07-24');
eq('Otieno: UTC-same-day rows are 2 EAT visits', otieno?.visitCount, 2);
eq('Grace: lifetime 2 visits', grace?.visitCount, 2);
eq('Grace: 16 days since last visit', grace?.daysSinceLastVisit, 16);
eq('anonymous cash produced no profile', profiles.some((p) => p.totalSpend === 999), false);
eq('all rows confirmed, so nothing is flagged unconfirmed', mary?.includesUnconfirmed, false);

// ---------------------------------------------------------------------------
// 4. Repeat detection (the live demo moment)
// ---------------------------------------------------------------------------

console.log('\nRepeat-visit detection');
const visit = detectRepeatVisit(transactions, 1, '2026-07-24 10:00:00');
eq('Mary is a returning face', visit.isRepeat, true);
eq('it is her 3rd visit', visit.visitNumber, 3);
eq('previous visit was the 23rd', visit.previousVisitDate, '2026-07-23');

const firstEver = detectRepeatVisit([], 99, '2026-07-26 09:00:00');
eq('a brand-new customer is not a repeat', firstEver.isRepeat, false);
eq('and it is their 1st visit', firstEver.visitNumber, 1);

// ---------------------------------------------------------------------------
// 5. Weekly summary
// ---------------------------------------------------------------------------

console.log('\nWeekly regulars summary');
const summary = buildRegularsSummary(customers, transactions, { asOfDateKey: AS_OF });

eq('window', [summary.periodStart, summary.periodEnd], ['2026-07-20', '2026-07-26']);
eq('3 named customers in window (Grace is outside it)', summary.namedCustomerCount, 3);
eq('2 of them are repeat visitors', summary.repeatCustomerCount, 2);
eq('named spend 1000+50+400, excludes the 999 anonymous sale', summary.namedCustomerSpend, 1450);
eq(
  'ranked by visits desc',
  summary.regulars.map((r) => [r.rank, r.displayName, r.visitCount]),
  [
    [1, 'Mary Wanjiku', 3],
    [2, 'Otieno', 2],
    [3, 'MARY  WANJIKU', 1],
  ],
);
eq('Grace is the only lapsing regular', summary.lapsing.map((r) => r.displayName), ['Grace']);
eq('lapsing is measured on full history, not the window', summary.lapsing[0]?.daysSinceLastVisit, 16);

// The same summary over the canonicalised ledger — what the owner actually sees
// once P1's exact-name duplicates are folded together. Mary appears ONCE with
// her visits combined, instead of twice with them split.
console.log('\nWeekly summary over the canonicalised ledger');
const merged = buildRegularsSummary(canonical.customers, canonical.transactions, {
  asOfDateKey: AS_OF,
});
eq('Mary is listed once, not twice', merged.regulars.filter((r) => /mary/i.test(r.displayName)).length, 1);
eq(
  'her visits are combined (07-21 + 07-22 + 07-23 + 07-24)',
  merged.regulars.find((r) => /mary/i.test(r.displayName))?.visitCount,
  4,
);
eq(
  'and so is her spend (1000 + 50)',
  merged.regulars.find((r) => /mary/i.test(r.displayName))?.totalSpend,
  1050,
);
eq('2 named customers now, not 3', merged.namedCustomerCount, 2);
eq('total named spend is unchanged by merging', merged.namedCustomerSpend, summary.namedCustomerSpend);

// ---------------------------------------------------------------------------
// 6. The README §5 guard
// ---------------------------------------------------------------------------

console.log('\nFigure-preservation guard (model may phrase, never compute)');
const deterministic = renderRegularsSummaryText(summary);
eq('deterministic text passes its own guard', assertFiguresPreserved(deterministic, summary).ok, true);
eq('deterministic text contains the computed spend', deterministic.includes('KES 1,000'), true);

const tampered = deterministic.replace('KES 1,000', 'KES 1,100');
eq('a single altered figure is caught', assertFiguresPreserved(tampered, summary).ok, false);

// A model that returns fluent prose with no figures must be rejected.
const fluentButEmpty = async () => 'Mambo! Wateja wako wanaendelea vizuri wiki hii. Karibu tena!';
const tamperingModel = async () => deterministic.replace('KES 1,000', 'KES 9,999');

void (async () => {
  const offline = await draftRegularsSummary(summary);
  eq('no model -> deterministic fallback', offline.source, 'deterministic-fallback');

  const dropped = await draftRegularsSummary(summary, fluentButEmpty);
  eq('model dropping figures -> rejected', dropped.source, 'deterministic-fallback');
  eq('and the reason names the missing figures', (dropped.rejectedReason ?? '').includes('KES 1,000'), true);

  const altered = await draftRegularsSummary(summary, tamperingModel);
  eq('model altering a figure -> rejected', altered.source, 'deterministic-fallback');

  const good = await draftRegularsSummary(summary, async () => deterministic);
  eq('model preserving every figure -> accepted', good.source, 'claude');

  const thrower = async () => {
    throw new Error('network down');
  };
  const survived = await draftRegularsSummary(summary, thrower);
  eq('a failed model call never throws', survived.source, 'deterministic-fallback');
  eq('and still yields sendable text', survived.text.length > 0, true);

  console.log('\nPromo drafting');
  const promo = await draftWinBackPromo(summary, 'sukari punguzo kidogo wiki hii');
  eq('promo targets the lapsing regular', promo.recipients.map((r) => r.displayName), ['Grace']);
  eq('offer wording is passed through verbatim', promo.text.includes('sukari punguzo kidogo wiki hii'), true);

  const noOffer = await draftWinBackPromo(summary, '');
  eq('empty offer invents no discount', /\d+\s*%|punguzo\s+ya/i.test(noOffer.text), false);

  // ---------------------------------------------------------------------
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
})();
