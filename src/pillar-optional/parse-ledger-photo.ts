// Stretch, not load-bearing for the demo (README section 3). Claude vision
// reads a photographed handwritten ledger page into a structured table with
// per-line confidence flagging. Unconfirmed entries are excluded from the
// statement — never silently treated as verified.
export async function parseLedgerPhoto(_imagePath: string): Promise<unknown> {
  throw new Error("not implemented — stretch");
}
