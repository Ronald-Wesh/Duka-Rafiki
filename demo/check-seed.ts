import assert from "node:assert";
import db from "../src/core/db";

// Integrity checks on the seeded ledger. These assert the properties each
// pillar quietly depends on — the kind of thing that produces a wrong number on
// a lender-facing statement rather than an error, so nothing else would catch it.

const one = <T>(sql: string): T => db.prepare(sql).get() as T;
const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}\n        ${err instanceof Error ? err.message : err}`);
  }
}

check("ledger is populated", () => {
  const { c } = one<{ c: number }>("SELECT COUNT(*) c FROM transactions");
  assert.ok(c > 400, `expected 400+ transactions, got ${c}`);
});

check("no customer has a negative deni balance", () => {
  const rows = all<{ id: number; name: string; balance: number }>(`
    SELECT c.id, c.name,
           COALESCE(SUM(CASE t.type WHEN 'deni' THEN t.amount
                                   WHEN 'deni_repayment' THEN -t.amount
                                   ELSE 0 END), 0) AS balance
    FROM customers c LEFT JOIN transactions t ON t.customer_id = c.id
    GROUP BY c.id HAVING balance < 0
  `);
  assert.strictEqual(
    rows.length,
    0,
    `overpaid deni for: ${rows.map((r) => `${r.name}(${r.balance})`).join(", ")}`
  );
});

check("outstanding receivables are positive (trader is owed money)", () => {
  const { bal } = one<{ bal: number }>(`
    SELECT COALESCE(SUM(CASE type WHEN 'deni' THEN amount
                                 WHEN 'deni_repayment' THEN -amount
                                 ELSE 0 END), 0) bal FROM transactions
  `);
  assert.ok(bal > 0, `expected positive outstanding deni, got ${bal}`);
});

check("implied margin is plausible for a kiosk (8-22%)", () => {
  const { sales, cost } = one<{ sales: number; cost: number }>(`
    SELECT COALESCE(SUM(CASE WHEN type='sale' THEN amount END),0) sales,
           COALESCE(SUM(CASE WHEN type='restock' THEN amount END),0) cost
    FROM transactions
  `);
  const margin = ((sales - cost) / sales) * 100;
  assert.ok(margin > 8 && margin < 22, `implied margin ${margin.toFixed(1)}% is not kiosk-realistic`);
});

check("reconciliation has gaps (accuracy must not be a flat 100%)", () => {
  const { days } = one<{ days: number }>("SELECT COUNT(*) days FROM daily_reconciliations");
  const { total } = one<{ total: number }>(
    "SELECT COUNT(DISTINCT date(created_at)) total FROM transactions"
  );
  assert.ok(days < total, `every one of ${total} days was closed — no gaps to reconcile`);
  const { off } = one<{ off: number }>(
    "SELECT COUNT(*) off FROM daily_reconciliations WHERE variance != 0"
  );
  assert.ok(off > 0, "no day has a variance — reconciliation would look suspiciously perfect");
});

check("variance always equals reported minus expected", () => {
  const { bad } = one<{ bad: number }>(`
    SELECT COUNT(*) bad FROM daily_reconciliations
    WHERE ABS(variance - (reported_total - expected_total)) > 0.001
  `);
  assert.strictEqual(bad, 0, `${bad} row(s) have an inconsistent variance`);
});

check("duplicate-name case exists with disambiguators", () => {
  const rows = all<{ name: string; n: number }>(
    "SELECT name, COUNT(*) n FROM customers GROUP BY name HAVING n > 1"
  );
  assert.ok(rows.length > 0, "no duplicate customer names — disambiguator path untested");
  const { missing } = one<{ missing: number }>(`
    SELECT COUNT(*) missing FROM customers
    WHERE disambiguator IS NULL AND name IN (
      SELECT name FROM customers GROUP BY name HAVING COUNT(*) > 1
    )
  `);
  assert.strictEqual(missing, 0, "a duplicated name has no disambiguator");
});

check("repeat customers exist for retention detection", () => {
  const rows = all<{ id: number; visits: number }>(`
    SELECT customer_id id, COUNT(DISTINCT date(created_at)) visits
    FROM transactions WHERE customer_id IS NOT NULL
    GROUP BY customer_id HAVING visits >= 3
  `);
  assert.ok(rows.length >= 8, `only ${rows.length} customers have 3+ visit days`);
});

check("M-Pesa sales carry a payer name and parseable raw SMS", () => {
  const { c } = one<{ c: number }>(`
    SELECT COUNT(*) c FROM transactions
    WHERE channel='mpesa_buygoods' AND type='sale'
      AND (customer_id IS NULL OR raw_input NOT LIKE '%Confirmed%')
  `);
  assert.strictEqual(c, 0, `${c} M-Pesa sale(s) missing a payer or a real SMS body`);
});

check("unconfirmed entries exist but stay a small minority", () => {
  const { u, t } = one<{ u: number; t: number }>(
    "SELECT SUM(confirmed=0) u, COUNT(*) t FROM transactions"
  );
  assert.ok(u > 0, "no unconfirmed entries — the self-reported rule is untested");
  assert.ok(u / t < 0.15, `${((u / t) * 100).toFixed(0)}% unconfirmed is too many`);
});

check("anonymous cash sales have no customer attached", () => {
  const { c } = one<{ c: number }>(
    "SELECT COUNT(*) c FROM transactions WHERE channel='cash' AND type='sale' AND customer_id IS NOT NULL"
  );
  assert.strictEqual(c, 0, `${c} cash sale(s) wrongly attributed to a customer`);
});

check("no schema-forbidden values slipped in", () => {
  const { c } = one<{ c: number }>(`
    SELECT COUNT(*) c FROM transactions
    WHERE type NOT IN ('sale','deni','deni_repayment','restock')
       OR channel NOT IN ('mpesa_buygoods','cash')
       OR amount <= 0
  `);
  assert.strictEqual(c, 0, `${c} row(s) violate the schema's allowed values`);
});

console.log(
  `\n${failures === 0 ? "All seed integrity checks passed." : `${failures} check(s) failed.`}`
);
process.exit(failures === 0 ? 0 : 1);
