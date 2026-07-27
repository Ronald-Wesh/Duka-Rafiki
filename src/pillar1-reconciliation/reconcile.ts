import db from "../core/db";
import { ReconciliationResult } from "../core/types";

/**
 * P1 owns this. P1 is the ONLY writer of daily_reconciliations (README §9).
 *
 * reconcileDay(date, reportedTotal)
 * ---------------------------------
 * - `date`: ISO date string "YYYY-MM-DD" for the day being closed.
 * - `reportedTotal`: the amount the owner says they took in today (reported
 *   verbally at day close, e.g. "leo nimefanya 4500").
 *
 * Logic (pure deterministic arithmetic — no model involvement per README §5):
 * 1. Sum all CONFIRMED transactions for the given date (type = sale only;
 *    deni is not cash-in-hand, restocks are cash-out; deni_repayment IS
 *    cash-in so it counts).
 * 2. Compute variance = reportedTotal − expectedTotal.
 * 3. Upsert a row in daily_reconciliations (one row per date; if called twice
 *    on the same date the row is updated, not duplicated).
 * 4. Return a ReconciliationResult for the router to phrase into a WhatsApp reply.
 *
 * Note: `confirmed` transactions are those the owner explicitly confirmed
 * (confirmed = 1). Unconfirmed entries (confirmed = 0) are excluded here —
 * they must not silently inflate the expected total.
 */
export function reconcileDay(
  date: string,
  reportedTotal: number
): ReconciliationResult {
  // --- 1. Sum confirmed cash-in transactions for the date ---
  // Sale amounts + deni_repayments are cash received.
  // Deni (credit given out) and restock (cash paid out) do NOT count here
  // as cash-in for the trader's daily till reconciliation.
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE date(created_at) = ?
         AND confirmed = 1
         AND type IN ('sale', 'deni_repayment')`
    )
    .get(date) as { total: number };

  const expectedTotal = row.total;
  const variance = reportedTotal - expectedTotal;

  // --- 2. Build notes string (descriptive, never a score) ---
  const absVariance = Math.abs(variance);
  let notes: string;
  if (variance === 0) {
    notes = "Figures match perfectly.";
  } else if (variance > 0) {
    notes = `Owner reported KES ${absVariance.toFixed(2)} more than logged. ` +
      "Possible unlogged cash sale or rounding.";
  } else {
    notes = `Logged transactions exceed reported by KES ${absVariance.toFixed(2)}. ` +
      "Check for duplicate entries or a missed M-Pesa confirmation.";
  }

  // --- 3. Upsert daily_reconciliations (one row per date) ---
  const existing = db
    .prepare("SELECT id FROM daily_reconciliations WHERE date = ?")
    .get(date) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE daily_reconciliations
       SET expected_total = ?, reported_total = ?, variance = ?, notes = ?
       WHERE date = ?`
    ).run(expectedTotal, reportedTotal, variance, notes, date);
  } else {
    db.prepare(
      `INSERT INTO daily_reconciliations
         (date, expected_total, reported_total, variance, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run(date, expectedTotal, reportedTotal, variance, notes);
  }

  // --- 4. Return result for the router to phrase ---
  return {
    date,
    expected_total: expectedTotal,
    reported_total: reportedTotal,
    variance,
    notes,
  };
}

/**
 * Convenience: reconcile today using the current local date.
 * The router uses this when the owner sends a day-close message without
 * specifying a date.
 */
export function reconcileToday(reportedTotal: number): ReconciliationResult {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  return reconcileDay(today, reportedTotal);
}
