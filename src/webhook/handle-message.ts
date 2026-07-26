import { classifyIntent, Intent } from "./intent";
import { replies } from "./replies";
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
}

export async function handleIncomingMessage(
  message: IncomingMessage
): Promise<HandleResult> {
  const { from, body, type = "text" } = message;

  // Voice notes and images arrive as their own message types with no text body.
  // Not wired up yet — needs a media download + transcription step.
  if (type !== "text") {
    console.log(`[router] non-text message from=${from} type=${type}`);
    return {
      replyText: replies.notReady(
        type === "audio" ? "Voice note" : `Message ya aina '${type}'`
      ),
    };
  }

  const { intent, reason } = classifyIntent(body);
  console.log(`[router] from=${from} intent=${intent} (${reason})`);

  return { replyText: await dispatch(intent, body) };
}

async function dispatch(intent: Intent, body: string): Promise<string> {
  switch (intent) {
    case "help":
      return replies.help;

    case "unknown":
      // Logged in full so a misroute can be diagnosed from the demo transcript.
      console.log(`[router] unrouted: ${JSON.stringify(body)}`);
      return replies.unknown;

    // Everything below belongs to a pillar. Each is called through
    // pillarCall() so a not-yet-implemented handler degrades to an honest
    // message instead of throwing into the void.
    case "mpesa_sms":
      return pillarCall("M-Pesa SMS", async () => {
        const { parseMpesaSms } = await import(
          "../pillar1-reconciliation/parse-mpesa-sms"
        );
        const parsed = await parseMpesaSms(body);
        return `Nimeandika: Ksh ${parsed.amount} kutoka ${parsed.payer_name} ✅`;
      });

    case "sale":
      return pillarCall("Mauzo ya cash", async () => {
        const { parseTransaction } = await import(
          "../pillar1-reconciliation/parse-transaction"
        );
        const txn = await parseTransaction(body);
        return `Nimeandika: Ksh ${txn.amount} ✅`;
      });

    case "deni":
      return pillarCall("Deni", async () => {
        const { parseTransaction } = await import(
          "../pillar1-reconciliation/parse-transaction"
        );
        const txn = await parseTransaction(body);
        return `Deni imeandikwa: Ksh ${txn.amount} ✅`;
      });

    case "day_close":
      return pillarCall("Kufunga siku", async () => {
        const { reconcileDay } = await import(
          "../pillar1-reconciliation/reconcile"
        );
        const today = new Date().toISOString().slice(0, 10);
        const result = reconcileDay(today);
        return [
          `Kufunga siku ${result.date}:`,
          `Zilizoandikwa: Ksh ${result.expected_total}`,
          `Umesema: Ksh ${result.reported_total}`,
          `Tofauti: Ksh ${result.variance}`,
        ].join("\n");
      });

    case "regulars":
      return pillarCall("Orodha ya wateja", async () => {
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
        const { text } = await draftRegularsSummary(
          summary,
          (promptName, promptInput, maxTokens) =>
            askClaude(promptName, promptInput, { maxTokens })
        );
        return text;
      });

    case "report":
      return pillarCall("Ripoti", async () => {
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
  fn: () => Promise<string>
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not implemented/i.test(message)) {
      console.log(`[router] ${label}: pillar handler not implemented yet`);
      return replies.notReady(label);
    }
    console.error(`[router] ${label} failed:`, err);
    return replies.failed;
  }
}
