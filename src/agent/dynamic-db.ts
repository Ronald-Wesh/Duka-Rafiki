import Database from "better-sqlite3";
import path from "path";

/**
 * The agent's own store, separate from duka.db so the pillars keep their
 * rigid schema and this can stay loose.
 *
 * One wide table instead of four narrow ones. The kiosk's reality does not
 * fit fixed columns — she names items, part-pays, sells on credit to someone
 * who also owes her from last week — so `entries` keeps the shape flat and
 * lets `note` and `meta` hold whatever else was in the message. The agent
 * queries it with SQL it writes itself, which is only workable because the
 * schema is small enough to put in a prompt.
 *
 * `at` is UTC. Nairobi is UTC+3 with no DST, so day buckets use
 * date(at, '+3 hours') — evening sales land on the wrong day otherwise.
 */

const DB_PATH = process.env.AGENT_DB_PATH ?? path.join(process.cwd(), "duka-dynamic.db");

const agentDb = new Database(DB_PATH);
agentDb.pragma("journal_mode = WAL");

agentDb.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    kind TEXT NOT NULL,              -- sale | deni | deni_repayment | restock | expense | note
    amount REAL,                     -- NULL for a pure note
    item TEXT,                       -- "maziwa", "unga 2kg" — free text, often NULL
    party TEXT,                      -- customer or supplier name, free text
    channel TEXT,                    -- cash | mpesa | NULL
    confirmed INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    meta TEXT,                       -- JSON for anything else worth keeping
    raw_text TEXT                    -- exactly what she typed, for audit
  );
  CREATE INDEX IF NOT EXISTS idx_entries_at ON entries(at);
  CREATE INDEX IF NOT EXISTS idx_entries_party ON entries(party);
  CREATE INDEX IF NOT EXISTS idx_entries_item ON entries(item);
  CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
`);

/** Put in the agent's prompt, so keep it short and accurate. */
export const SCHEMA_DESCRIPTION = `
TABLE entries (
  id, at (UTC datetime), kind, amount, item, party, channel,
  confirmed (0=self-reported, 1=owner-confirmed), note, meta, raw_text
)
kind is one of: sale, deni (goods on credit), deni_repayment, restock, expense, note.
Money is KES. Nairobi is UTC+3 — always bucket days with date(at, '+3 hours').
Today in Nairobi is date('now', '+3 hours').
A customer's outstanding debt = SUM(deni) - SUM(deni_repayment) for that party.
item and party are free text and often NULL; match them with LIKE, not =.
`.trim();

export default agentDb;

/**
 * Copy duka.db's history across so the agent has a past on day one. Idempotent
 * via a marker row — re-running must not double the ledger.
 */
export function importFromLegacy(legacyPath = process.env.DB_PATH ?? "./duka.db"): number {
  const already = agentDb
    .prepare("SELECT COUNT(*) AS n FROM entries WHERE meta = '{\"imported\":true}'")
    .get() as { n: number };
  if (already.n > 0) return 0;

  const legacy = new Database(legacyPath, { readonly: true });
  const rows = legacy
    .prepare(
      `SELECT t.type AS kind, t.amount, t.channel, t.confirmed, t.raw_input,
              t.created_at, c.name AS party
         FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id`
    )
    .all() as Array<{
    kind: string;
    amount: number;
    channel: string | null;
    confirmed: number;
    raw_input: string | null;
    created_at: string;
    party: string | null;
  }>;

  const insert = agentDb.prepare(
    `INSERT INTO entries (at, kind, amount, item, party, channel, confirmed, note, meta, raw_text)
     VALUES (@at, @kind, @amount, NULL, @party, @channel, @confirmed, NULL, '{"imported":true}', @raw_text)`
  );
  const tx = agentDb.transaction((rs: typeof rows) => {
    for (const r of rs) {
      insert.run({
        at: r.created_at,
        kind: r.kind,
        amount: r.amount,
        party: r.party,
        channel: r.channel === "mpesa_buygoods" ? "mpesa" : r.channel,
        confirmed: r.confirmed,
        raw_text: r.raw_input,
      });
    }
  });
  tx(rows);
  legacy.close();
  return rows.length;
}
