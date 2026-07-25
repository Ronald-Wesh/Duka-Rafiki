# AI Mashinani — Duka Ledger

WhatsApp-based transaction-record tool for cash-based micro-traders. A shopkeeper
captures their business — by photo of an existing paper ledger, or by voice/text
in English/Swahili/Sheng — and the tool turns it into a confirmed, structured
record they own, then compiles it into a lender-readable financial statement.
Not a POS. Not an app to download. It lives where the trader already is: WhatsApp.

**Beneficiary (locked):** This helps a cash-based micro-trader — one of the 7.4
million MSMEs that make up 98% of Kenyan businesses — who today has no financial
statement to show a lender, because their entire business exists only in memory
and loose cash.

AI strategy: orchestrate existing hosted models (Claude for vision + language) —
no custom model training. The model does language and extraction; all arithmetic
and records are deterministic code.

## Scope

### Core — must work live

* **Input channels** — WhatsApp (Twilio Sandbox), two entry paths:
  * *Paper capture* — photo of an existing handwritten ledger page (backfill / onboarding).
  * *Voice/text* — day-to-day new entries going forward; English/Swahili/Sheng code-switched.
* **Paper ledger extraction** — Claude vision reads the photographed page into a
  structured table (date, item, qty, price).
* **Per-line confidence flagging** — each extracted line gets its own confidence
  flag, not the whole page. Ambiguous digits, local shorthand ("50/-", "2 mnd"),
  faded/overlapping entries are flagged individually.
* **Verification loop** — the bot returns the clean digital version with flagged
  lines clearly marked; the owner replies in plain language to correct only the
  flagged lines (e.g. "line 3 is 56").
* **Unconfirmed-entry rule** — entries never confirmed by the owner are excluded
  from the statement, or explicitly marked "self-reported, unconfirmed." Never
  silently treated as verified.
* **Day-to-day logging** — voice note or text for new sales: item, quantity,
  price, running stock deduction.
* **Debt tracking by name** — tag a sale as "on credit" to a named customer (not
  phone number); simple disambiguator field for duplicate names (e.g. "Mary - blue uniform").
* **Daily plain-language summary** — what sold, what didn't, today's estimated
  profit/margin by product. Computable from one day, no history needed.
* **Remaining stock view** — live checklist updated after each confirmed sale.

### Secondary — this hackathon's differentiator (early version of the long-term product)

* **Financial statement generator** — compiles confirmed transactions (paper
  backfill + logged days) into a lender-readable document: sales volume, estimated
  margin, day-to-day cash-flow consistency, outstanding debts owed (receivables),
  stock movement.
* **Explicit statement labeling** — date range covered, clearly marked as a
  transaction record. Never "credit score" or "creditworthiness rating," anywhere
  in product or pitch.
* **Live demo on real data** — paper backfill + a few hours of event-logged
  entries, no synthetic history. Honesty about the limited data range is the
  strength, not a weakness to hide.

### Explicitly cut from tonight (state this out loud if asked)

* Photo capture of loose products for general inventory (as opposed to reading a
  paper ledger) — too much open-ended recognition risk.
* Any numeric credit score or risk rating — not our call as a non-financial-service-provider.
* Customer tracking beyond the debt/credit use case — no general CRM or
  purchase-history analytics.

### Long-term roadmap (where statement generation becomes primary)

* Accumulated statements mature from "a few days of receipts" into genuine,
  portable credit-history documentation the trader owns — not gatekept by one lender.
* Partnership model, not lending model: plug the statement output into existing
  microfinance / chama / SACCO underwriting rather than becoming a scorer ourselves.
* Loose-product photo inventory revisited once there's time to validate it properly.
* Broader customer-relationship data once there's a real, consent-based way to collect it.

## Architecture principle

The model does **language** (parse voice/text, extract handwriting, phrase
summaries). All **arithmetic and records** are deterministic code — running
totals, margins, received-vs-paid balances, the statement figures. The model is
never asked to compute a number that appears in the statement; it is handed
computed numbers and asked only to phrase them. This keeps every figure on stage
correct and auditable.

## Stack

* **Twilio Sandbox for WhatsApp** — input/output channel (voice, image, text).
* **Claude API** — vision (ledger extraction) + language (parsing, phrasing). Credits provided on the night.
* **Backend** — webhook receiver → parse/extract → confirm loop → ledger store.
* **Ledger store** — structured transaction records (local/lightweight DB).
* **Statement output** — lender-readable document from confirmed transactions.

## Getting Started

1. Join the Twilio WhatsApp sandbox

   From the demo phone, send the sandbox join code to the Twilio sandbox number.
   Do this BEFORE the demo — the phone must already be joined.

2. Expose the webhook

   Run the backend locally and tunnel it to a stable public URL (e.g. ngrok), then
   set that URL as the Twilio WhatsApp inbound webhook. Keep the tunnel up through
   the demo — pre-flight it well before stage time, not at 3:25 am.

3. Configure environment

   ```
   cp .env.example .env.local
   ```

   ```
   ANTHROPIC_API_KEY=...
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   ```

   `.env.local` is gitignored — never commit real keys.

## Team (4)

Suggested split — one owner each:

1. **Twilio + input parse** — webhook, media handling, voice/text → structured entry.
2. **Confirm-and-commit UX** — the render-back + per-line flag + correction loop.
3. **Ledger + deterministic math** — running totals, received-vs-paid, margins, stock.
4. **Statement generator + phrasing** — lender-readable output + Swahili/English summaries.

## Demo discipline

* Pre-test the ONE ledger photo you demo with at ~2 am; know exactly which lines flag.
* The photographed ledger page IS your history — it must contain a real
  received-vs-paid gap for a named customer, so the summary has something to expose.
* One live input on stage (a single voice note) fires against the confirmed backfill.
* Write an eval set (messy-ledger lines + received-vs-paid math with known correct
  answers) BEFORE building, so at 3 am you can verify correctness instead of hoping.