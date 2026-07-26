# Running it, and deploying the console

## One command

```bash
npm install     # also installs web/ via postinstall
npm run dev     # bot on :3000 AND Next console on :3001, one terminal
```

`npm run build` builds both (`tsc` for the bot, `next build` for the console).
`npm start` runs both from the built output. Need them apart? `npm run dev:bot`
and `npm run dev:web` still exist.

Run everything inside WSL on the Linux path, on Node 20 (`nvm use`) — see
`setup.md` for why.

## Deploying to Vercel — read this first

**Only the Next console deploys. The bot does not, and this is not a config
problem.**

The ledger is a local SQLite file that every pillar reads *and writes*
synchronously through `better-sqlite3`. Vercel's serverless filesystem is
read-only apart from `/tmp`, which is per-instance and wiped on cold starts. A
bot deployed there would lose every sale the moment the instance recycled, so
the deployment is deliberately UI-only:

```
Vercel (Next console)  ──HTTP──▶  your machine: Express bot + SQLite + Meta webhook
```

`vercel.json` at the repo root already points Vercel at `web/`, so no dashboard
Root Directory change is needed:

- **Install** `npm --prefix web install`
- **Build** `npm --prefix web run build`
- **Output** `web/.next`

The root install is skipped on purpose — the console needs none of the bot's
dependencies, and building `better-sqlite3` on Vercel would be a slow way to
produce something unusable.

### The one env var that matters

Set **`BOT_API_BASE`** in the Vercel project to a URL where your bot is actually
reachable — the ngrok tunnel, not `localhost`, which on Vercel means Vercel:

```
BOT_API_BASE = https://<your-tunnel>.ngrok-free.app
```

Without it the console loads fine and every message returns "Can't reach the
bot", which is the failure mode to expect if you forget.

### Making the bot durable later

If the bot itself ever needs to be hosted, the blocker is the synchronous
SQLite access, not the hosting. Turso/libSQL speaks the same dialect but its
client is async, so every `db.prepare(...).all()` across P1, P2 and P3 would
have to become `await`. That is a real refactor across all three pillar
folders — not a deployment setting.
