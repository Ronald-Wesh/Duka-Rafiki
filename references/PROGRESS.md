# P0 Progress Log

Last updated: 2026-07-26
Current status (one line): **Meta webhook verification PASSED**; credentials validated read-only; full inbound routing verified locally across 8 payload shapes — only the real phone-to-bot round trip is left, which needs a live tunnel + an allowlisted handset

## Done

- ✅ **1. Repo skeleton + db/schema.sql** — structure matches team spec section 7. Schema copied verbatim, no improvised columns.
- ✅ **2. db.ts** — better-sqlite3 connection + `initDb()` executing schema.sql.
- ✅ **3. types.ts** — `Transaction`, `Customer`, `ReconciliationResult`, `Statement`, plus `ParsedMpesaSms`, `TransactionType`, `Channel`.
- ✅ **4. claude-client.ts + /prompts structure** — `loadPrompt()` reads versioned files from `src/core/prompts/`; `askClaude()` / `askClaudeJson()` return text/JSON only, never a computed figure. Client hardened since: lazy init with a clear "key not set" error, `temperature: 0` default for extraction, `extractJson()` strips ```json fences, and a JSON parse failure reports what actually came back.
- ✅ **4b. All four prompt files written** — `parse-mpesa-sms.md`, `parse-transaction.md`, `draft-promo.md`, `phrase-summary.md`. P1 can now wire real parsing. `npm run check:prompts` (10 offline checks) + `npm run check:prompts:live` (needs an API key). `npm run check` runs all three suites — 40 checks, currently green.
- ✅ **Merged to main** — PR #1 (`platform-infra` → `main`), commit 8671176.
- ✅ **Install + boot verified** — `npm install`, `npm run seed` (rows confirmed in DB), and `npm run dev` → `/health` returns `{"ok":true}`. First time the scaffold has actually run; before this it was typecheck-only.
- ✅ **6. router.ts intent dispatch + fail-soft** — `intent.ts` classifies 8 intents deterministically (no model call — a misroute on stage is worse than a rigid match). Router dispatches to pillar handlers via `pillarCall()`, which degrades a not-yet-implemented pillar into an honest "haijahifadhiwa bado" notice instead of silence. Verified end to end against a live server: help / mpesa_sms / sale / report / unknown / media all route and reply correctly.
- ✅ **Routing regression harness** — `npm run check:intents`, 18 cases including three real-shaped M-Pesa formats. Currently 18/18.
- ✅ **whatsapp-client dry-run mode** — no credentials means it logs what it *would* send rather than throwing, so the router is testable before the transport exists.
- ✅ **5/7 (Meta version). Cloud API webhook transport** — `GET /webhook` does Meta's `hub.challenge` handshake against `META_VERIFY_TOKEN` (raw `text/plain` echo — a JSON-wrapped body fails verification); `POST /webhook` parses Meta's nested JSON defensively and acks with a bare 200 before any processing. Outbound via Graph API `v25.0`. Verified locally against fixture payloads: handshake 200 + echo, wrong/absent token 403, text message extracted, delivery-status callback ignored cleanly, `audio` type routed to the not-ready path, and empty/garbage payloads handled without throwing. Intent dispatch was left intact — it takes a string and is transport-agnostic.
- ✅ **8. Real seed data** — 28 days, ~600 transactions, 12 customers. Deterministic (fixed-seed PRNG, verified byte-identical across runs). Includes: quiet Sundays / market-day and payday peaks, 42% M-Pesa with real-format SMS bodies, Swahili/Sheng cash phrasing, deni with running per-customer balances, weekly wholesale restock sized to a realistic margin, 5 unclosed days and non-zero variances, and ~4% unconfirmed entries. `npm run check:seed` asserts 12 integrity properties.

## In progress

(nothing — next task not started)

## Next up

1. **Finish the Meta acceptance check** — needs real credentials and a public tunnel, so it can't be done unattended:
   - fill `META_*` in `.env`, start the tunnel, set the callback URL to `https://<tunnel>/webhook` with the same verify token, click **Verify and Save**
   - text the test number from an allowlisted phone and confirm the `[webhook] inbound message {...}` line appears
   - **add your own number to the test number's recipient allowlist first** — Meta test numbers only message pre-verified recipients, and messages to anyone else fail silently
