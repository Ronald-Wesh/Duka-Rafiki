import assert from "assert";
import { computeStatementMetrics, RECONCILIATION_TOLERANCE_KES } from "./statement-metrics";
import type { LedgerAggregates } from "./statement-queries";

function aggregates(over: Partial<LedgerAggregates> = {}): LedgerAggregates {
  return {
    periodStart: "2026-07-01",
    periodEnd: "2026-07-30",
    daysInPeriod: 30,
    totals: { sale: 50_000, restock: 20_000, deni: 4_000, deni_repayment: 1_000 },
    unconfirmedSales: 12_000,
    dailySales: Array.from({ length: 26 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      total: 1_000,
    })),
    closedDays: [
      { date: "2026-07-01", variance: 0 },
      { date: "2026-07-02", variance: -30 },
      { date: "2026-07-03", variance: 200 },
      { date: "2026-07-04", variance: 45 },
    ],
    ...over,
  };
}

// Known input -> exact expected figures.
{
  const b = computeStatementMetrics(aggregates());
  assert.strictEqual(b.row.total_sales, 50_000);
  assert.strictEqual(b.row.estimated_margin, 30_000, "sales 50k less restock 20k");
  assert.strictEqual(b.row.outstanding_receivables, 3_000, "deni 4k less repaid 1k");
  assert.strictEqual(b.deniRepaymentRate, 0.25);
  assert.strictEqual(b.row.reconciliation_accuracy, 0.75, "3 of 4 closed days within 50");
  assert.strictEqual(b.daysWithActivity, 26);
  assert.strictEqual(b.daysClosed, 4);
  assert.strictEqual(b.unconfirmedSales, 12_000);
  assert.strictEqual(
    b.row.cashflow_consistency_note,
    "Sales logged on 26 of 30 days in this period."
  );
  assert.strictEqual(b.row.period_start, "2026-07-01");
  assert.strictEqual(b.row.period_end, "2026-07-30");
}

// A variance of exactly the tolerance counts as within it.
{
  const b = computeStatementMetrics(
    aggregates({
      closedDays: [
        { date: "2026-07-01", variance: RECONCILIATION_TOLERANCE_KES },
        { date: "2026-07-02", variance: -RECONCILIATION_TOLERANCE_KES },
      ],
    })
  );
  assert.strictEqual(b.row.reconciliation_accuracy, 1, "boundary is inclusive");
}

// Empty period: zeros everywhere, no throw, no NaN.
{
  const b = computeStatementMetrics(
    aggregates({
      totals: { sale: 0, restock: 0, deni: 0, deni_repayment: 0 },
      unconfirmedSales: 0,
      dailySales: [],
      closedDays: [],
    })
  );
  assert.strictEqual(b.row.total_sales, 0);
  assert.strictEqual(b.row.estimated_margin, 0);
  assert.strictEqual(b.row.outstanding_receivables, 0);
  assert.strictEqual(b.deniRepaymentRate, 0, "no deni means 0, never NaN");
  assert.strictEqual(b.row.reconciliation_accuracy, 0, "no closed days means 0, never NaN");
  assert.strictEqual(
    b.row.cashflow_consistency_note,
    "Sales logged on 0 of 30 days in this period."
  );
}

// Repayments can exceed outstanding deni; receivables floor at zero, never negative.
{
  const b = computeStatementMetrics(
    aggregates({ totals: { sale: 100, restock: 0, deni: 500, deni_repayment: 900 } })
  );
  assert.strictEqual(b.row.outstanding_receivables, 0);
}

// Restock can exceed sales in a heavy stock-up period. Margin goes negative,
// which is the honest figure — do not clamp it.
{
  const b = computeStatementMetrics(
    aggregates({ totals: { sale: 1_000, restock: 4_000, deni: 0, deni_repayment: 0 } })
  );
  assert.strictEqual(b.row.estimated_margin, -3_000);
}

console.log("statement-metrics: all assertions passed");
