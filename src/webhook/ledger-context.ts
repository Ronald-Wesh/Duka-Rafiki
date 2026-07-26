import db from "../core/db";

/**
 * A compact snapshot of the whole ledger, handed to the assistant so it can
 * answer business questions from real figures instead of guessing.
 *
 * Every number here is computed in SQL. The model receives them and reasons
 * about them; it is never the thing that calculates them. Nairobi is UTC+3
 * with no DST, so every day bucket uses date(created_at, '+3 hours') —
 * created_at is stored in UTC and evening sales would otherwise fall on the
 * wrong day.
 */
export function buildLedgerContext(): string {
  const NAIROBI = "date(created_at, '+3 hours')";
  const one = <T>(sql: string, ...params: unknown[]): T =>
    db.prepare(sql).get(...(params as [])) as T;
  const many = <T>(sql: string, ...params: unknown[]): T[] =>
    db.prepare(sql).all(...(params as [])) as T[];

  const today = one<{ d: string }>("SELECT date('now', '+3 hours') AS d").d;

  const todayTotals = many<{ type: string; total: number; n: number }>(
    `SELECT type, SUM(amount) AS total, COUNT(*) AS n
       FROM transactions WHERE ${NAIROBI} = ?
      GROUP BY type`,
    today
  );

  const periodTotals = many<{ type: string; total: number; n: number }>(
    `SELECT type, SUM(amount) AS total, COUNT(*) AS n
       FROM transactions WHERE ${NAIROBI} >= date('now', '+3 hours', '-27 days')
      GROUP BY type`
  );

  const unconfirmedToday = one<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE type = 'sale' AND confirmed = 0 AND ${NAIROBI} = ?`,
    today
  ).total;

  // Net debt per customer: taken on credit, less what they have repaid.
  const debtors = many<{ name: string; owed: number }>(
    `SELECT c.name AS name,
            SUM(CASE WHEN t.type = 'deni' THEN t.amount
                     WHEN t.type = 'deni_repayment' THEN -t.amount
                     ELSE 0 END) AS owed
       FROM transactions t JOIN customers c ON c.id = t.customer_id
      WHERE t.type IN ('deni', 'deni_repayment')
      GROUP BY c.id HAVING owed > 0
      ORDER BY owed DESC LIMIT 12`
  );

  const topCustomers = many<{ name: string; visits: number; spent: number }>(
    `SELECT c.name AS name, COUNT(*) AS visits, SUM(t.amount) AS spent
       FROM transactions t JOIN customers c ON c.id = t.customer_id
      WHERE t.type = 'sale'
        AND ${NAIROBI.replace("created_at", "t.created_at")} >= date('now', '+3 hours', '-27 days')
      GROUP BY c.id ORDER BY spent DESC LIMIT 8`
  );

  const recent = many<{ when: string; type: string; amount: number; who: string | null }>(
    `SELECT ${NAIROBI.replace("created_at", "t.created_at")} AS when_, t.type AS type,
            t.amount AS amount, c.name AS who
       FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id
      ORDER BY t.id DESC LIMIT 12`
  );

  const lastClose = one<{ date: string; expected: number; reported: number; variance: number } | undefined>(
    `SELECT date, expected_total AS expected, reported_total AS reported, variance
       FROM daily_reconciliations WHERE reported_total IS NOT NULL
      ORDER BY date DESC LIMIT 1`
  );

  const sum = (rows: { type: string; total: number }[], t: string) =>
    Math.round(rows.find((r) => r.type === t)?.total ?? 0);
  const count = (rows: { type: string; n: number }[], t: string) =>
    rows.find((r) => r.type === t)?.n ?? 0;

  return JSON.stringify(
    {
      currency: "KES",
      today,
      today_so_far: {
        sales: sum(todayTotals, "sale"),
        sales_count: count(todayTotals, "sale"),
        credit_given: sum(todayTotals, "deni"),
        repayments: sum(todayTotals, "deni_repayment"),
        restock: sum(todayTotals, "restock"),
        unconfirmed_sales: Math.round(unconfirmedToday),
      },
      last_28_days: {
        sales: sum(periodTotals, "sale"),
        sales_count: count(periodTotals, "sale"),
        restock: sum(periodTotals, "restock"),
        credit_given: sum(periodTotals, "deni"),
        repayments: sum(periodTotals, "deni_repayment"),
        sales_less_restock: sum(periodTotals, "sale") - sum(periodTotals, "restock"),
      },
      outstanding_debts: debtors.map((d) => ({ name: d.name, owed: Math.round(d.owed) })),
      total_outstanding: Math.round(debtors.reduce((a, d) => a + d.owed, 0)),
      top_customers_28d: topCustomers.map((c) => ({
        name: c.name,
        visits: c.visits,
        spent: Math.round(c.spent),
      })),
      recent_entries: recent.map((r) => ({
        date: r.when,
        type: r.type,
        amount: Math.round(r.amount),
        customer: r.who,
      })),
      last_day_close: lastClose ?? null,
    },
    null,
    0
  );
}
