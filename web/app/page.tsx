"use client";

import { useEffect, useRef, useState } from "react";

type Msg = {
  who: "me" | "bot";
  text: string;
  intent?: string;
  lang?: "en" | "sw";
  usedClaude?: boolean;
  ms?: number;
  pending?: boolean;
};

/** Samples in both languages — the same intent should work either way. */
const SAMPLES: Array<{ flag: string; label: string; text: string }> = [
  { flag: "🇰🇪", label: "salamu", text: "habari" },
  { flag: "🇬🇧", label: "greeting", text: "hello" },
  { flag: "🇰🇪", label: "mauzo", text: "unga 2kg 180 cash" },
  { flag: "🇬🇧", label: "cash sale", text: "I sold milk for 60" },
  { flag: "🇰🇪", label: "deni", text: "Mary amechukua sukari 200 deni" },
  { flag: "🇬🇧", label: "credit", text: "Mary took sugar for 200 on credit" },
  { flag: "🇰🇪", label: "funga siku", text: "funga leo 3500" },
  { flag: "🇬🇧", label: "close day", text: "close today 3500" },
  { flag: "🇰🇪", label: "wateja", text: "nionyeshe wateja wangu" },
  { flag: "🇬🇧", label: "regulars", text: "show me my regulars" },
  { flag: "🇰🇪", label: "ripoti", text: "nataka report" },
  { flag: "🇬🇧", label: "report", text: "I want a report" },
  {
    flag: "💬",
    label: "M-Pesa SMS",
    text: "QK12ABC3DE Confirmed. You have received Ksh500.00 from JOHN KAMAU 254712345678 on 3/7/26 at 10:15 AM. New M-PESA balance is Ksh12,300.00",
  },
];

export default function Page() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [who, setWho] = useState("Mama Njeri (test)");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [msgs]);

  async function send(body: string) {
    const trimmed = body.trim();
    if (!trimmed || busy) return;

    setMsgs((m) => [
      ...m,
      { who: "me", text: trimmed },
      { who: "bot", text: "", pending: true },
    ]);
    setText("");
    setBusy(true);

    try {
      const r = await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed, name: who }),
      });
      const d = await r.json();
      setMsgs((m) => {
        const next = [...m];
        next[next.length - 1] = {
          who: "bot",
          text: d.replyText || "(empty reply)",
          intent: d.intent,
          lang: d.lang,
          usedClaude: d.usedClaude,
          ms: d.ms,
        };
        return next;
      });
    } catch (err) {
      setMsgs((m) => {
        const next = [...m];
        next[next.length - 1] = {
          who: "bot",
          text: `Request failed: ${err instanceof Error ? err.message : err}`,
        };
        return next;
      });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <main className="shell">
      <header className="top">
        <div className="mark">DL</div>
        <div>
          <div className="title">Duka Ledger</div>
          <div className="sub">
            test console · same handler as WhatsApp · no Meta, no ngrok
          </div>
        </div>
        <div className="spacer" />
        <input
          className="who"
          value={who}
          onChange={(e) => setWho(e.target.value)}
          aria-label="Sender name"
          title="Sender name — used by the deni (credit) logic"
        />
      </header>

      <div className="log" ref={logRef}>
        {msgs.length === 0 && (
          <p className="hint">
            Andika kwa Kiswahili au English — the bot detects the language and
            replies in the same one.
            <br />
            Tap a sample below to try it.
          </p>
        )}

        {msgs.map((m, i) => (
          <div className={`row ${m.who}`} key={i}>
            <div className="bubble">
              {m.pending ? (
                <span className="dots">
                  <span>•</span>
                  <span>•</span>
                  <span>•</span>
                </span>
              ) : (
                m.text
              )}
            </div>

            {m.who === "bot" && !m.pending && (
              <div className="tags">
                {m.usedClaude && <span className="tag claude">Claude</span>}
                {m.lang && (
                  <span className="tag lang">
                    {m.lang === "sw" ? "Kiswahili" : "English"}
                  </span>
                )}
                {m.intent && <span className="tag">{m.intent}</span>}
                {typeof m.ms === "number" && (
                  <span className="tag">{m.ms} ms</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="chips">
        {SAMPLES.map((s) => (
          <button
            key={s.label}
            className="chip"
            type="button"
            title={s.text}
            onClick={() => send(s.text)}
          >
            <span className="flag">{s.flag}</span>
            {s.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input
          ref={inputRef}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Andika ujumbe… / Type a message…"
          autoFocus
        />
        <button className="send" type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
