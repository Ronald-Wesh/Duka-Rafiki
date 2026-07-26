import agentDb from "./dynamic-db";

/**
 * The two things the agent can do: read its store with SQL it writes itself,
 * and append entries. Everything else — deciding what she meant, what to
 * record, how to answer — is the model's job, which is the point.
 */

export const TOOL_DEFS = [
  {
    name: "query_ledger",
    description:
      "Run one read-only SQL SELECT against the entries table and get the rows back as JSON. " +
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
      "a sale, goods taken on credit, a repayment, stock bought, an expense, or a note worth keeping. " +
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
                enum: ["sale", "deni", "deni_repayment", "restock", "expense", "note"],
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

/** SELECT only, one statement. She is not the threat here; a confused model is. */
export function queryLedger(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(trimmed)) return JSON.stringify({ error: "Only SELECT is allowed." });
  if (/;/.test(trimmed)) return JSON.stringify({ error: "One statement only." });
  if (/\b(insert|update|delete|drop|alter|create|attach|pragma|replace)\b/i.test(trimmed)) {
    return JSON.stringify({ error: "Only SELECT is allowed." });
  }

  try {
    const rows = agentDb.prepare(trimmed).all();
    // A runaway SELECT * would blow the context window and tell her nothing.
    const capped = (rows as unknown[]).slice(0, 60);
    return JSON.stringify({
      row_count: (rows as unknown[]).length,
      truncated: (rows as unknown[]).length > capped.length,
      rows: capped,
    });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

export interface NewEntry {
  kind: string;
  amount?: number;
  item?: string;
  party?: string;
  channel?: string;
  note?: string;
}

export function recordEntries(entries: NewEntry[], rawText: string): string {
  const insert = agentDb.prepare(
    `INSERT INTO entries (kind, amount, item, party, channel, confirmed, note, raw_text)
     VALUES (@kind, @amount, @item, @party, @channel, 0, @note, @raw_text)`
  );

  const ids: number[] = [];
  const tx = agentDb.transaction((rows: NewEntry[]) => {
    for (const e of rows) {
      const r = insert.run({
        kind: e.kind,
        amount: e.amount ?? null,
        item: e.item ?? null,
        party: e.party ?? null,
        channel: e.channel ?? null,
        note: e.note ?? null,
        raw_text: rawText,
      });
      ids.push(Number(r.lastInsertRowid));
    }
  });

  try {
    tx(entries);
    return JSON.stringify({ recorded: ids.length, ids });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}
