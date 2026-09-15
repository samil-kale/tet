import { askAgent } from "../agents/ask";

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

/** The commit prompt's suggest button, asked of the first installed agent with `askArgs`
 *  (`findAskableAgent`). `prompt` (`effectivePrompt`) and `context` (`readCommitContext`) are handed
 *  in: only the main process reaches the git process and the settings. */
export async function suggestCommitMessage(
  root: string,
  executable: string,
  args: string[],
  prompt: string,
  context: string
): Promise<string> {
  if (context.trim() === "") {
    return "";
  }
  return commitMessageFrom(await askAgent(root, executable, args, `${prompt}\n\n${context}`));
}
