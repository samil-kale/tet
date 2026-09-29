import { askAgent } from "../agents/ask";
import { stoppable } from "../util/run-process";

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

/** The agent the commit prompt waits on, for `cancelCommitSuggestion`: one question is up at a
 *  time. */
const suggestion = stoppable();

/** The commit prompt's suggest button, asked of the first installed agent with `ask`
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
  return commitMessageFrom(
    await suggestion.run((onSpawn) => askAgent(root, executable, args, `${prompt}\n\n${context}`, onSpawn))
  );
}

/** For the commit prompt's Cancel. */
export function cancelCommitSuggestion(): void {
  suggestion.stop();
}
