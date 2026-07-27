import type { Statement } from "../core/types";
import type { DailyTotal, LedgerAggregates } from "./statement-queries";

// P3 owns this. Pure function of ledger data — no hidden state, no I/O, no
// runtime imports, so every figure is testable with a literal object.
// Descriptive record only — no scoring or classification of the owner (README sections 5, 9, 13).

/** A day is reconciled when the owner's count is within this many KES. */
export const RECONCILIATION_TOLERANCE_KES = 50;

export interface StatementBreakdown {
  /** Exactly the statements table columns, ready to insert. */
  row: Omit<Statement, "id" | "generated_at">;
  dailySales: DailyTotal[];
  daysWithActivity: number;
  daysInPeriod: number;
  daysClosed: number;
  /** 0-1. Lives in summary_json; the table has no column for it. */
  deniRepaymentRate: number;
  unconfirmedSales: number;
}

export function computeStatementMetrics(agg: LedgerAggregates): StatementBreakdown {
  const { sale, restock, deni, deni_repayment } = agg.totals;

  const daysWithActivity = agg.dailySales.length;
  const daysClosed = agg.closedDays.length;
  const withinTolerance = agg.closedDays.filter(
    (d) => Math.abs(d.variance) <= RECONCILIATION_TOLERANCE_KES
  ).length;

  return {
    row: {
      period_start: agg.periodStart,
      period_end: agg.periodEnd,
      total_sales: round2(sale),
      // Sales less stock purchases over the same period. Negative in a heavy
      // restock week, and that is the honest figure — not clamped.
      estimated_margin: round2(sale - restock),
      cashflow_consistency_note:
        `Sales logged on ${daysWithActivity} of ${agg.daysInPeriod} days in this period.`,
      outstanding_receivables: round2(Math.max(0, deni - deni_repayment)),
      // Denominator is days the owner actually closed. A day never closed is
      // not a failed reconciliation — it shows up in the consistency note above.
      reconciliation_accuracy: daysClosed === 0 ? 0 : round2(withinTolerance / daysClosed),
      summary_json: "", // filled by index.ts once the narrative exists
    },
    dailySales: agg.dailySales,
    daysWithActivity,
    daysInPeriod: agg.daysInPeriod,
    daysClosed,
    deniRepaymentRate: deni === 0 ? 0 : round2(deni_repayment / deni),
    unconfirmedSales: round2(agg.unconfirmedSales),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
