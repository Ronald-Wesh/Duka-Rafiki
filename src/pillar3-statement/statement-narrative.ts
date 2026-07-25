import { askClaude } from "../core/claude-client";
import type { StatementBreakdown } from "./statement-metrics";

// The model is handed computed figures and asked only to phrase them
// (README section 5). It never calculates anything that appears here.

const kes = (n: number) => `KES ${n.toLocaleString("en-KE", { maximumFractionDigits: 0 })}`;
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * Deterministic fallback. A statement must always generate — the paragraph is
 * decoration, the figures are the product. Used when Claude is slow, rate
 * limited, or the API key is missing on demo night.
 */
export function templateSummary(b: StatementBreakdown): string {
  const parts = [
    `Between ${b.row.period_start} and ${b.row.period_end}, this trader logged ${kes(b.row.total_sales)} in sales across ${b.daysWithActivity} of ${b.daysInPeriod} days.`,
    `Stock purchases over the same period leave an estimated margin of ${kes(b.row.estimated_margin)}.`,
    b.row.outstanding_receivables > 0
      ? `Customer credit outstanding stands at ${kes(b.row.outstanding_receivables)}, with ${pct(b.deniRepaymentRate)} of credit extended repaid so far.`
      : `No customer credit is outstanding at the end of the period.`,
    b.daysClosed === 0
      ? `No days were closed and counted, so a reconciliation figure is not available.`
      : `Of the ${b.daysClosed} days closed and counted, ${pct(b.row.reconciliation_accuracy)} matched the logged total within KES 50.`,
  ];
  if (b.unconfirmedSales > 0) {
    parts.push(`${kes(b.unconfirmedSales)} of these sales are self-reported and not yet confirmed.`);
  }
  return parts.join(" ");
}

export async function phraseSummary(b: StatementBreakdown): Promise<string> {
  const facts = {
    period_start: b.row.period_start,
    period_end: b.row.period_end,
    total_sales_kes: b.row.total_sales,
    estimated_margin_kes: b.row.estimated_margin,
    outstanding_receivables_kes: b.row.outstanding_receivables,
    unconfirmed_sales_kes: b.unconfirmedSales,
    deni_repayment_rate_percent: Math.round(b.deniRepaymentRate * 100),
    reconciliation_accuracy_percent: Math.round(b.row.reconciliation_accuracy * 100),
    days_with_activity: b.daysWithActivity,
    days_in_period: b.daysInPeriod,
    days_closed: b.daysClosed,
  };

  try {
    const text = await askClaude("statement-summary", JSON.stringify(facts), 400);
    const clean = text.trim();
    if (clean.length === 0) return templateSummary(b);
    return clean;
  } catch (err) {
    // One line, not a full API error dump — this fires on stage.
    console.error("[P3] narrative failed, using template:", (err as Error)?.message ?? err);
    return templateSummary(b);
  }
}
