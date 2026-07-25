import { ReconciliationResult } from "../core/types";

// P1 owns this. Contract (README section 9): P1 exposes reconcileDay(date)
// and is the only writer of transactions + daily_reconciliations.
export function reconcileDay(_date: string): ReconciliationResult {
  throw new Error("not implemented — P1");
}
