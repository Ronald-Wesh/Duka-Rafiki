import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { config } from "./config";

const MODEL = "claude-sonnet-5";

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

export interface AskOptions {
  maxTokens?: number;
  /** 0 for extraction (default), higher only where wording should vary. */
  temperature?: number;
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
    temperature: opts.temperature ?? 0,
    system: loadPrompt(promptName),
    messages: [{ role: "user", content: input }],
  });
  const block = message.content[0];
  return block?.type === "text" ? block.text.trim() : "";
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
  const raw = await askClaude(promptName, input, opts);
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
