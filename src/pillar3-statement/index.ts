import { Router, Request, Response } from "express";
import db from "../core/db";
import type { Statement } from "../core/types";
import { defaultPeriod, fetchAggregates } from "./statement-queries";
import { computeStatementMetrics } from "./statement-metrics";
import { phraseSummary } from "./statement-narrative";
import { renderStatementPage, StatementSnapshot } from "./statement-html";
import { config } from "../core/config";

/**
 * Compute, phrase, persist. The full snapshot goes into summary_json so the
 * page renders from one row read — no recomputation, no Claude call on load,
 * and a statement shown to a lender in week 3 still renders identically in
 * week 6 after the ledger has grown.
 */
export async function generateStatement(
  periodStart?: string,
  periodEnd?: string
): Promise<{ id: number; url: string; summary: string }> {
  const period =
    periodStart && periodEnd ? { periodStart, periodEnd } : defaultPeriod();

  if (period.periodStart > period.periodEnd) {
    throw new Error(`period_start ${period.periodStart} is after period_end ${period.periodEnd}`);
  }

  const agg = fetchAggregates(period.periodStart, period.periodEnd);
  const breakdown = computeStatementMetrics(agg);
  const narrative = await phraseSummary(breakdown);

  const snapshot: StatementSnapshot = {
    metrics: breakdown.row,
    dailySales: breakdown.dailySales,
    daysWithActivity: breakdown.daysWithActivity,
    daysInPeriod: breakdown.daysInPeriod,
    daysClosed: breakdown.daysClosed,
    deniRepaymentRate: breakdown.deniRepaymentRate,
    unconfirmedSales: breakdown.unconfirmedSales,
    narrative,
  };

  const row = { ...breakdown.row, summary_json: JSON.stringify(snapshot) };

  const result = db
    .prepare(
      `INSERT INTO statements
         (period_start, period_end, total_sales, estimated_margin,
          cashflow_consistency_note, outstanding_receivables,
          reconciliation_accuracy, summary_json)
       VALUES (@period_start, @period_end, @total_sales, @estimated_margin,
               @cashflow_consistency_note, @outstanding_receivables,
               @reconciliation_accuracy, @summary_json)`
    )
    .run(row);

  const id = Number(result.lastInsertRowid);
  return { id, url: `${config.publicBaseUrl}/statement/${id}`, summary: narrative };
}

export const statementRouter = Router();

statementRouter.get("/statement/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).type("text/plain").send("Statement not found.");
    return;
  }

  const statement = db
    .prepare("SELECT * FROM statements WHERE id = ?")
    .get(id) as Statement | undefined;

  if (!statement) {
    res.status(404).type("text/plain").send("Statement not found.");
    return;
  }

  try {
    res.type("html").send(renderStatementPage(statement));
  } catch (err) {
    // A malformed summary_json must not take the page down mid-demo.
    console.error("[P3] render failed for statement", id, err);
    res.status(500).type("text/plain").send("Could not render this statement.");
  }
});
