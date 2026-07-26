import { config } from "../core/config";

// Outbound messages via Meta's WhatsApp Cloud API (Graph API).
// Kept deliberately separate from the webhook route handlers: this is for
// later features (weekly regulars summary, report delivery), not for the
// inbound path, which only needs to ack with a bare 200.

const GRAPH_VERSION = "v25.0";

export function isConfigured(): boolean {
  return Boolean(config.metaAccessToken && config.metaPhoneNumberId);
}

/**
 * Meta expects a bare international number — `254712345678`, no `+` and no
 * `whatsapp:` prefix (that was Twilio's convention). Inbound `messages[0].from`
 * already arrives in this shape; this just guards against a caller passing the
 * old style.
 */
function normalizeRecipient(to: string): string {
  return to.replace(/^whatsapp:/i, "").replace(/^\+/, "").trim();
}

/**
 * Sends a plain text WhatsApp message.
 *
 * Note for proactive sends (weekly summary, report ready): Meta only allows
 * free-form text inside the 24-hour customer-service window that opens when the
 * user last messaged us. Outside it, a business-initiated message must use a
 * pre-approved template, which this function does NOT do. Replying to an
 * incoming message is always fine.
 */
export async function sendWhatsapp(to: string, body: string): Promise<void> {
  // No credentials — print what would have been sent, so local dev and the
  // check harnesses work without burning test-number messages.
  if (!isConfigured()) {
    console.log(`[whatsapp:dry-run] -> ${to}\n${body}\n`);
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${config.metaPhoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.metaAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeRecipient(to),
      type: "text",
      text: { preview_url: false, body },
    }),
  });

  if (!response.ok) {
    // Meta returns a descriptive JSON error — surface it, since "send failed"
    // alone is undebuggable at 3am.
    const detail = await response.text().catch(() => "<unreadable body>");
    throw new Error(`Meta send failed (${response.status}): ${detail}`);
  }
}
