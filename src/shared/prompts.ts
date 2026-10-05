import type { PromptId, PromptTexts } from "./types/settings";

/**
 * What TET asks of an agent: questions in the background, and a handover's first prompt. Here, not
 * beside the caller, because the settings dialog edits them and the renderer may not import
 * src/main. What is appended (the diff, the transcript's paths) is the caller's.
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
  "Answer with exactly one concise subject line: no quotes, Markdown, explanation, or body.",
].join("\n");

/** The first prompt of a tab taking over another agent's session; its lines reach the CLI as one,
 *  an argument (AgentTerminal.initialPromptArgs). */
const HANDOVER_PROMPT = [
  "You are taking over a coding session from another agent. Its session transcript, in that",
  "agent's own format, is in the files named below; it can be larger than your context, so read it",
  "in parts, the most recent first. Learn the task, what was decided and done, and what is still",
  "open. Then say briefly where things stand and continue the work without redoing what is done.",
].join("\n");

/** TET's own text — what an empty setting means. */
export const DEFAULT_PROMPTS: Readonly<Record<PromptId, string>> = {
  commitMessage: COMMIT_MESSAGE_PROMPT,
  handover: HANDOVER_PROMPT,
};

/** The user's text, else TET's. Read at the moment of asking, so a change needs no restart. */
export function effectivePrompt(texts: PromptTexts, id: PromptId): string {
  return texts[id] || DEFAULT_PROMPTS[id];
}
