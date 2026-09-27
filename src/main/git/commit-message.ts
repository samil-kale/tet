import type { ChildProcess } from "node:child_process";
import { askAgent } from "../agents/ask";
import { killProcessTree } from "../terminals/pty";

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
let currentChild: ChildProcess | undefined;

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
  let child: ChildProcess | undefined;
  try {
    return commitMessageFrom(
      await askAgent(root, executable, args, `${prompt}\n\n${context}`, (spawned) => {
        child = currentChild = spawned;
      })
    );
  } finally {
    if (child && currentChild === child) {
      currentChild = undefined;
    }
  }
}

/** For the commit prompt's Cancel, a no-op when nothing runs. With its children: an npm CLI is a
 *  cmd.exe shim on win32 (killProcessTree). The caller's `cleanupAsk` still runs. */
export function cancelCommitSuggestion(): void {
  if (currentChild) {
    killProcessTree(currentChild);
    currentChild = undefined;
  }
}
