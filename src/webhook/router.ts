import { Router, Request, Response } from "express";
import { sendWhatsapp } from "./whatsapp-client";
import { classifyIntent, Intent } from "./intent";
import { replies } from "./replies";

const router = Router();

// Twilio WhatsApp sandbox inbound webhook. This file only decides WHERE a
// message goes — pillars own what happens to it (README section 7).
router.post("/webhook", async (req: Request, res: Response) => {
  const from = (req.body.From as string) ?? "unknown";
  const body = (req.body.Body as string) ?? "";
  const numMedia = Number(req.body.NumMedia ?? 0);

  // Ack Twilio immediately and reply out-of-band. Parsing can take a couple of
  // seconds once the model is in the loop, and a slow 200 makes Twilio retry —
  // which would double-log every transaction.
  res.status(200).end();

  let reply: string;
  try {
    reply = await routeMessage(from, body, numMedia);
  } catch (err) {
    console.error(`[router] unhandled failure from=${from}:`, err);
    console.error(`[router] raw input was: ${JSON.stringify(body)}`);
    reply = replies.failed;
  }

  try {
    await sendWhatsapp(from, reply);
  } catch (err) {
    console.error(`[router] failed to send reply to ${from}:`, err);
  }
});

async function routeMessage(
  from: string,
  body: string,
  numMedia: number
): Promise<string> {
  // Voice notes arrive as media with an empty Body. Not wired up yet — see
  // PROGRESS.md; needs a download + transcription step before it can route.
  if (numMedia > 0 && !body.trim()) {
    console.log(`[router] media message from=${from} (${numMedia} attachment(s))`);
    return replies.notReady("Voice note");
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
        // P2's seam. Reads the ledger, computes the figures, and phrases them —
        // returning a message that is already sendable. Works without an
        // ANTHROPIC_API_KEY (plainer wording, same figures) so this path never
        // depends on the model being reachable.
        const { getWeeklyRegularsMessage } = await import(
          "../pillar2-retention/service"
        );
        const { text, promo } = await getWeeklyRegularsMessage();

        // The promo is a draft for the owner to edit and forward herself — P2
        // never sends to customers, and nothing here does either.
        return promo ? `${text}\n\n---\n${promo.text}` : text;
      });

    case "report":
      return pillarCall("Ripoti", async () => {
        const { computeStatementMetrics } = await import(
          "../pillar3-statement/statement-metrics"
        );
        const { generateReport } = await import(
          "../pillar3-statement/report-generator"
        );
        const today = new Date().toISOString().slice(0, 10);
        const metrics = computeStatementMetrics(today, today);
        await generateReport({ ...metrics, id: 0, generated_at: today });
        return "Ripoti yako iko tayari 📄";
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

export { routeMessage };
export default router;
