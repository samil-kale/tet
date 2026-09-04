import { askAgent } from "../agents/ask";

/**
 * The question, with everything it needs already in it. Telling the agent to go and look was
 * the first version and cost three times as long — see `readCommitContext` for the numbers.
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

/** Takes the first subject out of an otherwise well-formed answer, tolerating a fenced reply. */
export function commitMessageFrom(reply: string): string {
  const line = reply
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith("```"));
  if (!line) {
    return "";
  }
  const withoutLabel = line.replace(/^(?:commit (?:message|subject)|message|subject)\s*:\s*/i, "").trim();
  const quote = withoutLabel[0];
  return quote && ["\"", "'", "`"].includes(quote) && withoutLabel.endsWith(quote)
    ? withoutLabel.slice(1, -1).trim()
    : withoutLabel;
}

/**
 * `context` is `readCommitContext`'s, handed in rather than fetched here: the git process is
 * reached from the main process, and this file stays the prompt and its answer alone.
 */
export async function suggestCommitMessage(
  root: string,
  executable: string,
  args: string[],
  context: string
): Promise<string> {
  // Nothing to describe, so nothing to ask — an agent would spend the same half minute finding
  // that out.
  if (context.trim() === "") {
    return "";
  }
  return commitMessageFrom(await askAgent(root, executable, args, `${COMMIT_MESSAGE_PROMPT}\n\n${context}`));
}
