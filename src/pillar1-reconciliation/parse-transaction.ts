import { askClaudeJson } from "../core/claude-client";
import db from "../core/db";
import { Transaction } from "../core/types";

// Shape Claude returns for the parse-transaction prompt.
interface TransactionRaw {
  type: string | null;
  amount: number | null;
  channel: string | null;
  customer_name: string | null;
  notes: string | null;
}

/**
 * P1 owns this.
 *
 * 1. Calls Claude ("parse-transaction" prompt) to extract a structured
 *    transaction from free-text / transcribed-voice in EN/SW/Sheng.
 * 2. If a customer_name is present, upserts a customer row (same logic as
 *    parseMpesaSms — name is the natural key for cash customers).
 * 3. Inserts an UNCONFIRMED transaction (confirmed = 0).  The owner must
 *    explicitly confirm it before it counts in reconciliation totals
 *    (README §5: unconfirmed entries are never silently treated as verified).
 *
 * Returns the Partial<Transaction> so the router can echo it back to the owner
 * for confirmation.
 */
export async function parseTransaction(
  text: string
): Promise<Partial<Transaction>> {
  // --- 1. Ask Claude to parse the free-text entry ---
  const raw = await askClaudeJson<TransactionRaw>("parse-transaction", text);

  // Validate type — fall back to "sale" if Claude returned something unexpected.
  const validTypes = ["sale", "deni", "deni_repayment", "restock"] as const;
  type TxType = (typeof validTypes)[number];
  const txType: TxType = validTypes.includes(raw.type as TxType)
    ? (raw.type as TxType)
    : "sale";

  const validChannels = ["mpesa_buygoods", "cash"] as const;
  type ChannelType = (typeof validChannels)[number];
  const channel: ChannelType | null = validChannels.includes(
    raw.channel as ChannelType
  )
    ? (raw.channel as ChannelType)
    : null;

  // --- 2. Upsert customer if a name was extracted ---
  let customerId: number | null = null;

  if (raw.customer_name) {
    const now = new Date().toISOString();
    const existing = db
      .prepare("SELECT id FROM customers WHERE name = ?")
      .get(raw.customer_name) as { id: number } | undefined;

    if (existing) {
      db.prepare("UPDATE customers SET last_seen = ? WHERE id = ?").run(
        now,
        existing.id
      );
      customerId = existing.id;
    } else {
      const insert = db
        .prepare(
          "INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)"
        )
        .run(raw.customer_name, null, null, now, now);
      customerId = insert.lastInsertRowid as number;
    }
  }

  // --- 3. Build notes string (append raw notes from Claude if any) ---
  const notesArr: string[] = [];
  if (raw.notes) notesArr.push(raw.notes);
  const notes = notesArr.length ? notesArr.join("; ") : null;

  // --- 4. Insert UNCONFIRMED transaction ---
  // confirmed = 0 per README §3 / §11: unconfirmed entries stay out of totals.
  const now = new Date().toISOString();

  if (raw.amount === null) {
    // Can't persist without an amount — return partial for the router to ask owner.
    return {
      customer_id: customerId ?? undefined,
      type: txType,
      channel: channel ?? undefined,
      confirmed: 0,
      raw_input: text,
    } as Partial<Transaction>;
  }

  const insert = db
    .prepare(
      `INSERT INTO transactions
         (customer_id, type, amount, channel, confirmed, raw_input, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(customerId, txType, raw.amount, channel, text, now);

  return {
    id: insert.lastInsertRowid as number,
    customer_id: customerId ?? undefined,
    type: txType,
    amount: raw.amount,
    channel: channel ?? undefined,
    confirmed: 0,
    raw_input: text,
    created_at: now,
  } as Partial<Transaction>;
}
