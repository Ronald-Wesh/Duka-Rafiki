import { Transaction } from "../core/types";

// P1 owns this. Parses free-text/voice sales/cash entries (EN/SW/Sheng)
// into a structured Transaction via askClaude("parse-transaction", ...).
export async function parseTransaction(
  _text: string
): Promise<Partial<Transaction>> {
  throw new Error("not implemented — P1");
}
