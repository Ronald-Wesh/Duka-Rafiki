import dotenv from "dotenv";

// override: a key exported in someone's shell profile silently beats .env
// otherwise, and the app falls back to a dead key with no visible error.
// The project's .env is the source of truth for everyone on the team.
dotenv.config({ override: true });

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
  // Public origin the WhatsApp statement link points at — the ngrok URL on demo night.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ""),
};