2. **Run `npm run check:prompts:live`** once `ANTHROPIC_API_KEY` is in `.env`. **The prompts have never been run against the real model** — written and self-consistent, but unverified.
3. **Check whether the weekly regulars push needs a Meta template** (see Gotchas). This affects demo beat 3 and may need lead time for approval.
4. **9. demo-script.md** — the exact 3-minute conversation. Now writable, since the seed data it references exists.

## Shared contract changes (flag to team)

- Initial `types.ts` and `schema.sql` landed in PR #1. Schema is **unchanged** from the team spec — P1 owns any changes from here.
- Added `ParsedMpesaSms` to `types.ts` (`{amount, payer_name, till, timestamp}`) for P1's SMS parser. Not yet confirmed with P1. `till` is now `string | null` — Pochi messages frequently have no till.
- **New additive types for P1 to review**: `ParsedTransaction` (what `parse-transaction.md` returns) and `ParseError` + `isParseError()`. `ParsedTransaction` deliberately carries `customer_name` / `disambiguator` rather than a `customer_id` — the model can't know IDs, so the caller resolves the name against `customers`. It also carries `needs_review`, which maps to `transactions.confirmed = 0`. Additive only, nothing existing changed, and P1 should reshape it if it doesn't fit.
- **`askClaude` signature changed** from `(name, input, maxTokens)` to `(name, input, opts)`. Safe right now because no pillar calls it yet — but don't be surprised by it.
- Pillar stub files exist with contract signatures that `throw new Error("not implemented")` so cross-pillar imports typecheck before implementations land. Pillar owners replace the bodies on their own branches.

## Needs from other pillars

- **P1**: confirm `ParsedMpesaSms` is the shape you want, and whether `reconcileDay()` should return or persist (currently typed as returning `ReconciliationResult`).
- **P1**: the router calls `parseTransaction(body)` for both `sale` and `deni` intents and expects `Partial<Transaction>` back with at least `amount`. It does **not** tell you which intent fired — if you need that hint, ask and I'll pass it through.
- **P1**: `day_close` currently calls `reconcileDay(today)` but has no way to hand you the owner's *reported* total, which is the whole point of the close. Needs a signature that accepts it — flagged, not yet designed.
- **P2**: router calls `detectRepeatVisits(7)` and expects `number[]` of customer IDs.
- **P3**: router calls `computeStatementMetrics(start, end)` then `generateReport(...)`. The date range is today-to-today as a placeholder.
- **P1 — needs a decision, affects P3's numbers.** The seed defines a day's `expected_total` as **money in = sales + deni_repayment**, excluding `deni` (goods out, no cash) and `restock` (cash out). If `reconcileDay()` computes it differently, every variance in the seeded history is wrong and P3's reconciliation accuracy is meaningless. This needs agreeing, not assuming.
- **All**: seed data is ready — run `npm run db:reset && npm run check:seed` and sanity-check your pillar against it.

## Gotchas / decisions made

