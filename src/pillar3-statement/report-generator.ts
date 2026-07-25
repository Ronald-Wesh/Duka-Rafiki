import { Statement } from "../core/types";

// P3 owns this. Renders the statement into a PDF/HTML shareable report.
export async function generateReport(_statement: Statement): Promise<Buffer | string> {
  throw new Error("not implemented — P3");
}
