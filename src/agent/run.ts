import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config";
import { loadPrompt } from "../core/claude-client";
import { SCHEMA_DESCRIPTION } from "./dynamic-db";
import { TOOL_DEFS, queryLedger, recordEntries, NewEntry } from "./tools";
import type { Attachment } from "./media";

/**
 * The agent loop. No intent switch, no canned replies: the model reads her
 * message, decides whether to query, record, both or neither, and writes the
 * answer itself.
 *
 * Conversation history is kept per sender in memory. A restart loses it,
 * which is the right trade for a demo — persisting it means deciding when it
 * expires, and nothing here depends on last week's chat.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 6;
const HISTORY_LIMIT = 12;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

type Msg = Anthropic.MessageParam;
const histories = new Map<string, Msg[]>();

export function resetHistory(from: string): void {
  histories.delete(from);
}

/**
 * Trim history without orphaning a tool_result. The API rejects a turn whose
 * first message contains a tool_result with no matching tool_use before it, so
 * a naive slice() blows up once the conversation is long enough to cut mid-pair
 * — reliably, several tool calls in.
 */
function trimHistory(messages: Msg[]): Msg[] {
  const out = messages.slice(-HISTORY_LIMIT);
  while (out.length > 0) {
    const first = out[0];
    const isToolResultTurn =
      first.role === "user" &&
      Array.isArray(first.content) &&
      first.content.some((b) => (b as { type?: string }).type === "tool_result");
    if (first.role === "assistant" || isToolResultTurn) out.shift();
    else break;
  }
  return out;
}

export async function runAgent(
  from: string,
  text: string,
  attachments: Attachment[] = []
): Promise<string> {
  const system = loadPrompt("duka-agent").replace("{{SCHEMA}}", SCHEMA_DESCRIPTION);

  const history = histories.get(from) ?? [];
  // Appended to the turn, not the system prompt: the model weights the most
  // recent instruction most heavily, and without it a Swahili history drags
  // an English question back into Swahili.
  // Images ride in the same turn as the text, so the model sees the photo and
  // the caption together — "hii ni ya nani?" only makes sense next to it.
  const turn: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = attachments.map((a) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: a.contentType as "image/jpeg", data: a.base64 },
  }));
  turn.push({
    type: "text",
    text: `${text || "(no caption)"}\n\n[Reply in the language of this message.]`,
  });

  const messages: Msg[] = [...history, { role: "user", content: turn }];

  let reply = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // One retry: a 429 or 529 mid-conversation would otherwise surface as
    // "samahani, kuna hitilafu" on stage. Overloaded is usually gone in a second.
    let response;
    try {
      response = await getClient().messages.create({
        model: MODEL, max_tokens: 1024, system, tools: TOOL_DEFS, messages,
      });
    } catch (err) {
      console.warn("[agent] API error, retrying once:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 1500));
      response = await getClient().messages.create({
        model: MODEL, max_tokens: 1024, system, tools: TOOL_DEFS, messages,
      });
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUses.length === 0) {
      reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const input = use.input as Record<string, unknown>;
      let out: string;

      if (use.name === "query_ledger") {
        const sql = String(input.sql ?? "");
        console.log(`[agent] query: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
        out = queryLedger(sql);
      } else if (use.name === "generate_statement") {
        // P3's statement reads duka.db, the pillars' store — deliberately, so
        // the lender-facing document stays on the reconciled ledger rather
        // than the agent's looser one.
        console.log("[agent] generating statement");
        out = await import("../pillar3-statement")
          .then((m) => m.generateStatement())
          .then((r) => JSON.stringify({ url: r.url, summary: r.summary }))
          .catch((err) => JSON.stringify({ error: (err as Error).message }));
      } else if (use.name === "record_entries") {
        const entries = (input.entries ?? []) as NewEntry[];
        console.log(`[agent] record: ${JSON.stringify(entries)}`);
        out = recordEntries(entries, text);
      } else {
        out = JSON.stringify({ error: `Unknown tool ${use.name}` });
      }

      results.push({ type: "tool_result", tool_use_id: use.id, content: out });
    }

    messages.push({ role: "user", content: results });
  }

  // Ran out of turns mid-tool-loop. Rare, but she must never get silence.
  if (!reply) reply = "Nimepokea. Niulize tena kwa maneno mengine nikusaidie vizuri.";

  histories.set(from, trimHistory(messages));
  return reply;
}
