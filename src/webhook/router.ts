import { Router, Request, Response } from "express";
import { config } from "../core/config";
import { sendWhatsapp } from "./whatsapp-client";
import { handleIncomingMessage } from "./handle-message";
import testUiRouter from "./test-ui";

const router = Router();

// WhatsApp Cloud API webhook (Meta test number). Two routes on one path:
// GET for Meta's verification handshake, POST for message receipt.
//
// This file is Meta transport ONLY — unwrap the payload, hand it to
// handleIncomingMessage(), send the reply back out. All decision-making lives
// in handle-message.ts so the local test UI exercises identical logic.

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

  const { replyText } = await handleIncomingMessage({
    from,
    name,
    body,
    timestamp,
    type,
  });

  try {
    await sendWhatsapp(from, replyText);
  } catch (err) {
    console.error(`[webhook] failed to send reply to ${from}:`, err);
  }
}

// Local test UI (GET /test, POST /test/message). Mounted here so index.ts
// needs no change — it already mounts this router.
router.use(testUiRouter);

export { handleWebhookPayload };
export default router;