- ### Meta verification failure (2026-07-26) — root cause was the TUNNEL, not the handler
  Symptom: "The callback URL or verify token couldn't be validated" on **Verify and Save**.

  **The `GET /webhook` handler was never broken.** Proven by testing both layers separately with the real token from `.env`:

  | Test | Result |
  |---|---|
  | `localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=<real>&hub.challenge=X` | `200`, `text/plain`, body `X`, `match: true` ✅ |
  | Same query through the public ngrok URL | `200` but `text/html` — ngrok's own page, **and no entry in the server log at all** ❌ |

  Two faults, both outside the code:
  1. **The server wasn't running.** Nothing listening on port 3000, no node process.
  2. **No ngrok agent was running.** `ngrok.exe` is installed on Windows (winget) but no process and no agent API on `:4040`, in WSL or Windows. The URL returned `<title>Your new ngrok Cloud Endpoint!</title>` — a dashboard-created **Cloud Endpoint** with no local agent bound, serving a placeholder instead of forwarding to `localhost:3000`.

  **Why this specific error message is misleading:** Meta received `HTTP 200` — so the URL was reachable — but the body was ngrok's HTML rather than the challenge string. Meta reports that as a verify-token problem, which sends you hunting for a token mismatch that doesn't exist. **Always check what the tunnel returns before suspecting the token.** A one-line `curl` of the public URL distinguishes the two in seconds.

  **Env vars were fine throughout**: `META_VERIFY_TOKEN` set (`dukarafiki`), LF line endings, no stray quotes or whitespace, all four `META_*` present.

  **Resolved** — verification passed once a tunnel was actually bound. Debug instrumentation has been removed (it printed the verify token). The handler still logs `verification handshake OK` / `REJECTED (mode=..., tokenMatch=...)`, which is enough to diagnose without leaking the token.

- **ngrok: two installs, only one works.** The winget copy at `C:\Users\User\AppData\Local\Microsoft\WinGet\Packages\Ngrok.Ngrok_*\ngrok.exe` is **v3.3.1 and unauthenticated** — it rejects `--url` (too old, wants `--domain`) and fails with `ERR_NGROK_4018` on start. Use whichever install was authenticated when verification succeeded, and note the reserved domain must be bound with `--url` (newer agents) or `--domain` (older). **When no agent is bound, the reserved domain serves ngrok's "Your new ngrok Cloud Endpoint!" placeholder with HTTP 200** — which is what made Meta report a token error.

- **Meta credentials verified read-only** (2026-07-26), no messages sent:
  - Access token valid; `META_PHONE_NUMBER_ID` resolves to `+1 555-183-8457` "Test Number", `quality_rating: GREEN`, `platform_type: CLOUD_API`
  - WABA has that single test number, `code_verification_status: NOT_VERIFIED` (normal for a test number)
  - Approved templates include **`hello_world`** (UTILITY) plus Jasper's Market samples. Useful: `hello_world` can open a conversation outside the 24-hour window, though it can't carry custom content. A real weekly-regulars push would still need its own approved template.
  - Worth re-running this check before the demo — an expired token looks exactly like a broken webhook: `curl -s "https://graph.facebook.com/v25.0/$META_PHONE_NUMBER_ID?fields=display_phone_number" -H "Authorization: Bearer $META_ACCESS_TOKEN"`

- **Testing against live credentials: force dry-run.** With a real `META_ACCESS_TOKEN`, any inbound fixture triggers a genuine outbound send to whatever `from` number the payload carries — and the earlier fixtures used `254712345678`, a plausible real Kenyan number. Run local tests as `META_ACCESS_TOKEN="" npx ts-node src/index.ts` so replies are logged instead of sent.

