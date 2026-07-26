import { classifyIntent, Intent } from "./intent";
import { replies } from "./replies";
import { detectLanguage, Lang } from "./language";
// Type-only: erased at compile time, so importing P2 here costs nothing at runtime.
import type {
  Customer as P2Customer,
  Transaction as P2Transaction,
} from "../pillar2-retention/types";

/**
 * Transport-agnostic message handling.
 *
 * This is the single implementation of "a message arrived, what do we say
 * back". The Meta webhook and the local test UI both call it, so anything you
 * can reproduce at /test behaves identically on a real WhatsApp message.
 * Nothing in here knows about Meta, signatures, or the Graph API — and it
 * never sends anything outbound; it only returns the reply text.
 */

export interface IncomingMessage {
  /** WhatsApp sender ID, or any fake value from the test UI. */
  from: string;
  /** Sender's display name where the transport provides one. */
  name?: string | null;
  /** Message text. Empty for non-text messages. */
  body: string;
  /** Unix seconds as a string, as Meta sends it. Optional for tests. */
  timestamp?: string;
  /** Meta message type — `text`, `audio`, `image`… Defaults to `text`. */
  type?: string;
}

export interface HandleResult {
  replyText: string;
  /** Which intent fired — surfaced so the test UI can show misroutes. */
  intent?: Intent;
  /** Language the reply was written in. */
  lang?: Lang;
  /** True when this path called the Anthropic API. */
  usedClaude?: boolean;
}

export async function handleIncomingMessage(
  message: IncomingMessage
): Promise<HandleResult> {
  const { from, body, type = "text" } = message;
  const lang = detectLanguage(body);

  // Voice notes and images arrive as their own message types with no text body.
  // Not wired up yet — needs a media download + transcription step.
  if (type !== "text") {
    console.log(`[router] non-text message from=${from} type=${type}`);
    return {
      replyText: replies.notReady(
        lang,
        type === "audio"
          ? lang === "en"
            ? "Voice notes"
            : "Voice note"
          : `${type}`
      ),
      lang,
      usedClaude: false,
    };
  }

  const { intent, reason } = classifyIntent(body);
  console.log(`[router] from=${from} lang=${lang} intent=${intent} (${reason})`);

  const replyText = await dispatch(intent, body, lang);
  return { replyText, intent, lang, usedClaude: CLAUDE_INTENTS.has(intent) };
}

/**
 * Language instruction appended to a pillar's prompt input.
 *
 * Pillar prompts are written Swahili-first. Rather than editing files another
 * pillar owns, the owner's detected language is passed alongside the facts.
 */
function langDirective(lang: Lang): string {
  return lang === "en"
    ? "\n\nWrite your reply in English."
    : "\n\nAndika jibu lako kwa Kiswahili.";
}

/** Intents whose handlers call the Anthropic API. */
const CLAUDE_INTENTS = new Set<Intent>([
  "mpesa_sms",
  "sale",
  "deni",
  "regulars",
  "report",
]);

/**
 * Pull the owner's stated day-close total out of "funga leo 3500".
 *
 * Deterministic on purpose: this figure is one side of the reconciliation, so
 * it must be read from what she typed, never inferred. Takes the largest number
 * in the message — "funga leo 3500" has one, and in "jumla ya leo ni 4,200" the
 * amount is still the only real figure. Returns null if there is no number.
 */
