import type { PromptId, PromptSettings } from "./types";

/**
 * The questions tet puts to an agent in the background. Here, not beside the caller, because the
 * settings dialog edits them and the renderer may not import src/main. What is appended (the diff)
 * is the caller's.
 */

/** Self-contained — the agent runs no command, so it answers in one round trip. */
const COMMIT_MESSAGE_PROMPT = [
  "Below are a repository's recent commit subjects and every change `git add --all` would",
  "commit. Suggest the commit message for those changes.",
  "",
  "Follow the recent subjects' language, capitalization, prefixes, and usual length. Say what",
  "the change accomplishes, not what the diff does line by line. Do not mention an agent or add",
  "attribution.",
  "",
  "Answer with exactly one concise subject line: no quotes, Markdown, explanation, or body."
].join("\n");

/** tet's own text — what an empty setting means. */
export const DEFAULT_PROMPTS: Readonly<Record<PromptId, string>> = {
  commitMessage: COMMIT_MESSAGE_PROMPT
};

/** The user's text, else tet's. Read at the moment of asking, so a change needs no restart. */
export function effectivePrompt(prompts: PromptSettings, id: PromptId): string {
  return prompts[id] || DEFAULT_PROMPTS[id];
}
