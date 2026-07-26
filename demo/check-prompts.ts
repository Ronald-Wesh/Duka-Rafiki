import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { loadPrompt, extractJson } from "../src/core/claude-client";

// Offline checks — no API key, no network. Verifies the prompt files load, the
// JSON extraction is robust, and no scoring language has crept into the
// codebase (README section 13: "credit score", "band", "rating" must appear
// nowhere in product, schema, or pitch — a product requirement, not style).

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}\n        ${err instanceof Error ? err.message : err}`);
  }
}

const EXPECTED = ["parse-mpesa-sms", "parse-transaction", "draft-promo", "phrase-summary"];

for (const name of EXPECTED) {
  check(`prompt "${name}" loads and has content`, () => {
    const body = loadPrompt(name);
    assert.ok(body.length > 400, `${name}.md looks too thin (${body.length} chars)`);
  });
}

check("parse prompts specify raw JSON and the error convention", () => {
  for (const name of ["parse-mpesa-sms", "parse-transaction"]) {
    const body = loadPrompt(name);
    assert.match(body, /raw JSON/i, `${name} doesn't ask for raw JSON`);
    assert.match(body, /"error"/, `${name} doesn't document the error fallback`);
  }
});

check("parse prompts forbid computing figures", () => {
  for (const name of ["parse-mpesa-sms", "parse-transaction"]) {
    const body = loadPrompt(name);
    assert.match(body, /never (?:calculate|add|compute)/i, `${name} doesn't forbid arithmetic`);
  }
});

check("phrase-summary forbids scoring language", () => {
  const body = loadPrompt("phrase-summary");
  for (const word of ["credit score", "band", "rating", "creditworth"]) {
    assert.ok(
      body.toLowerCase().includes(word),
      `phrase-summary should explicitly prohibit "${word}"`
    );
  }
  assert.match(body, /never (?:produce|write)/i, "no hard prohibition wording found");
});

check("loadPrompt fails clearly on an unknown name", () => {
  assert.throws(() => loadPrompt("does-not-exist"), /No prompt "does-not-exist"/);
});

check("extractJson handles fences, prose and bare JSON", () => {
  const want = '{"amount": 500}';
  assert.strictEqual(extractJson('{"amount": 500}'), want);
  assert.strictEqual(extractJson('```json\n{"amount": 500}\n```'), want);
  assert.strictEqual(extractJson('```\n{"amount": 500}\n```'), want);
  assert.strictEqual(extractJson('Here you go:\n{"amount": 500}\nhope that helps'), want);
  assert.strictEqual(extractJson('  \n{"amount": 500}\n  '), want);
});

// Scan source for scoring vocabulary. The words are allowed in comments and
// prompt prohibitions — that's where we tell ourselves and the model NOT to use
// them. What must stay clean is the product surface: schema columns, type
// fields, and anything the owner or a lender actually reads.
check("no scoring vocabulary on the product surface", () => {
  const BANNED = /credit\s*score|creditworth|\bscore\b|\brating\b|risk\s*level/i;
  // These name the words in order to forbid or assert against them.
  // Adding a prompt that prohibits scoring language? Add its filename here too.
  const EXEMPT = [
    "phrase-summary.md",
    "statement-summary.md", // P3's statement prompt — forbids the same words
    "check-prompts.ts",
    "check-prompts-live.ts",
    "README.md",
  ];
  const isComment = (line: string) => /^\s*(--|\/\/|\*|\/\*|#)/.test(line);
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(ts|sql|md)$/.test(entry.name) && !EXEMPT.includes(entry.name)) {
        const text = fs.readFileSync(full, "utf-8");
        text.split("\n").forEach((line, i) => {
          if (!isComment(line) && BANNED.test(line)) {
            offenders.push(`${full}:${i + 1}  ${line.trim().slice(0, 80)}`);
          }
        });
      }
    }
  };
  walk(path.join(__dirname, "..", "src"));
  walk(__dirname);

  assert.strictEqual(
    offenders.length,
    0,
    `scoring language found (we are not an FSP):\n        ${offenders.join("\n        ")}`
  );
});

console.log(
  `\n${failures === 0 ? "All prompt checks passed." : `${failures} check(s) failed.`}`
);
process.exit(failures === 0 ? 0 : 1);
