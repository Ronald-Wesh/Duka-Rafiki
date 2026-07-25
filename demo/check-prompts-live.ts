import { askClaude, askClaudeJson } from "../src/core/claude-client";
import { ParsedMpesaSms, ParsedTransaction, isParseError } from "../src/core/types";
import { config } from "../src/core/config";

// Live prompt smoke test — needs ANTHROPIC_API_KEY. Costs a handful of cheap
// calls. Run this before the demo: check:prompts only proves the files load,
// not that the model actually obeys them.
//
//   npm run check:prompts:live

if (!config.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY not set — skipping live prompt checks.");
  process.exit(1);
}

let failures = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}\n        ${err instanceof Error ? err.message : err}`);
  }
}

const eq = (actual: unknown, expected: unknown, what: string) => {
  if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

async function main() {
  await check("parses an M-Pesa SMS, including the DD/MM date trap", async () => {
    const r = await askClaudeJson<ParsedMpesaSms>(
      "parse-mpesa-sms",
      "QK12ABC3DE Confirmed. You have received Ksh500.00 from JOHN KAMAU 254712345678 on 3/7/26 at 10:15 AM. New M-PESA balance is Ksh12,300.00"
    );
    if (isParseError(r)) throw new Error(`unexpected error: ${r.error}`);
    eq(r.amount, 500, "amount");
    eq(r.payer_name, "John Kamau", "payer_name");
    // 3/7/26 is 3 July, not 7 March. Also proves the balance wasn't summed in.
    if (!r.timestamp.startsWith("2026-07-03T10:15")) {
      throw new Error(`timestamp: got ${r.timestamp}, expected 2026-07-03T10:15 (D/M/Y)`);
    }
  });

  await check("rejects a non-M-Pesa message instead of guessing", async () => {
    const r = await askClaudeJson<ParsedMpesaSms>("parse-mpesa-sms", "nimeuza maziwa 60 cash");
    if (!isParseError(r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  });

  await check("parses a cash sale", async () => {
    const r = await askClaudeJson<ParsedTransaction>("parse-transaction", "unga 2kg 180 cash");
    if (isParseError(r)) throw new Error(`unexpected error: ${r.error}`);
    eq(r.type, "sale", "type");
    eq(r.amount, 180, "amount");
    eq(r.channel, "cash", "channel");
  });

  await check("parses deni with a disambiguator", async () => {
    const r = await askClaudeJson<ParsedTransaction>(
      "parse-transaction",
      "Mary (blue uniform) amechukua sukari 200 deni"
    );
    if (isParseError(r)) throw new Error(`unexpected error: ${r.error}`);
    eq(r.type, "deni", "type");
    eq(r.amount, 200, "amount");
    eq(r.customer_name, "Mary", "customer_name");
    eq(r.disambiguator, "blue uniform", "disambiguator");
  });

  await check("distinguishes repayment from credit", async () => {
    const r = await askClaudeJson<ParsedTransaction>("parse-transaction", "john amelipa deni yake 150");
    if (isParseError(r)) throw new Error(`unexpected error: ${r.error}`);
    eq(r.type, "deni_repayment", "type");
  });

  await check("refuses to multiply quantity x unit price", async () => {
    const r = await askClaudeJson<ParsedTransaction>("parse-transaction", "soda mbili 50");
    // The model must NOT invent 100. Either an error, or 50 flagged for review.
    if (!isParseError(r) && !(r.amount === 50 && r.needs_review)) {
      throw new Error(`expected refusal or flagged 50, got ${JSON.stringify(r)}`);
    }
  });

  await check("phrases a summary without computing or scoring", async () => {
    const metrics = {
      period_start: "2026-06-29",
      period_end: "2026-07-26",
      total_sales: 63265,
      days_reconciled: 23,
      days_in_period: 28,
      outstanding_receivables: 873,
      unconfirmed_count: 22,
    };
    const text = await askClaude("phrase-summary", JSON.stringify(metrics), {
      maxTokens: 600,
    });

    const banned = ["credit score", "creditworth", "rating", "risk level", "eligible", "approved"];
    const hit = banned.find((w) => text.toLowerCase().includes(w));
    if (hit) throw new Error(`used forbidden term "${hit}" — we are not an FSP:\n${text}`);

    if (!text.includes("63,265") && !text.includes("63265")) {
      throw new Error(`total_sales missing from summary:\n${text}`);
    }
    // 23/28 = 82.1%. If that appears, the model computed it — the one thing
    // it must never do, since every figure has to trace back to the ledger.
    if (/8[23](\.\d)?\s?%/.test(text)) {
      throw new Error(`model computed a percentage instead of quoting figures:\n${text}`);
    }
    console.log(`\n      --- summary output ---\n${text.split("\n").map((l) => "      " + l).join("\n")}\n`);
  });

  console.log(`\n${failures === 0 ? "All live prompt checks passed." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
