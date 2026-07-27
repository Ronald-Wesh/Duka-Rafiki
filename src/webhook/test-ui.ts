import { Router, Request, Response } from "express";
import { handleIncomingMessage } from "./handle-message";

/**
 * Local test harness — a fake WhatsApp client in the browser.
 *
 * Exists because Meta's test tier may not deliver webhooks to testers until the
 * app is published/verified. This route calls handleIncomingMessage() directly,
 * so every pillar's logic can be exercised tonight with no Meta, no ngrok, no
 * Graph API and no real handset. It deliberately does NOT touch
 * whatsapp-client.ts: the reply comes back in the HTTP response instead of
 * being sent outbound.
 *
 * The page is inlined rather than served from a .html file because `tsc` does
 * not copy non-TS assets into dist/, so a separate file would work under
 * ts-node and 404 after `npm run build`.
 */

const router = Router();

router.post("/test/message", async (req: Request, res: Response) => {
  const from = String(req.body?.from ?? "test-user-1");
  const name = req.body?.name ? String(req.body.name) : "Mama Njeri (test)";
  const body = String(req.body?.body ?? "");

  try {
    // Pass the whole result through: intent / lang / usedClaude let the console
    // show a misroute or a wrong reply language without tailing server logs.
    const result = await handleIncomingMessage({
      from,
      name,
      body,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "text",
    });
    res.json(result);
  } catch (err) {
    // The real webhook swallows errors; here we surface them, because the whole
    // point of this page is diagnosing pillar logic.
    console.error("[test-ui] handler threw:", err);
    res.status(500).json({
      replyText: `[test harness] handler threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
});

router.get("/test", (_req: Request, res: Response) => {
  res.type("html").send(PAGE);
});

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Duka Ledger — local test</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #ece5dd; color: #111;
  }
  header {
    background: #075e54; color: #fff; padding: .7rem 1rem;
    display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
  }
  header strong { font-weight: 600; }
  header .hint { font-size: .78rem; opacity: .85; }
  header input {
    font: inherit; font-size: .85rem; padding: .25rem .5rem;
    border: 0; border-radius: 4px; min-width: 15rem;
  }
  #log { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: .5rem; }
  .row { display: flex; }
  .row.me { justify-content: flex-end; }
  .bubble {
    max-width: min(80%, 34rem); padding: .5rem .7rem; border-radius: .6rem;
    white-space: pre-wrap; word-wrap: break-word;
    box-shadow: 0 1px 1px rgba(0,0,0,.12);
  }
  .me .bubble  { background: #dcf8c6; border-bottom-right-radius: 2px; }
  .bot .bubble { background: #fff;    border-bottom-left-radius: 2px; }
  .bubble a { color: #075e54; }
  .meta { font-size: .68rem; opacity: .5; margin-top: .25rem; }
  .sys { align-self: center; font-size: .75rem; opacity: .6; padding: .2rem .6rem; }
  form { display: flex; gap: .5rem; padding: .6rem; background: #f0f0f0; }
  #body { flex: 1; font: inherit; padding: .6rem .75rem; border: 1px solid #ccc; border-radius: 1.4rem; }
  button { font: inherit; padding: .6rem 1.1rem; border: 0; border-radius: 1.4rem;
           background: #075e54; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #presets { display: flex; gap: .35rem; flex-wrap: wrap; padding: 0 .6rem .6rem; background: #f0f0f0; }
  #presets button { background: #fff; color: #075e54; border: 1px solid #cfcfcf;
                    border-radius: 1rem; padding: .25rem .6rem; font-size: .78rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1418; color: #e9edef; }
    .bot .bubble { background: #202c33; }
    .me .bubble  { background: #005c4b; color: #e9edef; }
    form, #presets { background: #111b21; }
    #body { background: #2a3942; color: #e9edef; border-color: #2a3942; }
    #presets button { background: #202c33; color: #d1d7db; border-color: #2a3942; }
  }
</style>
</head>
<body>
<header>
  <strong>Duka Ledger — local test</strong>
  <span class="hint">calls the same handler as the real webhook · no Meta, no ngrok</span>
  <label class="hint">sender
    <input id="name" value="Mama Njeri (test)" />
  </label>
</header>

<div id="log">
  <div class="sys">Type a message, or pick a sample below. Detected intent is logged to the server console.</div>
</div>

<div id="presets"></div>

<form id="f" autocomplete="off">
  <input id="body" placeholder="Andika ujumbe…" autofocus />
  <button id="send" type="submit">Send</button>
</form>

<script>
  var SAMPLES = [
    ["habari", "greeting"],
    ["unga 2kg 180 cash", "cash sale"],
    ["Mary (blue uniform) amechukua sukari 200 deni", "deni"],
    ["john amelipa deni yake 150", "repayment"],
    ["funga leo 3500", "day close"],
    ["nionyeshe wateja wangu", "regulars"],
    ["nataka report", "statement"],
    ["QK12ABC3DE Confirmed. You have received Ksh500.00 from JOHN KAMAU 254712345678 on 3/7/26 at 10:15 AM. New M-PESA balance is Ksh12,300.00", "M-Pesa SMS"]
  ];

  var log = document.getElementById("log");
  var form = document.getElementById("f");
  var input = document.getElementById("body");
  var sendBtn = document.getElementById("send");
  var nameEl = document.getElementById("name");

  SAMPLES.forEach(function (s) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = s[1];
    b.title = s[0];
    b.onclick = function () { input.value = s[0]; input.focus(); };
    document.getElementById("presets").appendChild(b);
  });

  function bubble(text, who) {
    var row = document.createElement("div");
    row.className = "row " + who;
    var b = document.createElement("div");
    b.className = "bubble";
    // textContent, not innerHTML — a reply is untrusted model output.
    b.textContent = text;
    row.appendChild(b);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  form.onsubmit = async function (e) {
    e.preventDefault();
    var body = input.value.trim();
    if (!body) return;
    bubble(body, "me");
    input.value = "";
    sendBtn.disabled = true;
    var pending = bubble("…", "bot");
    var t0 = Date.now();
    try {
      var r = await fetch("/test/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "test-user-1", name: nameEl.value, body: body })
      });
      var data = await r.json();
      pending.textContent = data.replyText || "(empty reply)";
    } catch (err) {
      pending.textContent = "[test harness] request failed: " + err;
    }
    var ms = document.createElement("div");
    ms.className = "meta";
    ms.textContent = (Date.now() - t0) + " ms";
    pending.appendChild(ms);
    sendBtn.disabled = false;
    input.focus();
    log.scrollTop = log.scrollHeight;
  };
</script>
</body>
</html>`;

export default router;
