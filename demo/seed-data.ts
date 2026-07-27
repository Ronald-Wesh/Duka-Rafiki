import db, { initDb } from "../src/core/db";

/**
 * 4 weeks of realistic kiosk history for Mama Njeri's duka.
 *
 * Deterministic on purpose: a fixed-seed PRNG, not Math.random(). The demo must
 * look identical every run, and pillars need stable numbers to write tests
 * against. Re-running this produces byte-identical data.
 *
 * Dates are anchored to today and walk backwards, so the statement always reads
 * as current no matter which day we demo on.
 */

const DAYS = 28;
const SEED = 20260726;

// ---------------------------------------------------------------- determinism

/** mulberry32 — tiny, fast, good enough, and reproducible across machines. */
function makePrng(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = makePrng(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (lo: number, hi: number): number =>
  lo + Math.floor(rnd() * (hi - lo + 1));

// -------------------------------------------------------------------- catalogue

// Real kiosk stock at roughly real Nairobi prices (Ksh), with the phrasing a
// trader would actually type — Swahili/Sheng, abbreviated, inconsistent.
const ITEMS: ReadonlyArray<{ name: string; price: number; phrasings: string[] }> = [
  { name: "unga", price: 180, phrasings: ["unga 2kg {p}", "unga wa ugali {p}", "unga {p} cash"] },
  { name: "sukari", price: 160, phrasings: ["sukari kilo {p}", "sukari {p}", "sugar 1kg {p}"] },
  { name: "sukari nusu", price: 80, phrasings: ["sukari nusu kilo {p}", "sukari 1/2 {p}"] },
  { name: "maziwa", price: 60, phrasings: ["maziwa {p}", "nimeuza maziwa {p}", "milk 500ml {p}"] },
  { name: "mkate", price: 65, phrasings: ["mkate {p}", "bread {p}", "mkate mzima {p}"] },
  { name: "mafuta", price: 320, phrasings: ["mafuta 1L {p}", "cooking oil {p}"] },
  { name: "mafuta ya taa", price: 50, phrasings: ["mafuta ya taa {p} bob", "paraffin {p}"] },
  { name: "sabuni", price: 30, phrasings: ["sabuni {p}", "sabuni ya kufua {p} bob"] },
  { name: "omo", price: 45, phrasings: ["omo {p}", "omo sachet {p} bob"] },
  { name: "chai", price: 50, phrasings: ["majani chai {p}", "chai packet {p}"] },
  { name: "mchele", price: 150, phrasings: ["mchele kilo {p}", "rice 1kg {p}"] },
  { name: "soda", price: 50, phrasings: ["soda {p}", "soda baridi {p} bob"] },
  { name: "mayai", price: 15, phrasings: ["mayai {p}", "egg moja {p} bob"] },
  { name: "nyanya", price: 20, phrasings: ["nyanya {p} bob", "tomato {p}"] },
  { name: "vitunguu", price: 20, phrasings: ["vitunguu {p} bob", "onion {p}"] },
  { name: "ndengu", price: 90, phrasings: ["ndengu {p}", "ndengu nusu kilo {p}"] },
  { name: "chumvi", price: 25, phrasings: ["chumvi {p}", "salt {p} bob"] },
  { name: "blueband", price: 65, phrasings: ["blueband {p}", "blueband ndogo {p}"] },
];

// 12 regulars — enough for P2's repeat detection to have real signal.
// NOTE the two Marys: same name, different people. That's the duplicate-name
// case the disambiguator field exists for (README section 3).
const CUSTOMERS: ReadonlyArray<{
  name: string;
  phone: string | null;
  disambiguator: string | null;
  /** Rough visits per week — drives repeat-visit detection. */
  frequency: number;
}> = [
  { name: "Mary", phone: "0722334455", disambiguator: "blue uniform", frequency: 5 },
  { name: "Mary", phone: null, disambiguator: "anauza mboga", frequency: 3 },
  { name: "John Kamau", phone: "0712345678", disambiguator: null, frequency: 4 },
  { name: "Peter Otieno", phone: "0733221100", disambiguator: null, frequency: 4 },
  { name: "Grace Wairimu", phone: "0701998877", disambiguator: null, frequency: 3 },
  { name: "Alice Muthoni", phone: null, disambiguator: "mwalimu", frequency: 3 },
  { name: "Samuel Kiprop", phone: "0745612378", disambiguator: null, frequency: 2 },
  { name: "Jane Achieng", phone: "0729384756", disambiguator: null, frequency: 3 },
  { name: "David Mwangi", phone: "0718273645", disambiguator: "boda boda", frequency: 5 },
  { name: "Esther Nduta", phone: null, disambiguator: null, frequency: 2 },
  { name: "Joseph Barasa", phone: "0755443322", disambiguator: null, frequency: 1 },
  { name: "Faith Chebet", phone: "0766778899", disambiguator: null, frequency: 2 },
];

// --------------------------------------------------------------------- helpers

/** "Mary (blue uniform)" — how the owner distinguishes two customers who share a name. */
const custLabel = (c: { name: string; disambiguator: string | null }) =>
  c.disambiguator ? `${c.name} (${c.disambiguator})` : c.name;

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d: Date, h: number, m: number) =>
  `${isoDate(d)} ${pad(h)}:${pad(m)}:00`;

const QTY_WORD: Record<number, string> = { 2: "mbili", 3: "tatu" };

/**
 * How the owner would type a sale. Catalogue phrasings already state a unit
 * ("unga 2kg", "mafuta 1L"), so they can only be used for a single item —
 * reusing them for a multiple produces contradictions like "mafuta 1L 960".
 * Multiples get their own quantity-aware phrasing instead.
 */
function salePhrasing(item: (typeof ITEMS)[number], qty: number, amount: number): string {
  if (qty === 1) return pick(item.phrasings).replace("{p}", String(amount));
  return `${item.name} ${QTY_WORD[qty] ?? qty} ${amount}`;
}

const TXN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const txnCode = () =>
  Array.from({ length: 10 }, () => TXN_CHARS[Math.floor(rnd() * TXN_CHARS.length)]).join("");

/** A forwarded M-Pesa Buy Goods / Pochi confirmation, in the real SMS format. */
function mpesaSms(amount: number, payer: string, phone: string, d: Date, h: number, m: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const date = `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`;
  const balance = between(2000, 45000);
  return (
    `${txnCode()} Confirmed. You have received Ksh${amount}.00 from ${payer.toUpperCase()} ` +
    `${phone} on ${date} at ${h12}:${pad(m)} ${ampm}. New M-PESA balance is Ksh${balance}.00`
  );
}

/** Kiosk footfall: quiet Sundays, busy market days, month-end salary bump. */
function volumeFor(d: Date): number {
  const dow = d.getDay(); // 0 = Sunday
  let base = between(14, 24);
  if (dow === 0) base = between(7, 12);
  if (dow === 3 || dow === 6) base += between(4, 9); // market days
  if (d.getDate() >= 28 || d.getDate() <= 3) base += between(3, 7); // payday
  return base;
}

// ------------------------------------------------------------------------ seed

initDb();

// Idempotent: wipe first so `npm run seed` twice is the same as once.
db.exec(`
  DELETE FROM transactions;
  DELETE FROM daily_reconciliations;
  DELETE FROM statements;
  DELETE FROM customers;
`);

const insertCustomer = db.prepare(
  `INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen)
   VALUES (?, ?, ?, ?, ?)`
);
const insertTxn = db.prepare(
  `INSERT INTO transactions (customer_id, type, amount, channel, confirmed, raw_input, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const insertRecon = db.prepare(
  `INSERT INTO daily_reconciliations (date, expected_total, reported_total, variance, notes)
   VALUES (?, ?, ?, ?, ?)`
);

const today = new Date();
const startDate = new Date(today);
startDate.setDate(startDate.getDate() - (DAYS - 1));

interface Seen {
  first: string;
  last: string;
}
const seen = new Map<number, Seen>();

// Running deni balance per customer. Repayments are drawn against this so they
// can never exceed what's actually owed — otherwise outstanding receivables go
// negative, which is meaningless on a statement a lender reads.
const owed = new Map<number, number>();

// Customer rows first so transactions can reference them. first_seen/last_seen
// are backfilled from actual activity once generated.
const customerIds: number[] = CUSTOMERS.map((c) =>
  Number(insertCustomer.run(c.name, c.phone, c.disambiguator, null, null).lastInsertRowid)
);

// Days the owner never closed out — leaves gaps so P3's reconciliation accuracy
// and cash-flow-consistency note aren't a suspicious flat 100%.
const missedCloses = new Set([3, 11, 12, 19, 25]);

const seedAll = db.transaction(() => {
  for (let dayIdx = 0; dayIdx < DAYS; dayIdx++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + dayIdx);
    const dateStr = isoDate(d);

    let moneyIn = 0; // sales + deni repayments — what reconciliation compares against

    const count = volumeFor(d);
    for (let i = 0; i < count; i++) {
      // Trading hours, weighted toward morning and early evening.
      const hour = rnd() < 0.45 ? between(6, 10) : rnd() < 0.6 ? between(11, 15) : between(16, 20);
      const minute = between(0, 59);
      const item = pick(ITEMS);

      // Some sales are multiples, so amounts aren't all catalogue prices.
      const qty = rnd() < 0.22 ? between(2, 3) : 1;
      const amount = item.price * qty;

      // M-Pesa is heavily used but cash still dominates small purchases.
      const viaMpesa = rnd() < 0.42;

      if (viaMpesa) {
        // Named payer from the SMS — this is what P2 builds profiles from.
        const idx = Math.floor(rnd() * CUSTOMERS.length);
        const cust = CUSTOMERS[idx];
        const custId = customerIds[idx];
        const phone = cust.phone ?? `07${between(10000000, 99999999)}`;

        insertTxn.run(
          custId,
          "sale",
          amount,
          "mpesa_buygoods",
          1,
          mpesaSms(amount, cust.name, phone, d, hour, minute),
          stamp(d, hour, minute)
        );

        const prev = seen.get(custId);
        seen.set(custId, { first: prev?.first ?? dateStr, last: dateStr });
      } else {
        // Anonymous cash sale, logged in the owner's own words.
        const raw = salePhrasing(item, qty, amount);
        // A few entries never get confirmed — exercises the unconfirmed rule
        // (README section 3: excluded or marked self-reported, never silently trusted).
        const confirmed = rnd() < 0.06 ? 0 : 1;
        insertTxn.run(null, "sale", amount, "cash", confirmed, raw, stamp(d, hour, minute));
      }

      moneyIn += amount;
    }

    // ----- deni (credit to a named regular), a few times a week
    if (rnd() < 0.55) {
      const idx = Math.floor(rnd() * 6); // the closest regulars get credit
      const cust = CUSTOMERS[idx];
      const custId = customerIds[idx];
      // Credit is extended on staples, not a single Ksh 15 egg — nobody runs a
      // tab for loose change, and tiny receivables look like noise on a statement.
      const item = pick(ITEMS.filter((i) => i.price >= 50));
      const amount = item.price * (rnd() < 0.3 ? 2 : 1);
      insertTxn.run(
        custId,
        "deni",
        amount,
        "cash",
        1,
        `${custLabel(cust)} amechukua ${item.name} ${amount} deni`,
        stamp(d, between(7, 19), between(0, 59))
      );
      owed.set(custId, (owed.get(custId) ?? 0) + amount);
      const prev = seen.get(custId);
      seen.set(custId, { first: prev?.first ?? dateStr, last: dateStr });
      // Deni moves goods, not money — deliberately not added to moneyIn.
    }

    // ----- deni repayments, drawn only against real outstanding balances and
    // less often than credit is given, so the trader stays owed money overall
    const debtors = [...owed.entries()].filter(([, bal]) => bal > 0);
    if (debtors.length > 0 && rnd() < 0.35) {
      const [custId, balance] = debtors[Math.floor(rnd() * debtors.length)];
      const cust = CUSTOMERS[customerIds.indexOf(custId)];
      // Usually a partial payment; sometimes they clear it entirely.
      const amount = rnd() < 0.35 ? balance : Math.max(20, Math.round(balance * (0.3 + rnd() * 0.4)));
      const viaMpesa = rnd() < 0.4;
      insertTxn.run(
        custId,
        "deni_repayment",
        amount,
        viaMpesa ? "mpesa_buygoods" : "cash",
        1,
        `${custLabel(cust)} amelipa deni ${amount}`,
        stamp(d, between(8, 19), between(0, 59))
      );
      owed.set(custId, balance - amount);
      const prev = seen.get(custId);
      seen.set(custId, { first: prev?.first ?? dateStr, last: dateStr });
      moneyIn += amount;
    }

    // ----- restock: the weekly wholesale run, plus occasional small top-ups.
    // Sized so cost of goods lands near 85% of sales — a duka runs on a
    // 10-20% margin, and an implausibly fat margin would undermine the
    // statement in front of anyone who knows retail.
    const isWholesaleDay = d.getDay() === 1;
    if (isWholesaleDay || rnd() < 0.1) {
      const amount = isWholesaleDay ? between(11500, 15500) : between(1200, 3500);
      insertTxn.run(
        null,
        "restock",
        amount,
        rnd() < 0.5 ? "mpesa_buygoods" : "cash",
        1,
        isWholesaleDay
          ? `nimenunua stock ${amount} kutoka wholesale`
          : `top up stock ${amount}`,
        stamp(d, between(6, 9), between(0, 59))
      );
      // Money out — not part of reconciliation's money-in comparison.
    }

    // ----- day close
    // expected_total is computed from the rows above (deterministic code, never
    // a model). reported_total simulates the owner counting cash by hand: usually
    // close, occasionally well off.
    if (!missedCloses.has(dayIdx)) {
      const roll = rnd();
      let variance: number;
      if (roll < 0.55) variance = 0; // counted exactly right
      else if (roll < 0.85) variance = between(-60, 60); // normal small drift
      else variance = between(-400, 400); // a bad day — miscount or unlogged sale

      const reported = Math.max(0, moneyIn + variance);
      const note =
        variance === 0
          ? "imelingana"
          : Math.abs(variance) <= 60
            ? "tofauti ndogo"
            : "tofauti kubwa — angalia mauzo ambayo hayakuandikwa";
      insertRecon.run(dateStr, moneyIn, reported, reported - moneyIn, note);
    }
  }

  // Backfill first/last seen from real activity.
  const updateSeen = db.prepare(
    `UPDATE customers SET first_seen = ?, last_seen = ? WHERE id = ?`
  );
  for (const [id, s] of seen) updateSeen.run(s.first, s.last, id);
});

seedAll();

// ------------------------------------------------------------------- summary

const q = <T>(sql: string): T => db.prepare(sql).get() as T;

const txns = q<{ c: number }>("SELECT COUNT(*) c FROM transactions").c;
const sales = q<{ c: number; t: number }>(
  "SELECT COUNT(*) c, COALESCE(SUM(amount),0) t FROM transactions WHERE type='sale'"
);
const mpesa = q<{ c: number }>(
  "SELECT COUNT(*) c FROM transactions WHERE channel='mpesa_buygoods'"
).c;
const unconfirmed = q<{ c: number }>(
  "SELECT COUNT(*) c FROM transactions WHERE confirmed=0"
).c;
const deni = q<{ t: number }>(
  "SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='deni'"
).t;
const repaid = q<{ t: number }>(
  "SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='deni_repayment'"
).t;
const restock = q<{ t: number }>(
  "SELECT COALESCE(SUM(amount),0) t FROM transactions WHERE type='restock'"
).t;
const recons = q<{ c: number; exact: number }>(
  "SELECT COUNT(*) c, SUM(CASE WHEN variance=0 THEN 1 ELSE 0 END) exact FROM daily_reconciliations"
);
const range = q<{ a: string; b: string }>(
  "SELECT MIN(date) a, MAX(date) b FROM daily_reconciliations"
);

const ksh = (n: number) => `Ksh ${n.toLocaleString("en-KE")}`;

console.log(`
Seed complete — ${DAYS} days, deterministic (seed ${SEED})

  Period              ${range.a} .. ${range.b}
  Customers           ${CUSTOMERS.length} (incl. 2 x "Mary" -> disambiguator case)
  Transactions        ${txns}
    sales             ${sales.c}  (${ksh(sales.t)})
    via M-Pesa        ${mpesa}
    unconfirmed       ${unconfirmed}  (self-reported, must not count as verified)
  Deni outstanding    ${ksh(deni - repaid)}  (${ksh(deni)} given, ${ksh(repaid)} repaid)
  Restock             ${ksh(restock)}  -> implied margin ${(((sales.t - restock) / sales.t) * 100).toFixed(1)}% (a duka runs 10-20%)
  Days closed         ${recons.c}/${DAYS}  (${DAYS - recons.c} missed, ${recons.exact} exact)
`);
