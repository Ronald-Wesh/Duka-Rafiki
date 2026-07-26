import { Router, Request, Response } from "express";
import { config } from "../core/config";
import { sendWhatsapp } from "./whatsapp-client";
import { handleIncomingMessage } from "./handle-message";
import testUiRouter from "./test-ui";
import { validateRequest } from "twilio";

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

// ------------------------------------------------------- Twilio sandbox path
// TEMPORARY, UNCOMMITTED: fallback transport while Meta business verification
// is pending. Twilio posts a flat form body and accepts TwiML back, so the
// reply rides the same HTTP response — no outbound call, no Twilio creds.
// Delete this block once the Meta webhook verifies.
router.post("/twilio-webhook", async (req: Request, res: Response) => {
  // The tunnel is public and these handlers write to the ledger and spend
  // Claude tokens, so verify Twilio's signature before trusting the body.
  // TWILIO_SKIP_SIGNATURE=1 disables that for a demo run — opt-in, never default.
  if (process.env.TWILIO_SKIP_SIGNATURE === "1") {
    console.warn("[twilio] SIGNATURE CHECK DISABLED — endpoint is unauthenticated");
  } else {
    const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
    const url = `https://${req.get("host")}${req.originalUrl}`;
    if (!authToken || !validateRequest(authToken, req.header("X-Twilio-Signature") ?? "", url, req.body ?? {})) {
      console.warn(`[twilio] REJECTED: bad or unverifiable signature for ${url}`);
      res.sendStatus(403);
      return;
    }
  }

  const from = String(req.body?.From ?? "unknown");
  const body = String(req.body?.Body ?? "");
  console.log(`[twilio] inbound from=${from} body=${JSON.stringify(body)}`);

  let reply: string;
  try {
    // AGENT_MODE=1 routes to the tool-using agent over duka-dynamic.db.
    // Unset, everything behaves exactly as before against duka.db.
    if (process.env.AGENT_MODE === "1") {
      const { runAgent } = await import("../agent/run");
      const { mediaFromBody, downloadMedia, isImage, isAudio } = await import("../agent/media");

      const media = mediaFromBody(req.body ?? {});
      const attachments = [];
      let audioCount = 0;

      for (const m of media) {
        if (isImage(m.contentType)) {
          const a = await downloadMedia(
            m.url,
            String(req.body?.AccountSid ?? ""),
            process.env.TWILIO_AUTH_TOKEN ?? ""
          );
          if (a) attachments.push(a);
        } else if (isAudio(m.contentType)) {
          audioCount++;
        }
      }
      if (media.length) {
        console.log(`[twilio] media: ${media.length} (${attachments.length} image, ${audioCount} audio)`);
      }

      // Voice notes need speech-to-text, which this stack has no provider for.
      // Saying so beats silently ignoring the message.
      if (audioCount > 0 && attachments.length === 0) {
        const note =
          "Bado siwezi kusikiliza voice note 🎙️ — niandikie kwa maandishi au tuma picha ya risiti/SMS ya M-Pesa.";
        res.type("text/xml").send(`<Response><Message>${note}</Message></Response>`);
        return;
      }

      reply = await runAgent(from, body, attachments);
      const escapedAgent = reply.replace(/[<>&]/g, (c) =>
        c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
      );
      res.type("text/xml").send(`<Response><Message>${escapedAgent}</Message></Response>`);
      return;
    }

    const r = await handleIncomingMessage({
      from,
      name: String(req.body?.ProfileName ?? "") || null,
      body,
      timestamp: "",
      type: "text",
    });
    reply = r.replyText;
  } catch (err) {
    console.error("[twilio] handling failed:", err);
    reply = "Samahani, kuna hitilafu. Jaribu tena.";
  }

  const escaped = reply.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
  );
  res.type("text/xml").send(`<Response><Message>${escaped}</Message></Response>`);
});

// Local test UI (GET /test, POST /test/message). Mounted here so index.ts
// needs no change — it already mounts this router.
router.use(testUiRouter);

export { handleWebhookPayload };
export default router;
