import twilio from "twilio";
import { config } from "../core/config";

const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

export async function sendWhatsapp(to: string, body: string): Promise<void> {
  await client.messages.create({
    from: config.twilioWhatsappFrom,
    to,
    body,
  });
}
