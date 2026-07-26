import { NextResponse } from "next/server";

/**
 * Server-side proxy to the Express bot.
 *
 * Going through the server avoids CORS and keeps the bot's port out of the
 * browser. The bot owns the DB, the pillars and the Anthropic calls — this
 * route only forwards, so there is no second copy of any logic to drift.
 */

const BOT = process.env.BOT_API_BASE ?? "http://localhost:3000";

export async function POST(req: Request) {
  let payload: { body?: string; name?: string; from?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const r = await fetch(`${BOT}/test/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: payload.from ?? "test-user-1",
        name: payload.name ?? "Mama Njeri (test)",
        body: payload.body ?? "",
      }),
      cache: "no-store",
    });

    const data = await r.json().catch(() => ({}));
    return NextResponse.json({ ...data, ms: Date.now() - started });
  } catch (err) {
    // Nearly always "the Express bot isn't running" — say so plainly rather
    // than surfacing a bare fetch failure.
    return NextResponse.json(
      {
        replyText: `Can't reach the bot at ${BOT}.\n\nStart it first:\n  cd ~/claude-hackathon/Duka-Rafiki\n  nvm use && npm run dev`,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      },
      { status: 502 }
    );
  }
}
