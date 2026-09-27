import type { PromptId, PromptSettings } from "./types";

/**
 * What tet asks of an agent: questions in the background, and a handoff's first prompt. Here, not
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
  "Answer with exactly one concise subject line: no quotes, Markdown, explanation, or body."
].join("\n");

/** The first prompt of a tab taking over another agent's session; its lines reach the CLI as one,
 *  an argument (initialPromptArgs). */
const HANDOFF_PROMPT = [
  "You are taking over a coding session from another agent that could not go on, for example",
  "because it reached its usage limit. Its session transcript, in that agent's own format, is in",
  "the files named below; it can be larger than your context, so read it in parts, the most recent",
  "first. Learn the task, what was decided and done, and what is still open. Then say briefly",
  "where things stand and continue the work without redoing what is done."
].join("\n");

/** tet's own text — what an empty setting means. */
export const DEFAULT_PROMPTS: Readonly<Record<PromptId, string>> = {
  commitMessage: COMMIT_MESSAGE_PROMPT,
  handoff: HANDOFF_PROMPT
};

/** The user's text, else tet's. Read at the moment of asking, so a change needs no restart. */
export function effectivePrompt(prompts: PromptSettings, id: PromptId): string {
  return prompts[id] || DEFAULT_PROMPTS[id];
}
