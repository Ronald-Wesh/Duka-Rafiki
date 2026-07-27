import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { config } from "./config";

// Sonnet 5 is fast and cheap enough for per-message SMS parsing, which matters
// when a trader is waiting on a WhatsApp reply. Override with ANTHROPIC_MODEL
// (e.g. claude-opus-5) if you want more capability and can absorb the latency.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

// Lazy: constructing without a key is harmless, but failing at the first call
// with a vague SDK error at 3am is not. Fail loudly and early instead.
let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — copy .env.example to .env and fill it in");
  }
  if (!anthropic) anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  return anthropic;
}

// Prompts live as versioned files in ./prompts, not inline strings
// (README section 11) — one file per task, loaded here.
export function loadPrompt(name: string): string {
  const file = path.join(__dirname, "prompts", `${name}.md`);
  if (!fs.existsSync(file)) {
    const available = fs
      .readdirSync(path.join(__dirname, "prompts"))
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => f.replace(/\.md$/, ""));
    throw new Error(`No prompt "${name}". Available: ${available.join(", ")}`);
  }
  return fs.readFileSync(file, "utf-8");
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AskOptions {
  maxTokens?: number;
  /**
   * Reasoning depth. `low` is right for extraction; leave unset for phrasing.
   *
   * NOTE: there is deliberately no `temperature` here. It is removed on
   * Sonnet 5 / Opus 5 and a non-default value returns a 400 — the whole client
   * was failing on `temperature is deprecated for this model`. Steer output
   * through the prompt, not sampling parameters.
   */
  effort?: Effort;
  /** Extraction disables thinking for latency; phrasing leaves it adaptive. */
  disableThinking?: boolean;
}

// The model does language only — parsing, classifying, phrasing. It is never
// asked to compute a figure that appears in the statement (README section 5).
export async function askClaude(
  promptName: string,
  input: string,
  opts: AskOptions = {}
): Promise<string> {
  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: loadPrompt(promptName),
    messages: [{ role: "user", content: input }],
    ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    ...(opts.disableThinking ? { thinking: { type: "disabled" as const } } : {}),
  });

  // Take the first text block rather than content[0] — with thinking enabled the
  // first block can be a thinking block, and indexing blindly returns "".
  const text = message.content.find((b) => b.type === "text");
  return text?.type === "text" ? text.text.trim() : "";
}

/**
 * Pulls the JSON out of a model reply. Prompts ask for raw JSON, but models
 * still wrap it in ```json fences often enough that letting JSON.parse throw
 * on it would be a needless live failure.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1].trim();

  // Fall back to the outermost braces, in case of stray prose either side.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

/**
 * For prompts that reply with JSON. Note the convention the parse prompts
 * follow: on failure they return `{"error": "..."}` rather than guessing, so
 * callers should check for an `error` key before trusting the shape.
 */
export async function askClaudeJson<T>(
  promptName: string,
  input: string,
  opts: AskOptions = {}
): Promise<T> {
  // Extraction defaults: no thinking, lowest effort. A forwarded SMS should come
  // back in well under a second — the owner is waiting on the reply.
  const raw = await askClaude(promptName, input, {
    effort: "low",
    disableThinking: true,
    ...opts,
  });
  const json = extractJson(raw);
  try {
    return JSON.parse(json) as T;
  } catch {
    // Include what came back — otherwise this is undebuggable from a log.
    throw new Error(
      `Prompt "${promptName}" did not return valid JSON. Got: ${raw.slice(0, 300)}`
    );
  }
}
