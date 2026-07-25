import db, { initDb } from "../src/core/db";

// P3 fixture seed. 28 days of realistic kiosk activity so the statement has
// something to describe before P1's parsing lands.
//
// Deterministic on purpose: a seeded PRNG, never Math.random(), so every run
// produces identical figures and the demo is reproducible.

const DAYS = 28;
const TOLERANCE_KES = 50;

// mulberry32 — small, seeded, good enough for fixtures.
function makeRng(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260726);

const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)];

const CUSTOMERS = [
  "Mary Wanjiku", "John Kamau", "Grace Achieng", "Peter Otieno", "Faith Njeri",
  "Samuel Mwangi", "Esther Adhiambo", "Daniel Kiptoo", "Lucy Waithera", "Brian Omondi",
];

const ITEMS = ["unga", "maziwa", "mkate", "sukari", "sabuni", "mafuta", "chai", "mchele"];

/** Nairobi local date, `offset` days before today, as YYYY-MM-DD. */
function nairobiDate(offset: number): string {
  const ms = Date.now() + 3 * 3600_000 - offset * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A Nairobi wall-clock time on `date` expressed as the UTC string SQLite stores. */
function utcFor(date: string, hour: number, minute: number): string {
  const utcMs = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`)
    - 3 * 3600_000;
  return new Date(utcMs).toISOString().slice(0, 19).replace("T", " ");
}

initDb();

// Demo database — wipe and rebuild so runs are reproducible.
db.exec(`
  DELETE FROM statements;
  DELETE FROM daily_reconciliations;
  DELETE FROM transactions;
  DELETE FROM customers;
`);

const insertCustomer = db.prepare(
  `INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen)
   VALUES (?, NULL, NULL, ?, ?)`
);
const insertTxn = db.prepare(
  `INSERT INTO transactions (customer_id, type, amount, channel, confirmed, raw_input, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const insertRecon = db.prepare(
  `INSERT INTO daily_reconciliations (date, expected_total, reported_total, variance, notes)
   VALUES (?, ?, ?, ?, ?)`
);

const oldest = nairobiDate(DAYS - 1);
const customerIds = CUSTOMERS.map(
  (name) => Number(insertCustomer.run(name, `${oldest} 08:00:00`, `${nairobiDate(0)} 18:00:00`).lastInsertRowid)
);

// Days the owner logged nothing. A real trader misses days, and this is what
// makes the "logged N of M days" note mean something.
const SKIPPED = new Set([nairobiDate(19), nairobiDate(12), nairobiDate(5)]);

let seededDays = 0;

db.transaction(() => {
  for (let offset = DAYS - 1; offset >= 0; offset--) {
    const date = nairobiDate(offset);
    if (SKIPPED.has(date)) continue;
    seededDays++;

    const isWeekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    const saleCount = isWeekend ? randInt(9, 12) : randInt(6, 9);
    let expected = 0;

    for (let i = 0; i < saleCount; i++) {
      const amount = randInt(2, 24) * 25; // KES 50-600, realistic kiosk basket
      const onMpesa = rng() < 0.45;
      const customerId = onMpesa ? pick(customerIds) : null;
      const at = utcFor(date, randInt(7, 19), randInt(0, 59));

      insertTxn.run(
        customerId,
        "sale",
        amount,
        onMpesa ? "mpesa_buygoods" : "cash",
        onMpesa ? 1 : 0, // M-Pesa SMS is its own receipt; cash stays self-reported
        `seed: ${pick(ITEMS)} ${amount}/-`,
        at
      );
      expected += amount;
    }

    // Deni roughly twice a week, always to a named customer.
    if (rng() < 0.3) {
      const amount = randInt(2, 12) * 50;
      insertTxn.run(
        pick(customerIds), "deni", amount, "cash", 0,
        `seed: deni ${amount}/-`, utcFor(date, randInt(9, 18), randInt(0, 59))
      );
    }

    // Repayments, slightly rarer than deni, so receivables stay outstanding.
    if (rng() < 0.22) {
      const amount = randInt(2, 10) * 50;
      insertTxn.run(
        pick(customerIds), "deni_repayment", amount, "cash", 1,
        `seed: amelipa deni ${amount}/-`, utcFor(date, randInt(9, 18), randInt(0, 59))
      );
      expected += amount;
    }

    // Weekly stock-up on Mondays.
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) {
      const amount = randInt(20, 40) * 100;
      insertTxn.run(
        null, "restock", amount, "cash", 1,
        `seed: nimenunua stock ${amount}/-`, utcFor(date, 6, 30)
      );
    }

    // Owner closes most days. Miss a few, and let 3 land outside tolerance so
    // reconciliation accuracy is not a suspicious 100%.
    if (rng() < 0.88) {
      const drift = rng() < 0.12 ? randInt(60, 400) * (rng() < 0.5 ? -1 : 1) : randInt(-40, 40);
      const reported = expected + drift;
      insertRecon.run(date, expected, reported, reported - expected, "seed");
    }
  }
})();

const txns = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
const recons = db.prepare("SELECT COUNT(*) AS n FROM daily_reconciliations").get() as { n: number };
const within = db
  .prepare("SELECT COUNT(*) AS n FROM daily_reconciliations WHERE ABS(variance) <= ?")
  .get(TOLERANCE_KES) as { n: number };

console.log(`Seeded ${txns.n} transactions across ${seededDays} of ${DAYS} days.`);
console.log(`Closed ${recons.n} days, ${within.n} within KES ${TOLERANCE_KES}.`);
console.log(`Period: ${oldest} to ${nairobiDate(0)}`);
