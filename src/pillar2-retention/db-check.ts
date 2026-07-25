/**
 * P2 — Retention: database-layer edge cases.
 *
 *     npx ts-node src/pillar2-retention/db-check.ts
 *
 * Covers what `edge-cases.ts` cannot: `queries.ts` and `service.ts` against a
 * real SQLite file, with rows written exactly the way P1's parsers write them —
 * mixed timestamp formats, duplicate-cased payer names, anonymous cash,
 * unconfirmed entries, orphan rows and NULL columns.
 *
 * Requires a working `better-sqlite3` binding. On Node 24 that means
 * `better-sqlite3@^12`; version 11 has no prebuild and will fail to load. It
 * builds its own throwaway database and deletes it afterwards, so it never
 * touches `duka.db`.
 *
 * The INSERTs below are test fixtures standing in for P1. P2 itself never
 * writes — see `queries.ts`.
 */

import fs from 'fs';
import path from 'path';

import { createCheckRun } from './check-utils';

const DB_FILE = path.join(process.cwd(), `p2-db-check-${process.pid}.db`);

// Must be set before anything imports core/config, which is why every import
// below is dynamic: core/db opens config.dbPath at module load.
process.env.DB_PATH = DB_FILE;

const t = createCheckRun();

/** Held outside `main` so cleanup can close the file even if a check throws. */
let handle: { close(): void } | undefined;

