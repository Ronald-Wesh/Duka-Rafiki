import db from "../core/db";

/**
 * One store for everything.
 *
 * The agent used to write to duka-dynamic.db while the pillars and the
 * statement read duka.db, so a sale logged over WhatsApp never reached the
 * report — two ledgers that silently disagreed. Everything now reads and
 * writes duka.db, which makes a chat entry visible to reconciliation, the
 * regulars list and the lender-facing statement the moment it lands.
 *
 * better-sqlite3 is synchronous, so a write is durable and visible to the
 * next read with no await and no cache to invalidate.
 */

/** Additive, idempotent. SQLite cannot drop a column, so never remove one here. */
function migrate(): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  );

  // The agent captures detail the original four columns had nowhere to put.
  if (!cols.has("item")) db.exec("ALTER TABLE transactions ADD COLUMN item TEXT");
  if (!cols.has("note")) db.exec("ALTER TABLE transactions ADD COLUMN note TEXT");

  // Concurrent readers (the statement page) must not block on a writer
  // (a message arriving mid-demo).
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // The agent writes SQL against this, so it never has to remember the join.
  db.exec(`
    CREATE VIEW IF NOT EXISTS ledger AS
      SELECT t.id, t.type AS kind, t.amount, t.item, c.name AS party,
             t.channel, t.confirmed, t.note, t.raw_input AS raw_text,
             t.created_at AS at, date(t.created_at, '+3 hours') AS day
        FROM transactions t
        LEFT JOIN customers c ON c.id = t.customer_id
  `);
}

migrate();

export const SCHEMA_DESCRIPTION = `
VIEW ledger (
  id, kind, amount, item, party, channel,
  confirmed (0=self-reported, 1=owner-confirmed),
  note, raw_text, at (UTC datetime), day (Nairobi calendar date)
)
kind is one of: sale, deni (goods on credit), deni_repayment, restock.
Money is KES. Use the "day" column for anything per-day; it is already
Nairobi-local. Today is date('now', '+3 hours').
A customer's outstanding debt = SUM(deni) - SUM(deni_repayment) for that party.
item and party are free text and often NULL on older rows; match with LIKE.
`.trim();

export const VALID_KINDS = ["sale", "deni", "deni_repayment", "restock"] as const;

export interface NewEntry {
  kind: string;
  amount?: number;
  item?: string;
  party?: string;
  channel?: string;
  note?: string;
}

/** Name is the natural key for cash customers — same rule parse-transaction uses. */
function upsertCustomer(name: string): number {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM customers WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (existing) {
    db.prepare("UPDATE customers SET last_seen = ? WHERE id = ?").run(now, existing.id);
    return existing.id;
  }
  return Number(
    db
      .prepare(
        "INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen) VALUES (?, NULL, NULL, ?, ?)"
      )
      .run(name, now, now).lastInsertRowid
  );
}

export function recordEntries(entries: NewEntry[], rawText: string): string {
  const insert = db.prepare(
    `INSERT INTO transactions (customer_id, type, amount, channel, confirmed, raw_input, created_at, item, note)
     VALUES (@customer_id, @type, @amount, @channel, 0, @raw_input,
             strftime('%Y-%m-%dT%H:%M:%SZ','now'), @item, @note)`
  );

  const ids: number[] = [];
  const rejected: string[] = [];

  // One transaction: a message describing a repayment and a sale either
  // records both or neither, never half.
  const run = db.transaction((rows: NewEntry[]) => {
    for (const e of rows) {
      if (!(VALID_KINDS as readonly string[]).includes(e.kind)) {
        rejected.push(e.kind);
        continue;
      }
      const channel = e.channel === "mpesa" ? "mpesa_buygoods" : e.channel === "cash" ? "cash" : null;
      const r = insert.run({
        customer_id: e.party ? upsertCustomer(e.party) : null,
        type: e.kind,
        amount: e.amount ?? 0,
        channel,
        raw_input: rawText,
        item: e.item ?? null,
        note: e.note ?? null,
      });
      ids.push(Number(r.lastInsertRowid));
    }
  });

  try {
    run(entries);
    return JSON.stringify({
      recorded: ids.length,
      ids,
      ...(rejected.length ? { rejected_kinds: rejected } : {}),
    });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

/** SELECT only, one statement. The threat is a confused model, not the owner. */
export function queryLedger(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(trimmed)) return JSON.stringify({ error: "Only SELECT is allowed." });
  if (/;/.test(trimmed)) return JSON.stringify({ error: "One statement only." });
  if (/\b(insert|update|delete|drop|alter|create|attach|pragma|replace)\b/i.test(trimmed)) {
    return JSON.stringify({ error: "Only SELECT is allowed." });
  }

  try {
    const rows = db.prepare(trimmed).all() as unknown[];
    const capped = rows.slice(0, 60);
    return JSON.stringify({
      row_count: rows.length,
      truncated: rows.length > capped.length,
      rows: capped,
    });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}
