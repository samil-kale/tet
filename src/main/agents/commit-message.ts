import { errorMessage } from "../../shared/errors";
import type { Suggester, SuggestionResult } from "../../shared/types/agents";
import { askAgent } from "./ask";
import { AGENTS } from "./index";
import { stoppable } from "../util/process";

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
  return quote && ['"', "'", "`"].includes(quote) && withoutLabel.endsWith(quote) ? withoutLabel.slice(1, -1).trim() : withoutLabel;
}

/** The agent the commit prompt waits on, for `cancelCommitSuggestion`: one question is up at a
 *  time. */
const suggestion = stoppable();

/** Whether the Cancel came: the agent it killed failed like any other, and the next must not be
 *  asked in its place. */
let cancelled = false;

/** The commit prompt's suggest button, asked of the suggesters picked in the settings (`suggestersFor`,
 *  switched-on ones in order): the first to answer wins, and the last one's failure is the one told.
 *  `prompt` (`effectivePrompt`) and `context` (`readCommitContext`, read only once an agent can
 *  answer) are handed in: the git process and the settings are not this layer's. */
export async function suggestCommitMessage(
  suggesters: Suggester[],
  root: string,
  prompt: string,
  context: () => Promise<string>,
): Promise<SuggestionResult> {
  cancelled = false;
  let read: string;
  try {
    read = await context();
  } catch (error) {
    return { error: `Could not suggest a commit message: ${errorMessage(error)}` };
  }
  if (read.trim() === "") {
    return { error: "The agent did not suggest a commit message" };
  }
  // None where no installed agent can.
  let error = "No agent that can suggest a commit message is installed.";
  for (const suggester of suggesters) {
    const agent = AGENTS.find((candidate) => candidate.id === suggester.agentId);
    if (!agent?.ask) {
      continue;
    }
    // "" leaves the model to the agent's own configuration.
    const args = [...agent.ask.args, ...(suggester.model === "" ? [] : agent.ask.modelArgs(suggester.model))];
    try {
      const reply = await suggestion.run((onSpawn) => askAgent(root, agent.executable(), args, `${prompt}\n\n${read}`, onSpawn));
      const message = commitMessageFrom(reply);
      if (message.length > 0) {
        return { value: message };
      }
      error = "The agent did not suggest a commit message";
    } catch (failure) {
      error = `Could not suggest a commit message: ${errorMessage(failure)}`;
    }
    if (cancelled) {
      return {};
    }
  }
  return { error };
}

/** For the commit prompt's Cancel. */
export function cancelCommitSuggestion(): void {
  cancelled = true;
  suggestion.stop();
}