async function main(): Promise<void> {
  const { default: db } = await import('../core/db');
  const { initDb } = await import('../core/db');
  handle = db;
  const { loadCustomers, loadTransactions, loadTransactionsForCustomer, loadLedger, findCustomerByName } =
    await import('./queries');
  const { getRegularsSummary, getWeeklyRegularsMessage, getRepeatVisit, detectRepeatVisits, getDuplicateCandidates, todayInEat } =
    await import('./service');
  const { toEatDateKey } = await import('./customer-profile');

  initDb();

  // --- Fixtures, written as P1's parsers write them -------------------------
  const insC = db.prepare(
    `INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`,
  );
  // 1,2: same human, two SMS casings (P1 upserts on exact name)
  insC.run('MARY WANJIKU', null, null, '2026-07-20T09:00:00', '2026-07-24T09:00:00');
  insC.run('Mary Wanjiku', null, null, '2026-07-24T09:00:00', '2026-07-24T09:00:00');
  // 3: the 22:10 EAT sale — the timezone case
  insC.run('PETER OTIENO', null, null, '2026-07-25T18:00:00', '2026-07-25T22:10:00');
  // 4: lapsed regular
  insC.run('GRACE MUTHONI', null, null, '2026-07-05T09:00:00', '2026-07-10T09:00:00');
  // 5: NULL name — must not crash anything, must never be merged
  insC.run(null, null, null, null, null);
  // 6,7: deliberately disambiguated same-name pair — must never be merged
  insC.run('JOHN KAMAU', null, 'blue uniform', '2026-07-21T09:00:00', '2026-07-21T09:00:00');
  insC.run('JOHN KAMAU', null, 'shop next door', '2026-07-22T09:00:00', '2026-07-22T09:00:00');

  const insT = db.prepare(
    `INSERT INTO transactions (customer_id, type, amount, channel, confirmed, raw_input, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // P1 parseMpesaSms: naive EAT, confirmed = 1
  insT.run(1, 'sale', 500, 'mpesa_buygoods', 1, 'sms', '2026-07-20T09:15:00');
  insT.run(1, 'sale', 300, 'mpesa_buygoods', 1, 'sms', '2026-07-22T09:20:00');
  insT.run(2, 'sale', 250, 'mpesa_buygoods', 1, 'sms', '2026-07-24T10:00:00');
  insT.run(3, 'sale', 400, 'mpesa_buygoods', 1, 'sms', '2026-07-25T22:10:00');
  // P1 parseTransaction: explicit UTC, confirmed = 0
  insT.run(null, 'sale', 120, 'cash', 0, 'unga 120 cash', '2026-07-23T12:00:00.000Z');
  insT.run(1, 'deni', 200, 'cash', 0, 'Mary deni', '2026-07-22T14:00:00.000Z');
  insT.run(1, 'deni_repayment', 200, 'cash', 0, 'Mary alilipa', '2026-07-24T14:00:00.000Z');
  // Grace, lapsed
  insT.run(4, 'sale', 300, 'mpesa_buygoods', 1, 'sms', '2026-07-05T09:10:00');
  insT.run(4, 'sale', 200, 'mpesa_buygoods', 1, 'sms', '2026-07-10T09:10:00');
  // Owner restock — never a visit
  insT.run(1, 'restock', 5000, 'cash', 1, 'restock', '2026-07-26T06:00:00.000Z');

  // An orphan row: transactions.customer_id references a customer that does not
  // exist. Worth knowing that better-sqlite3 turns `PRAGMA foreign_keys` ON by
  // default, so the schema's REFERENCES clause actually blocks this — the insert
  // fails with "FOREIGN KEY constraint failed" unless enforcement is lifted.
  // Lifted deliberately here to prove P2's defensive skip still works if bad data
  // ever does appear (a raw import, a migration, FKs off in another environment).
  db.pragma('foreign_keys = OFF');
  insT.run(999, 'sale', 777, 'cash', 1, 'orphan', '2026-07-23T09:00:00.000Z');
  db.pragma('foreign_keys = ON');
  // NULL raw_input, and a row using SQLite's own default format
  db.prepare(
    `INSERT INTO transactions (customer_id, type, amount, channel, confirmed, raw_input)
     VALUES (3, 'sale', 60, 'cash', 1, NULL)`,
  ).run();

  // =========================================================================
  t.section('1. queries.ts — row mapping');
  const customers = loadCustomers();
  t.eq('all customer rows load', customers.length, 7);
  t.eq('ordered by id', customers.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7]);
  t.eq('a NULL name survives as null, not ""', customers.find((c) => c.id === 5)?.name, null);
  t.eq('disambiguator preserved', customers.find((c) => c.id === 6)?.disambiguator, 'blue uniform');

  const txns = loadTransactions();
  t.eq('all transaction rows load', txns.length, 12);
  t.eq('anonymous cash keeps a null customer_id', txns.some((x) => x.customer_id === null), true);
  t.eq('NULL raw_input survives as null', txns.some((x) => x.raw_input === null), true);
  t.eq(
    'confirmed is narrowed to 0 | 1',
    [...new Set(txns.map((x) => x.confirmed))].sort(),
    [0, 1],
  );
  t.eq(
    'every created_at comes back with an explicit offset',
    txns.every((x) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(x.created_at)),
    true,
  );
  t.eq(
    'and every one is therefore parseable',
    txns.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(toEatDateKey(x.created_at))),
    true,
  );

  t.section('2. queries.ts — naiveTimestampZone reaches the rows');
  t.eq(
    "default 'utc' files the 22:10 EAT sale on the 26th",
    toEatDateKey(loadTransactions().find((x) => x.amount === 400)!.created_at),
    '2026-07-26',
  );
  t.eq(
    "'eat' files it correctly on the 25th",
    toEatDateKey(loadTransactions({ naiveTimestampZone: 'eat' }).find((x) => x.amount === 400)!.created_at),
    '2026-07-25',
  );
  t.eq(
    'the explicit-UTC cash row is unaffected by the mode',
    toEatDateKey(loadTransactions({ naiveTimestampZone: 'eat' }).find((x) => x.amount === 120)!.created_at),
    toEatDateKey(loadTransactions({ naiveTimestampZone: 'utc' }).find((x) => x.amount === 120)!.created_at),
  );

  t.section('3. queries.ts — scoped reads');
  t.eq('per-customer read returns only that customer',
    [...new Set(loadTransactionsForCustomer(1).map((x) => x.customer_id))], [1]);
  t.eq('a customer with no rows returns empty, not an error', loadTransactionsForCustomer(5), []);
  t.eq('an id that does not exist returns empty', loadTransactionsForCustomer(12345), []);
  t.eq('loadLedger returns both tables', Object.keys(loadLedger()).sort(), ['customers', 'transactions']);
  t.eq('findCustomerByName exact match', findCustomerByName('PETER OTIENO')?.id, 3);
  t.eq('findCustomerByName is case-sensitive, as P1 stores it', findCustomerByName('peter otieno'), undefined);
  t.eq('findCustomerByName on a missing name', findCustomerByName('NOBODY'), undefined);

  t.section('4. service.ts — summary over real rows');
  const { summary, merges } = getRegularsSummary({ asOfDateKey: '2026-07-26' });
  t.eq('the duplicate-cased pair was merged', merges.length, 1);
  t.eq('id 2 folded into id 1', merges[0]?.mergedIds, [2]);
  t.eq('Mary appears once', summary.regulars.filter((r) => /MARY/i.test(r.displayName)).length, 1);
  t.eq(
    'with her visits combined across both rows (20, 22, 24)',
    summary.regulars.find((r) => /MARY/i.test(r.displayName))?.visitCount,
    3,
  );
  t.eq(
    'spend counts sale+deni, not the repayment or the restock',
    // 500 + 300 (id1 sales) + 250 (id2 sale) + 200 (deni) = 1250
    summary.regulars.find((r) => /MARY/i.test(r.displayName))?.totalSpend,
    1250,
  );
  t.eq('unconfirmed rows are disclosed', summary.includesUnconfirmed, true);
  t.eq('the orphan row contributed nothing', summary.regulars.some((r) => r.totalSpend === 777), false);
  t.eq('anonymous cash is excluded from named spend', summary.namedCustomerSpend, 1250 + 460);
  t.eq('Grace is lapsing', summary.lapsing.map((r) => r.displayName), ['GRACE MUTHONI']);
  t.eq('the NULL-named customer produced no profile', summary.regulars.some((r) => r.displayName === 'Customer #5'), false);
  t.eq(
    'the deliberately disambiguated pair was NOT merged',
    merges.flatMap((m) => m.mergedIds).some((id) => id === 6 || id === 7),
    false,
  );

  t.eq(
    'disabling the merge shows the raw rows instead',
    getRegularsSummary({ asOfDateKey: '2026-07-26', mergeDuplicateNames: false }).summary.regulars.filter((r) =>
      /MARY/i.test(r.displayName),
    ).length,
    2,
  );

  t.section('5. service.ts — message assembly');
  const msg = await getWeeklyRegularsMessage({ asOfDateKey: '2026-07-26' });
  t.eq('a message is produced', msg.text.length > 0, true);
  t.eq('with no API key it uses deterministic phrasing', msg.phrasing.source, 'deterministic-fallback');
  t.eq('a promo is attached because someone lapsed', msg.promo !== undefined, true);
  t.eq('the promo names no figures', /KES/.test(msg.promo?.text ?? ''), false);
  t.eq('the message survives figure verification',
    (await import('./promo-drafts')).assertFiguresPreserved(msg.text, msg.summary).ok, true);

  const emptyWeek = await getWeeklyRegularsMessage({ asOfDateKey: '2027-01-01' });
  t.eq('a week with no activity still returns text', emptyWeek.text.length > 0, true);
  t.eq('and says nobody came', emptyWeek.summary.regulars, []);
  // Lapsing is measured on lifetime history, not the window, so a dead week is
  // precisely when the win-back promo matters most — every former regular is by
  // definition lapsed. This is the intended behaviour, not an accident.
  t.eq(
    'but still surfaces every former regular for a promo',
    emptyWeek.promo?.recipients.map((r) => r.displayName).sort(),
    ['GRACE MUTHONI', 'MARY WANJIKU'],
  );
  // With no API key the runner is undefined, so prove the empty-week guard by
  // handing in a model that actively tries to invent a customer.
  const emptyWeekWithModel = await getWeeklyRegularsMessage(
    { asOfDateKey: '2027-01-01' },
    async () => 'Mambo! Wateja wako bora wiki hii ni Fatuma na Zawadi. Asante!',
  );
  t.eq('an empty week never uses model output', emptyWeekWithModel.phrasing.source, 'deterministic-fallback');
  t.eq(
    'and records why',
    emptyWeekWithModel.phrasing.rejectedReason?.includes('no figures to verify'),
    true,
  );
  t.eq('so an invented customer cannot reach the owner', /Fatuma/.test(emptyWeekWithModel.text), false);

  t.section('6. service.ts — live repeat lookup and back-compat');
  const marysThird = getRepeatVisit(1, '2026-07-24T10:00:00');
  t.eq('Mary is a returning face', marysThird.isRepeat, true);
  t.eq('a customer with no history is not', getRepeatVisit(5, '2026-07-26T09:00:00').isRepeat, false);
  t.eq('and reads as visit 1', getRepeatVisit(5, '2026-07-26T09:00:00').visitNumber, 1);
  t.eq('an unknown customer id does not throw', getRepeatVisit(4242, '2026-07-26T09:00:00').visitNumber, 1);

  const ids = detectRepeatVisits(7, { asOfDateKey: '2026-07-26' });
  t.eq('back-compat export returns customer ids', Array.isArray(ids), true);
  t.eq('every id is a number', ids.every((id) => typeof id === 'number'), true);
  t.eq('Mary (canonical id 1) is among them', ids.includes(1), true);
  t.eq('the merged-away id 2 is not', ids.includes(2), false);
  t.eq('a 1-day window finds fewer regulars', detectRepeatVisits(1, { asOfDateKey: '2026-07-26' }).length <= ids.length, true);

  t.section('7. service.ts — duplicates and clock');
  const dupes = getDuplicateCandidates();
  t.eq('the JOHN KAMAU pair is reported', dupes.some((d) => /JOHN/i.test(d.a.name ?? '')), true);
  t.eq('flagged as deliberately disambiguated', dupes.find((d) => /JOHN/i.test(d.a.name ?? ''))?.disambiguated, true);
  t.eq('todayInEat is a date key', /^\d{4}-\d{2}-\d{2}$/.test(todayInEat()), true);
  t.eq('todayInEat is injectable', todayInEat(new Date('2026-07-25T22:00:00Z')), '2026-07-26');

  t.section('8. P2 wrote nothing');
  const after = {
    customers: (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n,
    transactions: (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
    reconciliations: (db.prepare('SELECT COUNT(*) AS n FROM daily_reconciliations').get() as { n: number }).n,
    statements: (db.prepare('SELECT COUNT(*) AS n FROM statements').get() as { n: number }).n,
  };
  t.eq('customer count unchanged by all the reads above', after.customers, 7);
  t.eq('transaction count unchanged', after.transactions, 12);
  t.eq('P2 never touched daily_reconciliations', after.reconciliations, 0);
  t.eq('P2 never touched statements', after.statements, 0);

  t.finish();
}

main()
  .catch((err) => {
    console.error('\ndb-check failed to run:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Close before unlinking: Windows keeps the file locked while the connection
    // is open, so rmSync would fail and — thrown from inside `finally` — would
    // report a non-zero exit even when every check passed.
    try {
      handle?.close();
    } catch {
      /* already closed, or never opened */
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const f = `${DB_FILE}${suffix}`;
      try {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      } catch (err) {
        // Never let tidy-up mask the result of the run.
        console.warn(`[db-check] could not remove ${path.basename(f)}: ${(err as Error).message}`);
      }
    }
  });
