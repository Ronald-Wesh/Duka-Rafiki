// Deterministic intent classification. No model call here on purpose: routing
// is a code decision, and a misroute on stage is worse than a slightly rigid
// keyword match. The model still does the actual language work downstream —
// pillars parse the message content once it's been routed.

export type Intent =
  | "mpesa_sms" // forwarded M-Pesa Buy Goods/Pochi confirmation
  | "day_close" // owner reporting their own total for the day
  | "deni" // credit given to / repaid by a named customer
  | "sale" // free-text cash or general sale entry
  | "report" // asking for the financial statement
  | "regulars" // asking who their repeat customers are
  | "help"
  | "unknown";

export interface Classification {
  intent: Intent;
  /** Which rule fired — logged so misroutes are debuggable without a redeploy. */
  reason: string;
  /**
   * True when the keyword match is strong enough to act on without asking the
   * model. False means "this is a guess" — the caller should let Claude decide,
   * so the bot understands intent instead of only recognising commands.
   */
  confident: boolean;
}

// A Ksh figure in any of the shapes traders and M-Pesa actually use.
const AMOUNT = /(?:ksh|kes|sh)\.?\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:bob|ksh|kes)\b|\b\d{2,}\b/i;

// M-Pesa confirmations are formulaic, which makes them the one thing we can
// detect with high confidence. Requiring an amount PLUS a marker keeps a
// trader's own "nimepata 500" from being mistaken for a forwarded SMS.
const MPESA_MARKERS = [
  /\bm-?pesa\b/i,
  /\bconfirmed\b/i,
  /\bumepokea\b/i,
  /you have received\b/i,
  /\bbuy\s*goods\b/i,
  /\bpochi\b/i,
  /new .*balance is\b/i,
];
// Transaction codes look like QK12ABC3DE — 10 alphanumerics, at least one digit.
const MPESA_TXN_CODE = /\b(?=[A-Z0-9]{10}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{10}\b/;

const DAY_CLOSE = /\b(funga|kufunga|fungua siku|closing|close(?:\s+day)?|jumla|total|leo nimepata|nimepata leo|siku imeisha)\b/i;
const DENI = /\b(deni|denni|anadai|nadai|amechukua|amekopa|kopa|credit|debt|owes?)\b/i;
const DENI_REPAYMENT = /\b(amelipa|alilipa|nimelipwa|repaid|amerudisha|kalipa)\b/i;
const REPORT = /\b(report|ripoti|statement|taarifa|hesabu za mwezi)\b/i;
const REGULARS = /\b(regulars?|wateja|customers?|top\s+\w*|wanunuzi)\b/i;
const HELP = /^\s*(help|msaada|hi|hello|hey|habari|niaje|sasa|mambo|start|menu)\b/i;

export function classifyIntent(rawText: string): Classification {
  const text = rawText.trim();

  if (!text) return { intent: "unknown", reason: "empty message", confident: true };

  const hasAmount = AMOUNT.test(text);

  // M-Pesa first — it's the highest-confidence match and the demo's key moment.
  const markerHits = MPESA_MARKERS.filter((m) => m.test(text)).length;
  const hasTxnCode = MPESA_TXN_CODE.test(text);
  if (hasAmount && (hasTxnCode || markerHits >= 1)) {
    // Deliberately never delegated to the model: an M-Pesa SMS misread as a
    // manual entry writes a wrong row into the ledger silently. The format is
    // formulaic, so keywords are both safer and faster here.
    return {
      intent: "mpesa_sms",
      reason: `mpesa: amount + ${markerHits} marker(s)${hasTxnCode ? " + txn code" : ""}`,
      confident: true,
    };
  }

  // Explicit asks before anything amount-shaped, so "nataka report" doesn't
  // get read as a sale just because it happens to contain a number.
  if (REPORT.test(text)) return { intent: "report", reason: "report keyword", confident: true };
  if (REGULARS.test(text)) return { intent: "regulars", reason: "regulars keyword", confident: true };

  if (DENI.test(text) || DENI_REPAYMENT.test(text)) {
    // Only a *record* is certain, and a record needs a figure. "who owes me
    // money?" / "nani anadai?" hit the same keywords but are questions — let
    // Claude separate recording a debt from asking about one.
    return {
      intent: "deni",
      reason: hasAmount ? "deni keyword + amount" : "deni keyword, no amount",
      confident: hasAmount,
    };
  }

  // Day close needs both a closing word and a figure — "funga" alone is
  // ambiguous, and a bare number is far more likely to be a sale.
  if (DAY_CLOSE.test(text) && hasAmount) {
    return { intent: "day_close", reason: "close keyword + amount", confident: true };
  }

  if (HELP.test(text)) return { intent: "help", reason: "greeting/help", confident: true };

  // An amount with no other signal is a plausible sale, but it could equally be
  // a day-close total or an answer to a question — let the model settle it.
  if (hasAmount) {
    return { intent: "sale", reason: "amount, no other signal", confident: false };
  }

  return { intent: "unknown", reason: "no amount, no keyword", confident: false };
}
