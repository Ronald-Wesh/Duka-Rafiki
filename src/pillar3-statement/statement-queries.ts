import db from "../core/db";

// All P3 SQL lives here. Raw aggregates only — no derived figures, no rates,
// no notes. Arithmetic belongs in statement-metrics.ts so it stays testable
// without a database.
//
// transactions.created_at is UTC; daily_reconciliations.date is a Nairobi
// calendar date. Every bucketing query must convert. Kenya has no DST.
const NAIROBI_DATE = "date(created_at, '+3 hours')";

export interface DailyTotal {
  date: string;
  total: number;
}

export interface ClosedDay {
  date: string;
  variance: number;
}

export interface LedgerAggregates {
  periodStart: string;
  periodEnd: string;
  daysInPeriod: number;
  totals: {
    sale: number;
    restock: number;
    deni: number;
    deni_repayment: number;
  };
  /** Sales the owner has not confirmed. Reported, never silently counted as verified. */
  unconfirmedSales: number;
  /** Sparse — only days with at least one sale. */
  dailySales: DailyTotal[];
  /** Only days the owner actually closed. */
  closedDays: ClosedDay[];
}

/** The last `days` Nairobi calendar days, ending today. */
export function defaultPeriod(days = 28): { periodStart: string; periodEnd: string } {
  const nairobiNow = Date.now() + 3 * 3600_000;
  const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    periodStart: toDate(nairobiNow - (days - 1) * 86_400_000),
    periodEnd: toDate(nairobiNow),
  };
}

export function fetchAggregates(periodStart: string, periodEnd: string): LedgerAggregates {
  if (periodStart > periodEnd) {
    throw new Error(`periodStart ${periodStart} is after periodEnd ${periodEnd}`);
  }

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'sale' THEN amount END), 0) AS sale,
         COALESCE(SUM(CASE WHEN type = 'restock' THEN amount END), 0) AS restock,
         COALESCE(SUM(CASE WHEN type = 'deni' THEN amount END), 0) AS deni,
         COALESCE(SUM(CASE WHEN type = 'deni_repayment' THEN amount END), 0) AS deni_repayment,
         COALESCE(SUM(CASE WHEN type = 'sale' AND confirmed = 0 THEN amount END), 0) AS unconfirmed_sales
       FROM transactions
       WHERE ${NAIROBI_DATE} BETWEEN ? AND ?`
    )
    .get(periodStart, periodEnd) as {
    sale: number;
    restock: number;
    deni: number;
    deni_repayment: number;
    unconfirmed_sales: number;
  };

  const dailySales = db
    .prepare(
      `SELECT ${NAIROBI_DATE} AS date, COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE type = 'sale' AND ${NAIROBI_DATE} BETWEEN ? AND ?
       GROUP BY 1
       ORDER BY 1`
    )
    .all(periodStart, periodEnd) as DailyTotal[];

  const closedDays = db
    .prepare(
      `SELECT date, variance
       FROM daily_reconciliations
       WHERE date BETWEEN ? AND ? AND reported_total IS NOT NULL
       ORDER BY date`
    )
    .all(periodStart, periodEnd) as ClosedDay[];

  const daysInPeriod =
    Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;

  return {
    periodStart,
    periodEnd,
    daysInPeriod,
    totals: {
      sale: totals.sale,
      restock: totals.restock,
      deni: totals.deni,
      deni_repayment: totals.deni_repayment,
    },
    unconfirmedSales: totals.unconfirmed_sales,
    dailySales,
    closedDays,
  };
}