function extractReportedTotal(text: string): number | null {
  const matches = text.match(/\d[\d,]*(?:\.\d{1,2})?/g);
  if (!matches) return null;
  const amounts = matches
    .map((m) => Number(m.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return amounts.length ? Math.max(...amounts) : null;
}

async function dispatch(
  intent: Intent,
  body: string,
  lang: Lang
): Promise<string> {
  switch (intent) {
    case "help":
      return replies.help(lang);

    case "unknown":
      // Logged in full so a misroute can be diagnosed from the demo transcript.
      console.log(`[router] unrouted: ${JSON.stringify(body)}`);
      return replies.unknown(lang);

    // Everything below belongs to a pillar. Each is called through
    // pillarCall() so a not-yet-implemented handler degrades to an honest
    // message instead of throwing into the void.
    case "mpesa_sms":
      return pillarCall("M-Pesa SMS", lang, async () => {
        const { parseMpesaSms } = await import(
          "../pillar1-reconciliation/parse-mpesa-sms"
        );
        const parsed = await parseMpesaSms(body);
        return replies.mpesaLogged(lang, parsed.amount, parsed.payer_name);
      });

    case "sale":
      return pillarCall("Mauzo ya cash", lang, async () => {
        const { parseTransaction } = await import(
          "../pillar1-reconciliation/parse-transaction"
        );
        const txn = await parseTransaction(body);
        return replies.saleLogged(lang, Number(txn.amount ?? 0));
      });

    case "deni":
      return pillarCall("Deni", lang, async () => {
        const { parseTransaction } = await import(
          "../pillar1-reconciliation/parse-transaction"
        );
        const txn = await parseTransaction(body);
        return replies.deniLogged(lang, Number(txn.amount ?? 0));
      });

    case "day_close":
      return pillarCall("Kufunga siku", lang, async () => {
        const reportedTotal = extractReportedTotal(body);
        if (reportedTotal === null) return replies.askDayTotal(lang);

        const { reconcileToday } = await import(
          "../pillar1-reconciliation/reconcile"
        );
        const r = reconcileToday(reportedTotal);
        // Every figure here comes from P1's deterministic arithmetic — the model
        // is not involved in the close.
        return replies.dayClose(lang, r);
      });

    case "regulars":
      return pillarCall("Orodha ya wateja", lang, async () => {
        const { buildRegularsSummary } = await import(
          "../pillar2-retention/repeat-detection"
        );
        const { draftRegularsSummary } = await import(
          "../pillar2-retention/promo-drafts"
        );
        const { toEatDateKey } = await import(
          "../pillar2-retention/customer-profile"
        );
        const { default: db } = await import("../core/db");
        const { askClaude } = await import("../core/claude-client");
        // P2 windows the ledger itself, so hand it everything unwindowed.
        const customers = db
          .prepare("SELECT * FROM customers")
          .all() as P2Customer[];
        const transactions = db
          .prepare("SELECT * FROM transactions")
          .all() as P2Transaction[];

        const summary = buildRegularsSummary(customers, transactions, {
          asOfDateKey: toEatDateKey(new Date().toISOString()),
        });

        // draftRegularsSummary falls back to deterministic text if the model
        // drops or alters a figure, so it never throws and never invents one.
        //
        // The language directive is appended to the INPUT rather than editing
        // P2's prompt file (theirs to own). If the model mangles a figure while
        // switching language, their verification rejects it and the
        // deterministic text is returned — so this can degrade, never corrupt.
        const { text } = await draftRegularsSummary(
          summary,
          (promptName, promptInput, maxTokens) =>
            askClaude(promptName, promptInput + langDirective(lang), {
              maxTokens,
            })
        );
        return text;
      });

    case "report":
      return pillarCall("Ripoti", lang, async () => {
        const { generateStatement } = await import("../pillar3-statement");
        // Defaults to the trailing 28 days — a one-day period is not a record.
        const { url, summary } = await generateStatement();
        return `Ripoti yako iko tayari 📄\n${url}\n\n${summary}`;
      });
  }
}

/**
 * Runs a pillar handler, converting the two failure modes that matter into
 * something the owner can read:
 *   - handler not implemented yet  -> honest "not saved yet" notice
 *   - handler threw for any reason -> generic failure, full detail to the log
 */
async function pillarCall(
  label: string,
  lang: Lang,
  fn: () => Promise<string>
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not implemented/i.test(message)) {
      console.log(`[router] ${label}: pillar handler not implemented yet`);
      return replies.notReady(lang, label);
    }
    console.error(`[router] ${label} failed:`, err);
    return replies.failed(lang);
  }
}
