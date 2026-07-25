import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./duka.db",

  // WhatsApp via Meta Cloud API (test number). Replaced the Twilio sandbox —
  // see PROGRESS.md "Gotchas / decisions made" for the implications.
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? "",
  metaAccessToken: process.env.META_ACCESS_TOKEN ?? "",
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
  metaWabaId: process.env.META_WABA_ID ?? "",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};
