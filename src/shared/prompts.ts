import type { PromptId, PromptSettings } from "./types";

/**
 * The question tet puts to an agent in the background. Here rather than beside its caller in
 * src/main/git because the settings dialog shows and edits it, and
 * the renderer may import nothing from src/main. What is *appended* to a question — the diff
 * under the commit prompt — is the caller's, so a user's own text keeps the same shape.
 */

/**
 * The question, with everything it needs already in it. Telling the agent to go and look was
 * the first version and cost several times as long — see `readCommitContext`.
 * Nothing here asks it to run a command, so it answers in one round trip.
 */
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

/** tet's own text for the question — what an empty setting means. */
export const DEFAULT_PROMPTS: Readonly<Record<PromptId, string>> = {
  commitMessage: COMMIT_MESSAGE_PROMPT
};

/**
 * The text actually put to the agent: the user's own, or tet's where none is set. Read at the
 * moment of asking, so a change applies to the next press — the one setting that needs no
 * restart, since nothing keeps a copy.
 */
export function effectivePrompt(prompts: PromptSettings, id: PromptId): string {
  return prompts[id] || DEFAULT_PROMPTS[id];
}
