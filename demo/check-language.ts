import assert from "node:assert";
import { detectLanguage, Lang } from "../src/webhook/language";

// Reply-language regression check. A wrong guess here is cosmetic rather than
// ledger-corrupting, but answering a Swahili trader in English (or a judge's
// English demo message in Swahili) reads as broken on stage.

const cases: Array<[string, Lang]> = [
  // Clearly Swahili / Sheng
  ["habari", "sw"],
  ["nimeuza maziwa 60", "sw"],
  ["Mary amechukua sukari 200 deni", "sw"],
  ["funga leo 3500", "sw"],
  ["nataka report", "sw"],
  ["nionyeshe wateja wangu", "sw"],
  ["asante sana", "sw"],

  // Clearly English
  ["hello", "en"],
  ["I sold milk for 60", "en"],
  ["Mary took sugar 200 on credit", "en"],
  ["close today 3500", "en"],
  ["I want a report", "en"],
  ["show me my regulars", "en"],
  ["thanks", "en"],
  ["how much does John owe me", "en"],

  // Code-switched Sheng keeps Swahili — "cash" is a loanword, not a sentence
  ["unga 2kg 180 cash", "sw"],
  ["mafuta ya taa 50 bob", "sw"],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = detectLanguage(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${input.padEnd(38)} -> ${got}${ok ? "" : ` (expected ${expected})`}`
  );
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
assert.strictEqual(failed, 0, `${failed} language case(s) wrong`);