- ### 🔴 SWITCHED FROM TWILIO TO META WHATSAPP CLOUD API (2026-07-26)
  **Tell the team — this contradicts the locked spec.** README §6 says "Twilio WhatsApp sandbox (chosen — faster to demo, no business verification). **Do not also build the Meta Cloud API path**", and SKILL.md lists "Twilio sandbox only. No Meta Cloud API path" under non-negotiables. Decision made by P0 (Person D) at the owner's direction; recorded here rather than left implicit. Twilio transport code has been **removed**, not left dual-wired.

  **If you assumed Twilio's payload shape, it has changed completely:**
  | | Twilio (old) | Meta (now) |
  |---|---|---|
  | Body format | `application/x-www-form-urlencoded` | JSON |
  | Sender | `req.body.From` = `whatsapp:+2547...` | `entry[0].changes[0].value.messages[0].from` = `2547...` (no `+`, no prefix) |
  | Text | `req.body.Body` | `...messages[0].text.body` |
  | Media | `NumMedia` / `MediaUrl0` | `messages[0].type` + `messages[0].audio.id` (media must be fetched from Graph) |
  | Sender name | not provided | `...value.contacts[0].profile.name` |
  | Reply | TwiML XML or REST | Graph API POST, always out-of-band |
  | Verification | none | `GET /webhook` `hub.challenge` handshake |

  **Env vars changed**: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` are gone, replaced by `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WABA_ID`. Re-copy `.env.example`.

- **Meta gotchas that can break the demo** — worth resolving early, not at hour 20:
  - **Test numbers only message an allowlist.** Add every demo phone to the recipient list in the dashboard first; sends to anyone else fail.
  - **The 24-hour window.** Free-form text is only allowed within 24h of the user's last message. A *business-initiated* message outside that window needs a **pre-approved template** — which is exactly what demo beat 3 (the weekly "your top regulars" push) is. `sendWhatsapp()` sends free-form text and does **not** handle templates. Either trigger that beat as a reply to an owner message, or get a template approved.
  - **The API Setup access token expires in 24 hours.** Fine for one demo night; use a System User token if it needs to outlive that. A dead token looks exactly like a broken webhook.
  - **Verification needs the raw challenge** as `text/plain`. Returning JSON or a quoted string fails "Verify and Save" with no useful error.
  - **Meta disables a webhook that is slow or errors repeatedly**, so `POST /webhook` acks 200 before doing anything. Don't make it synchronous.
  - **Not implemented: `X-Hub-Signature-256` verification.** The endpoint currently trusts any caller who knows the URL. Acceptable for a hackathon tunnel; would not be for production.

- **Run everything inside WSL on the Linux path** (`~/claude-hackathon/Duka-Rafiki`), never the UNC `\\wsl.localhost\...` path. Three separate failures come from getting this wrong: Windows `node-gyp` builds `better-sqlite3` into `C:\Windows` and hits `EPERM`; SQLite throws `database is locked` over the 9p boundary even single-process; Ubuntu's system Node is v18. Full writeup in `docs/setup.md`, pinned via `.nvmrc` (Node 20) + `engines`.
- **Windows' Node leaks onto the WSL `PATH`** — `node -v` can report v24 even after `nvm use`. Pin explicitly if behaviour looks wrong.
- **Tried and rejected `node:sqlite`** as a way to dodge the native build. It avoids `node-gyp` but still hits the 9p locking problem, and WSL's Node 18 doesn't have the module. Staying on `better-sqlite3`.
- **Watch the lockfile.** The `node:sqlite` detour left `package-lock.json` with zero `better-sqlite3` entries while `package.json` still required it — would have broken everyone's install. Regenerate with `npm install --package-lock-only` after any dependency change.
- `CLAUDE.md` was deliberately deleted upstream and its content folded into `README.md`. Don't re-add it.
- `.claude/` (local settings) is gitignored — don't commit it.
- **Webhook acks Twilio with 200 *before* processing.** Parsing takes seconds once the model is involved, and a slow 200 makes Twilio retry — which would double-log every transaction. Replies go out-of-band. Don't "tidy" this into a synchronous response.
- **Intent classification is deliberately not a model call.** Deterministic keywords are debuggable and instant; a model misroute during the demo is unrecoverable. The model still does all the actual parsing downstream.
- **M-Pesa detection needs an amount PLUS a marker** (`Confirmed`, `M-PESA`, `Umepokea`, txn code…). Amount alone isn't enough or the trader's own "nimepata 500" gets logged as a forwarded SMS — which corrupts the ledger silently rather than erroring. This is what `npm run check:intents` protects.
- **Seed data is deterministic on purpose** (fixed-seed mulberry32, `SEED = 20260726`). `Math.random()` would make the demo different every run and stop pillars from writing tests against known values. Changing `SEED` or `DAYS` changes every number downstream.
- **Three seed realism bugs that assertions did NOT catch** — found only by reading rows, worth remembering when extending it: (a) repayments initially exceeded credit given, so outstanding receivables went *negative*, which is meaningless on a lender-facing statement; (b) restock was too small, implying a 62% gross margin when a duka runs 10–20%; (c) the quantity multiplier contradicted catalogue phrasing, producing `mafuta 1L 960`. All three were plausible-looking numbers, not errors — exactly what a judge would notice. `npm run check:seed` now guards all three.
- **Prompts refuse rather than compute.** `soda mbili 50` returns an error instead of guessing 100, and `phrase-summary` won't turn "23 of 28 days" into "82%". Both would be *plausible* numbers with no ledger row behind them, which is exactly what breaks the "every figure is auditable" claim. If a pillar owner finds a prompt "unhelpfully strict", that strictness is the point — do the arithmetic in code.
- **The M-Pesa date trap:** Kenyan SMS dates are `D/M/YY`, so `3/7/26` is 3 July, not 7 March. Called out explicitly in the prompt and asserted in the live check. A silent month/day swap would scatter transactions across the wrong days and quietly wreck reconciliation.
- **`npm run check:prompts` scans the whole codebase for scoring vocabulary** (score / band / rating / creditworthy / risk level) outside comments, because README §13 makes that a product requirement. Verified it actually catches a violation rather than passing vacuously. Files that name the words in order to forbid them are exempt by filename — add to `EXEMPT` if you write another.
- **Considered and skipped: a `message_log` table** for auditing raw inbound messages. It's a schema change and P1 owns the schema, so it needs a team heads-up first rather than being slipped in. Currently everything is `console.log` only — fine for the demo, but there's no durable record of an unparsed message.

---

## Full checklist (for reference — copy each into "Done" as completed)

- [x]   1. Repo skeleton + schema.sql
- [x]   2. db.ts
- [x]   3. types.ts (Transaction, Customer, ReconciliationResult, Statement)
- [x]   4. claude-client.ts + /prompts structure — loader hardened, all 4 prompt files written (unverified against the live API)
- [~]   5. ~~Twilio sandbox~~ → **Meta Cloud API**: handshake + receipt built and verified against fixtures; real dashboard verification and a live inbound message still pending (needs credentials + tunnel)
- [x]   6. webhook/router.ts + whatsapp-client.ts — intent dispatch + fail-soft done; transport now Meta Cloud API (GET verify + POST receive, Graph API v25.0 outbound)
- [ ]   7. tunnel working + callback URL registered in the Meta dashboard
- [x]   8. demo/seed-data.ts (3-4 weeks, Swahili/Sheng) — 28 days, deterministic, 12 integrity checks
- [ ]   9. demo/demo-script.md — beats outlined, exact conversation not written
- [ ]   10. Pre-flight check (~2am): sandbox joined, tunnel up, fresh-clone seed test

## Not in the original checklist, but needed

- **Voice notes.** Team spec §3 lists voice as a *primary* input. The router now detects a non-text message type and replies honestly, but nothing transcribes it. On Meta this is a two-step fetch: `GET /{media-id}` for a short-lived URL, then download it with the bearer token — more work than Twilio's single `MediaUrl0`. Unscoped; raise with the team whether it's in for the demo or text-only.
- **Leftover: `src/index.ts:9` still mounts `express.urlencoded`**, which was only there for Twilio's form bodies. Harmless (`express.json()` handles Meta), but it's a one-line removal and misleading to leave. Not touched because `src/index.ts` is outside the `/src/webhook` + `/src/core` scope this task was limited to. Same for the now-unused `twilio` dependency in `package.json`.
- ✅ **Fail-soft webhook** — done as part of task 6.
- **Day-close reported total** has nowhere to go (see "Needs from other pillars"). This blocks the reconciliation demo beat, so it needs resolving with P1 early rather than at hour 20.
