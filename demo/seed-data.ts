import { initDb } from "../src/core/db";
import db from "../src/core/db";

// Smoke-test seed only — confirms webhook/db wiring works end to end.
// Full 3-4 week Swahili/Sheng narrative is shared P0 responsibility;
// pillars should extend this as their features land.
initDb();

const insertCustomer = db.prepare(
  `INSERT INTO customers (name, phone, disambiguator, first_seen, last_seen)
   VALUES (?, ?, ?, datetime('now'), datetime('now'))`
);
const insertTxn = db.prepare(
  `INSERT INTO transactions (customer_id, type, amount, channel, confirmed, raw_input)
   VALUES (?, ?, ?, ?, ?, ?)`
);

const { lastInsertRowid: customerId } = insertCustomer.run(
  "Mary",
  null,
  "blue uniform",
);
insertTxn.run(customerId, "sale", 150, "mpesa_buygoods", 1, "seed: Mary paid 150 via Buy Goods");
insertTxn.run(null, "sale", 50, "cash", 1, "seed: cash sale, unga 50/-");

console.log("Seed complete.");
