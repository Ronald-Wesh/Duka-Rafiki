import { Router, Request, Response } from "express";
import { sendWhatsapp } from "./whatsapp-client";
import { parseMpesaSms } from "../pillar1-reconciliation/parse-mpesa-sms";
import { parseTransaction } from "../pillar1-reconciliation/parse-transaction";
import { reconcileToday } from "../pillar1-reconciliation/reconcile";

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

// ---------------------------------------------------------------------------
// Heuristics for detecting message intent
// ---------------------------------------------------------------------------

/** Detects a forwarded M-Pesa Buy Goods or Pochi la Biashara confirmation SMS. */
function isMpesaSms(text: string): boolean {
  // M-Pesa confirmations always contain "Confirmed" and either
  // "received from" or "Buy Goods" or "Pochi".
  const lower = text.toLowerCase();
  return (
    lower.includes("confirmed") &&
    (lower.includes("received from") ||
      lower.includes("buy goods") ||
      lower.includes("pochi"))
  );
}

/** Detects a day-close reconciliation message.
 *  Owner sends something like: "leo 4500" / "reconcile 4500" / "total 4500" */
function parseReconcileIntent(text: string): number | null {
  const lower = text.trim().toLowerCase();
  // Patterns: "leo <amount>", "total <amount>", "reconcile <amount>",
  //           "kufunga <amount>", "closing <amount>"
  const match = lower.match(
    /^(?:leo|total|reconcile|kufunga|closing)[^\d]*(\d[\d,]*(?:\.\d+)?)$/
  );
  if (match) {
    return parseFloat(match[1].replace(/,/g, ""));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

async function routeMessage(from: string, body: string): Promise<string | null> {
  const text = body.trim();
  const lower = text.toLowerCase();

  // --- P3: financial statement ---
  if (lower === "nataka report" || lower === "report" || lower === "statement") {
    // TODO(P3): generate statement, return link/summary
    return "Report generation not wired up yet.";
  }

  // --- P1: forwarded M-Pesa SMS ---
  if (isMpesaSms(text)) {
    try {
      const parsed = await parseMpesaSms(text);
      return (
        `✅ M-Pesa logged!\n` +
        `👤 ${parsed.payer_name}\n` +
        `💰 KES ${parsed.amount.toLocaleString()}\n` +
        `🏪 Till: ${parsed.till}\n` +
        `🕐 ${parsed.timestamp}\n\n` +
        `Imethibitishwa na kuhifadhiwa. ✔`
      );
    } catch (err) {
      console.error("[P1] parseMpesaSms error:", err);
      return "Sikuweza kusoma SMS ya M-Pesa. Tuma tena au andika manually.";
    }
  }

  // --- P1: day-close reconciliation ---
  const reportedTotal = parseReconcileIntent(text);
  if (reportedTotal !== null) {
    try {
      const result = reconcileToday(reportedTotal);
      const varianceLabel =
        result.variance === 0
          ? "✅ Hesabu inafanana!"
          : result.variance > 0
          ? `⚠️ Tofauti: +KES ${result.variance.toFixed(2)} (ulisema zaidi)`
          : `⚠️ Tofauti: KES ${Math.abs(result.variance).toFixed(2)} (ilitakiwa zaidi)`;

      return (
        `📊 *Muhtasari wa Leo (${result.date})*\n` +
        `Iliyorekodiwa:  KES ${result.expected_total.toLocaleString()}\n` +
        `Uliripoti:       KES ${result.reported_total.toLocaleString()}\n` +
        `${varianceLabel}\n\n` +
        `📝 ${result.notes}`
      );
    } catch (err) {
      console.error("[P1] reconcileToday error:", err);
      return "Hitilafu katika kufanya reconciliation. Jaribu tena.";
    }
  }

  // --- P1: free-text / voice sale entry ---
  // Any message that isn't a known command falls here — treat as a transaction entry.
  try {
    const tx = await parseTransaction(text);

    if (!tx.amount) {
      // Claude couldn't extract an amount — ask the owner to clarify.
      return (
        `Nimeelewa: ${tx.type ?? "sale"}` +
        (tx.customer_id ? ` (kwa mteja)` : "") +
        `.\n\nBado sijapata *kiasi*. Tafadhali niambie bei, e.g. "150 bob".`
      );
    }

    const typeLabel: Record<string, string> = {
      sale: "Mauzo",
      deni: "Deni (mikopo)",
      deni_repayment: "Malipo ya deni",
      restock: "Stoku mpya",
    };

    return (
      `📝 Imehifadhiwa (haijakuwa confirmed bado):\n` +
      `📦 Aina: ${typeLabel[tx.type ?? "sale"] ?? tx.type}\n` +
      `💰 KES ${tx.amount?.toLocaleString()}\n` +
      `💳 Njia: ${tx.channel ?? "haijulikani"}\n\n` +
      `Jibu *ndiyo* kuthibitisha, au *hapana* kufuta.`
    );
  } catch (err) {
    console.error("[P1] parseTransaction error:", err);
    console.log(`[unrouted message] from=${from} body=${body}`);
    return null;
  }
}

export default router;
