import twilio, { Twilio } from "twilio";
import { config } from "../core/config";

// Built lazily: the Twilio constructor throws on an empty/invalid SID, and we
// want the app to boot without credentials so the router can be exercised
// before the sandbox is wired up.
let client: Twilio | null = null;

function getClient(): Twilio | null {
  if (!config.twilioAccountSid || !config.twilioAuthToken) return null;
  if (!client) client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  return client;
}

export function isConfigured(): boolean {
  return getClient() !== null && Boolean(config.twilioWhatsappFrom);
}

export async function sendWhatsapp(to: string, body: string): Promise<void> {
  const c = getClient();

  // No credentials — print what would have been sent. Keeps local dev and the
  // intent harness usable without burning sandbox messages.
  if (!c || !config.twilioWhatsappFrom) {
    console.log(`[whatsapp:dry-run] -> ${to}\n${body}\n`);
    return;
  }

  await c.messages.create({ from: config.twilioWhatsappFrom, to, body });
}
