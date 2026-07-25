import { Router, Request, Response } from "express";
import { sendWhatsapp } from "./whatsapp-client";

const router = Router();

// Twilio WhatsApp sandbox inbound webhook. Routes each message to the right
// pillar handler based on simple intent. Pillars own the handler logic —
// this file only dispatches (README section 7: P0 owns router.ts).
router.post("/webhook", async (req: Request, res: Response) => {
  const from = req.body.From as string;
  const body = (req.body.Body as string) ?? "";

  try {
    const reply = await routeMessage(from, body);
    if (reply) await sendWhatsapp(from, reply);
  } catch (err) {
    console.error("webhook error:", err);
  }

  res.status(200).end();
});

async function routeMessage(from: string, body: string): Promise<string | null> {
  const text = body.trim().toLowerCase();

  if (text === "nataka report") {
    // TODO(P3): generate statement, return link/summary
    return "Report generation not wired up yet.";
  }

  // TODO(P1): detect forwarded M-Pesa SMS vs. free-text sale vs. cash entry
  // and dispatch to parse-mpesa-sms / parse-transaction accordingly.
  console.log(`[unrouted message] from=${from} body=${body}`);
  return null;
}

export default router;
