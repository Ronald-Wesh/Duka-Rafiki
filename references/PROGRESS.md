# P0 Progress Log

Last updated: 2026-07-26
Current status (one line): scaffold merged to main and verified running end to end locally — Twilio/ngrok not yet wired, router still a stub

## Done

- ✅ **1. Repo skeleton + db/schema.sql** — structure matches team spec section 7. Schema copied verbatim, no improvised columns.
- ✅ **2. db.ts** — better-sqlite3 connection + `initDb()` executing schema.sql.
- ✅ **3. types.ts** — `Transaction`, `Customer`, `ReconciliationResult`, `Statement`, plus `ParsedMpesaSms`, `TransactionType`, `Channel`.
- ✅ **4. claude-client.ts + /prompts structure** — `loadPrompt()` reads versioned files from `src/core/prompts/`; `askClaude()` / `askClaudeJson()` return text/JSON only, never a computed figure. **Prompt files themselves not written yet** — only the loader and the directory README.
- ✅ **Merged to main** — PR #1 (`platform-infra` → `main`), commit 8671176.
- ✅ **Install + boot verified** — `npm install`, `npm run seed` (rows confirmed in DB), and `npm run dev` → `/health` returns `{"ok":true}`. First time the scaffold has actually run; before this it was typecheck-only.

## In progress

(nothing — next task not started)

## Next up

1. **5 + 7. Twilio sandbox + ngrok** — the first hard external dependency. Join the demo phone, point the sandbox webhook at the tunnel, prove a real WhatsApp round trip.
2. **6. router.ts intent dispatch** — currently only matches `"nataka report"` and logs everything else.
3. **4 (finish). Write the actual prompt files** — `parse-mpesa-sms.md`, `parse-transaction.md`, `draft-promo.md`.

## Shared contract changes (flag to team)

- Initial `types.ts` and `schema.sql` landed in PR #1. Schema is **unchanged** from the team spec — P1 owns any changes from here.
- Added `ParsedMpesaSms` to `types.ts` (`{amount, payer_name, till, timestamp}`) for P1's SMS parser. Not yet confirmed with P1.
- Pillar stub files exist with contract signatures that `throw new Error("not implemented")` so cross-pillar imports typecheck before implementations land. Pillar owners replace the bodies on their own branches.

## Needs from other pillars

- **P1**: confirm `ParsedMpesaSms` is the shape you want, and whether `reconcileDay()` should return or persist (currently typed as returning `ReconciliationResult`).
- **All**: nobody has run their pillar against the seed data yet — it's still a 2-row smoke seed, not the 3–4 weeks the demo needs (task 8).

## Gotchas / decisions made

- **Run everything inside WSL on the Linux path** (`~/claude-hackathon/Duka-Rafiki`), never the UNC `\\wsl.localhost\...` path. Three separate failures come from getting this wrong: Windows `node-gyp` builds `better-sqlite3` into `C:\Windows` and hits `EPERM`; SQLite throws `database is locked` over the 9p boundary even single-process; Ubuntu's system Node is v18. Full writeup in `docs/setup.md`, pinned via `.nvmrc` (Node 20) + `engines`.
- **Windows' Node leaks onto the WSL `PATH`** — `node -v` can report v24 even after `nvm use`. Pin explicitly if behaviour looks wrong.
- **Tried and rejected `node:sqlite`** as a way to dodge the native build. It avoids `node-gyp` but still hits the 9p locking problem, and WSL's Node 18 doesn't have the module. Staying on `better-sqlite3`.
- **Watch the lockfile.** The `node:sqlite` detour left `package-lock.json` with zero `better-sqlite3` entries while `package.json` still required it — would have broken everyone's install. Regenerate with `npm install --package-lock-only` after any dependency change.
- `CLAUDE.md` was deliberately deleted upstream and its content folded into `README.md`. Don't re-add it.
- `.claude/` (local settings) is gitignored — don't commit it.

---

## Full checklist (for reference — copy each into "Done" as completed)

- [x]   1. Repo skeleton + schema.sql
- [x]   2. db.ts
- [x]   3. types.ts (Transaction, Customer, ReconciliationResult, Statement)
- [~]   4. claude-client.ts + /prompts structure — loader done, prompt files not written
- [ ]   5. Twilio WhatsApp sandbox joined + tested
- [~]   6. webhook/router.ts + whatsapp-client.ts — files exist, dispatch logic is a stub
- [ ]   7. ngrok tunnel working + documented in .env.example
- [ ]   8. demo/seed-data.ts (3-4 weeks, Swahili/Sheng) — currently a 2-row smoke seed
- [ ]   9. demo/demo-script.md — beats outlined, exact conversation not written
- [ ]   10. Pre-flight check (~2am): sandbox joined, tunnel up, fresh-clone seed test

## Not in the original checklist, but needed

- **Voice notes.** Team spec section 3 lists voice as a *primary* input, but the webhook only reads `req.body.Body`. Twilio delivers audio as `MediaUrl0` — needs download + transcription. Unscoped work; raise with the team whether it's in for the demo or text-only.
- **Fail-soft webhook.** A bad parse must not leave the owner in silence on stage.
