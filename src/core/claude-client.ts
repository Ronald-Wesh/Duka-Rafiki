import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { config } from "./config";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Prompts live as versioned files in ./prompts, not inline strings
// (README section 11) — one file per task, loaded here.
export function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(__dirname, "prompts", `${name}.md`), "utf-8");
}

// The model does language only — parsing/phrasing. It is never asked to
// compute a figure that appears in the statement (README section 5).
export async function askClaude(
  promptName: string,
  input: string,
  maxTokens = 1024
): Promise<string> {
  const system = loadPrompt(promptName);
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: input }],
  });
  const block = message.content[0];
  return block.type === "text" ? block.text : "";
}

// Convenience for prompts that instruct Claude to reply with JSON only.
export async function askClaudeJson<T>(
  promptName: string,
  input: string,
  maxTokens = 1024
): Promise<T> {
  const text = await askClaude(promptName, input, maxTokens);
  return JSON.parse(text) as T;
}
