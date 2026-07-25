// demo/test-p1.js — P1 local smoke tests
// Run while `npm run dev` is active in another terminal.
// Usage:  node demo/test-p1.js

const http = require("http");

const BASE = "http://localhost:3000";

const TESTS = [
  {
    label: "1. M-Pesa Buy Goods SMS",
    body: "QHK2X4Y7Z3 Confirmed. Ksh500.00 received from GRACE WANJIKU 0712345678 on 25/7/26 at 2:47 PM. New M-PESA balance is Ksh3,200.00. Till Number 987654.",
  },
  {
    label: "2. M-Pesa SMS - repeat customer (GRACE WANJIKU again)",
    body: "SBK9P1M2N4 Confirmed. Ksh1,200.00 received from GRACE WANJIKU 0712345678 on 25/7/26 at 4:15 PM. New M-PESA balance is Ksh4,400.00. Till Number 987654.",
  },
  {
    label: "3. Cash sale in Swahili",
    body: "nimepokea 150 cash na John",
  },
  {
    label: "4. Deni (credit given, no amount)",
    body: "nimempa Mary sukari 2kg deni, atalipa kesho",
  },
  {
    label: "5. Deni repayment",
    body: "John amenilipa deni yake ya 300",
  },
  {
    label: "6. English sale with item",
    body: "sold mandazi and chai for 60 bob",
  },
  {
    label: "7. Day-close reconciliation (leo 2000)",
    body: "leo 2000",
  },
];

function postWebhook(msg) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams({
      From: "whatsapp:+254712345678",
      Body: msg,
    }).toString();

    const opts = {
      hostname: "localhost",
      port: 3000,
      path: "/webhook",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(res.statusCode));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log("\nDuka Rafiki — Pillar 1 Local Smoke Tests");
  console.log("=========================================");
  console.log("Watch the npm run dev terminal for [DEV REPLY] output.\n");

  for (const t of TESTS) {
    console.log(`\n----- ${t.label} -----`);
    console.log(`MSG: ${t.body}`);
    try {
      const status = await postWebhook(t.body);
      console.log(`HTTP ${status} — waiting for Claude...`);
      // Give Claude time to respond before sending the next one
      await new Promise((r) => setTimeout(r, 4000));
    } catch (err) {
      console.error("FAIL:", err.message);
    }
  }

  console.log("\n=========================================");
  console.log("All tests sent.");
}

run();
