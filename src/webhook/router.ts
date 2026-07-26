import { Router, Request, Response } from "express";
import { config } from "../core/config";
import { sendWhatsapp } from "./whatsapp-client";
import { classifyIntent, Intent } from "./intent";
import { replies } from "./replies";
// Type-only: erased at compile time, so importing P2 here costs nothing at runtime.
import type {
  Customer as P2Customer,
  Transaction as P2Transaction,
} from "../pillar2-retention/types";

const router = Router();

// WhatsApp Cloud API webhook (Meta test number). Two routes on one path:
// GET for Meta's verification handshake, POST for message receipt.
// This file only decides WHERE a message goes — pillars own what happens to it.

// ---------------------------------------------------------------- GET: verify
// Meta calls this once when you click "Verify and Save" in the dashboard, with
// hub.mode / hub.verify_token / hub.challenge. Echo the challenge back as raw
// plain text — a JSON-wrapped or quoted body fails verification.
router.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Guard against an unset env var accidentally matching an empty token.
  if (!config.metaVerifyToken) {
    console.error("[webhook] META_VERIFY_TOKEN is not set — cannot verify");
    res.sendStatus(403);
    return;
  }

  if (mode === "subscribe" && token === config.metaVerifyToken) {
    console.log("[webhook] verification handshake OK");
    res.status(200).type("text/plain").send(String(challenge ?? ""));
    return;
  }

  console.warn(
    `[webhook] verification REJECTED (mode=${JSON.stringify(mode)}, tokenMatch=${token === config.metaVerifyToken})`
  );
  res.sendStatus(403);
});

// -------------------------------------------------------------- POST: receive
router.post("/webhook", async (req: Request, res: Response) => {
  // Ack immediately. Meta retries — and eventually disables the webhook — if we
  // are slow, and any real processing here would double-handle those retries.
  res.sendStatus(200);

  try {
    await handleWebhookPayload(req.body);
  } catch (err) {
    console.error("[webhook] error handling payload:", err);
  }
});

/**
 * Meta's payload nests everything several levels deep, and the same webhook
 * delivers delivery-status callbacks with no `messages` array at all. Every
 * level is optional-chained: a shape we don't expect must not throw.
 */
async function handleWebhookPayload(payload: unknown): Promise<void> {
  const value = (payload as any)?.entry?.[0]?.changes?.[0]?.value;

  if (!value) {
    console.log("[webhook] payload with no change value — ignoring");
    return;
  }

  // Delivery/read receipts arrive on the same hook. Not messages; just note them.
  if (Array.isArray(value.statuses) && value.statuses.length > 0) {
    const s = value.statuses[0];
    console.log(`[webhook] status callback: ${s?.status} for message ${s?.id}`);
    return;
  }

  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    console.log("[webhook] no messages in payload — ignoring");
    return;
  }

  const message = value.messages[0];
  const from: string = message?.from ?? "unknown";
  const name: string | null = value?.contacts?.[0]?.profile?.name ?? null;
  const type: string = message?.type ?? "unknown";
  const timestamp: string = message?.timestamp ?? "";
  const body: string = type === "text" ? (message?.text?.body ?? "") : "";

  // Meta sends unix seconds as a string; show both for readability.
  const iso = timestamp ? new Date(Number(timestamp) * 1000).toISOString() : "";
  console.log(
    `[webhook] inbound message ${JSON.stringify({ from, name, body, timestamp, iso, type })}`
  );

  const reply = await routeMessage(from, body, type);

  try {
    await sendWhatsapp(from, reply);
  } catch (err) {
    console.error(`[webhook] failed to send reply to ${from}:`, err);
  }
}

// ------------------------------------------------------------------- routing

async function routeMessage(
  from: string,
  body: string,
  type: string
): Promise<string> {
  // Voice notes and images arrive as their own message types with no text body.
  // Not wired up yet — needs a media download + transcription step.
  if (type !== "text") {
    console.log(`[router] non-text message from=${from} type=${type}`);
    return replies.notReady(type === "audio" ? "Voice note" : `Message ya aina '${type}'`);
  }

  const { intent, reason } = classifyIntent(body);
  console.log(`[router] from=${from} intent=${intent} (${reason})`);

  return dispatch(intent, body);
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

export { routeMessage, handleWebhookPayload };
export default router;
