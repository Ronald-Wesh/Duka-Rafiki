import twilio from "twilio";
import { config } from "../core/config";

// Only initialise the real Twilio client when creds are present.
// During local testing (no .env) we fall through to the console logger below.
const hasTwilioCreds =
  config.twilioAccountSid && config.twilioAuthToken && config.twilioWhatsappFrom;

const client = hasTwilioCreds
  ? twilio(config.twilioAccountSid, config.twilioAuthToken)
  : null;

export async function sendWhatsapp(to: string, body: string): Promise<void> {
  if (client && hasTwilioCreds) {
    await client.messages.create({
      from: config.twilioWhatsappFrom,
      to,
      body,
    });
  } else {
    // Dev mode: no Twilio creds — print the reply so it's visible in the terminal.
    console.log(`\n[DEV REPLY → ${to}]\n${body}\n`);
  }
}
