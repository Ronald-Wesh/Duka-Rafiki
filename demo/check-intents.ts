import assert from "node:assert";
import { classifyIntent, Intent } from "../src/webhook/intent";

// Routing regression check. Cheap to run, and the failure it catches — a
// forwarded M-Pesa SMS logged as a plain cash sale — silently corrupts the
// ledger rather than throwing, so it would not show up any other way.
const cases: Array<[string, Intent]> = [
  // Real-shaped M-Pesa confirmations
  [
    "QK12ABC3DE Confirmed. You have received Ksh500.00 from JOHN KAMAU 254712345678 on 3/7/26 at 10:15 AM. New M-PESA balance is Ksh12,300.00",
    "mpesa_sms",
  ],
  [
    "SJ84MNQ2PL Confirmed. Ksh1,250.00 received from MARY WANJIKU 0722334455 for Buy Goods. Till 567890",
    "mpesa_sms",
  ],
  ["Umepokea Ksh200.00 kutoka PETER OTIENO kupitia Pochi la Biashara", "mpesa_sms"],

  // Owner's own entries — must NOT be read as forwarded SMS
  ["unga 120 cash", "sale"],
  ["nimeuza maziwa 60", "sale"],
  ["sukari 250 bob", "sale"],

  // Credit
  ["Mary amechukua sukari 200 deni", "deni"],
  ["John anadai 500", "deni"],
  ["Mary amelipa deni yake 200", "deni"],

  // Day close needs a closing word AND a figure
  ["funga leo 3500", "day_close"],
  ["jumla ya leo ni 4200", "day_close"],

  // Explicit asks
  ["nataka report", "report"],
  ["ripoti ya mwezi", "report"],
  ["nionyeshe wateja wangu", "regulars"],

  // Conversational
  ["habari", "help"],
  ["msaada", "help"],
  ["", "unknown"],
  ["asante sana", "unknown"],
];

let failed = 0;
for (const [input, expected] of cases) {
  const { intent, reason } = classifyIntent(input);
  const ok = intent === expected;
  if (!ok) failed++;
  const preview = input.length > 58 ? input.slice(0, 55) + "..." : input || "(empty)";
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${preview.padEnd(60)} -> ${intent}${ok ? "" : ` (expected ${expected})`}  [${reason}]`
  );
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
assert.strictEqual(failed, 0, `${failed} intent case(s) misrouted`);
