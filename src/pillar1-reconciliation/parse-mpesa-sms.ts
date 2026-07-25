import { askClaudeJson } from "../core/claude-client";
import db from "../core/db";
import { ParsedMpesaSms, Transaction } from "../core/types";

// Parsed shape Claude returns for this prompt.
interface MpesaSmsRaw {
  amount: number | null;
  payer_name: string | null;
  till: string | null;
  timestamp: string | null;
}

/**
 * P1 owns this.
 *
 * 1. Calls Claude ("parse-mpesa-sms" prompt) to extract structured fields
 *    from the forwarded M-Pesa Buy Goods / Pochi la Biashara SMS text.
 * 2. Upserts a customer row keyed on payer_name (creates on first visit,
 *    updates last_seen on repeat). Phone is not available from SMS alone.
 * 3. Inserts a CONFIRMED mpesa_buygoods sale transaction linked to that
 *    customer.
 *
 * Returns the parsed SMS fields so the caller (router) can ACK the owner.
 * Throws if Claude cannot parse a required field (amount, payer_name).
 */
export async function parseMpesaSms(smsText: string): Promise<ParsedMpesaSms> {
  // --- 1. Ask Claude to parse the SMS ---
  const parsed = await askClaudeJson<MpesaSmsRaw>(
    "parse-mpesa-sms",
    smsText
  );

  if (!parsed.amount || !parsed.payer_name) {
    throw new Error(
      `parseMpesaSms: Claude could not extract required fields from SMS. ` +
        `Got: ${JSON.stringify(parsed)}`
    );
  }

  const result: ParsedMpesaSms = {
    amount: parsed.amount,
    payer_name: parsed.payer_name,
    till: parsed.till ?? "unknown",
    timestamp: parsed.timestamp ?? new Date().toISOString(),
  };

  // --- 2. Upsert customer by payer_name ---
  // We use name as the natural key from SMS — no phone available here.
  const now = new Date().toISOString();

  const existingCustomer = db
    .prepare("SELECT id FROM customers WHERE name = ?")
    .get(result.payer_name) as { id: number } | undefined;

  let customerId: number;

  if (existingCustomer) {
    db.prepare("UPDATE customers SET last_seen = ? WHERE id = ?").run(
      now,
      existingCustomer.id
    );
    customerId = existingCustomer.id;
  } else {
    const insert = db
      .prepare(
        "INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)"
      )
      .run(result.payer_name, null, null, now, now);
    customerId = insert.lastInsertRowid as number;
  }

  // --- 3. Insert confirmed mpesa_buygoods sale transaction ---
  db.prepare(
    `INSERT INTO transactions
       (customer_id, type, amount, channel, confirmed, raw_input, created_at)
     VALUES (?, 'sale', ?, 'mpesa_buygoods', 1, ?, ?)`
  ).run(customerId, result.amount, smsText, result.timestamp);

  return result;
}
