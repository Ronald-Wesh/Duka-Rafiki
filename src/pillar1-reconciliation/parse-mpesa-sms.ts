import { ParsedMpesaSms } from "../core/types";

// P1 owns this. Parses a forwarded M-Pesa Buy Goods/Pochi SMS into
// {amount, payer_name, till, timestamp} via askClaude("parse-mpesa-sms", ...).
export async function parseMpesaSms(_smsText: string): Promise<ParsedMpesaSms> {
  throw new Error("not implemented — P1");
}
