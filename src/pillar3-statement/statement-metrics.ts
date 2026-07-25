import { Statement } from "../core/types";

// P3 owns this. Pure function of ledger data, no hidden state — descriptive
// and inspectable. NO score/band, ever (README sections 5, 9, 13).
export function computeStatementMetrics(
  _periodStart: string,
  _periodEnd: string
): Omit<Statement, "id" | "generated_at"> {
  throw new Error("not implemented — P3");
}
