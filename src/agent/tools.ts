import { queryLedger, recordEntries, NewEntry, VALID_KINDS } from "./ledger-store";

export { queryLedger, recordEntries };
export type { NewEntry };

/**
 * The two things the agent can do: read its store with SQL it writes itself,
 * and append entries. Everything else — deciding what she meant, what to
 * record, how to answer — is the model's job, which is the point.
 */

export const TOOL_DEFS = [
  {
    name: "query_ledger",
    description:
      "Run one read-only SQL SELECT against the `ledger` view and get the rows back as JSON. " +
      "Use this whenever a question touches her records — totals, a customer's debt, what sold " +
      "when, who has stopped coming. Prefer one precise query over guessing.",
    input_schema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
      },
      required: ["sql"],
    },
  },
  {
    name: "generate_statement",
    description:
      "Produce her formal transaction record — a one-page document with a shareable link, for a " +
      "bank, SACCO or lender. Use when she asks for a report, a statement, or something to show " +
      "someone who lends money. Returns a URL and a summary; give her the URL verbatim. " +
      "This is a descriptive record of what she logged, never an assessment or a score.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "record_entries",
    description:
      "Append one or more entries to her ledger. Use when she is telling you something happened — " +
      "a sale, goods taken on credit, a repayment, or stock bought. " +
      "Split a message that describes several things into several entries.",
    input_schema: {
      type: "object" as const,
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [...VALID_KINDS],
              },
              amount: { type: "number", description: "KES. Omit for a pure note." },
              item: { type: "string", description: "What it was, as she said it." },
              party: { type: "string", description: "Customer or supplier name." },
              channel: { type: "string", enum: ["cash", "mpesa"] },
              note: { type: "string" },
            },
            required: ["kind"],
          },
        },
      },
      required: ["entries"],
    },
  },
];
