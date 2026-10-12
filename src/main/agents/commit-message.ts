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

const NO_MESSAGE = "The agent did not suggest a commit message";

/** The commit prompt's suggest button, asked of the suggesters picked in the settings (`suggestersFor`,
 *  switched-on ones in order): the first to answer wins, and the last one's failure is the one told.
 *  A Cancel (`cancelCommitSuggestion`) ends the chain: the agent it killed failed like any other, and
 *  the next must not be asked in its place. `prompt` (`effectivePrompt`) and `context`
 *  (`readCommitContext`, read only once an agent can answer) are handed in: the git process and the
 *  settings are not this layer's. */
export async function suggestCommitMessage(
  suggesters: Suggester[],
  root: string,
  prompt: string,
  context: () => Promise<string>,
): Promise<SuggestionResult> {
  const started = suggestion.stops;
  // None where no installed agent can, or all are switched off.
  const askers = suggesters.flatMap((suggester) => {
    const agent = AGENTS.find((candidate) => candidate.id === suggester.agentId);
    return agent?.ask ? [{ agent, ask: agent.ask, model: suggester.model }] : [];
  });
  if (askers.length === 0) {
    return { error: "No agent that can suggest a commit message is installed." };
  }
  let read: string;
  try {
    read = await context();
  } catch (error) {
    return { error: `Could not suggest a commit message: ${errorMessage(error)}` };
  }
  if (read.trim() === "") {
    return { error: NO_MESSAGE };
  }
  let error = NO_MESSAGE;
  for (const { agent, ask, model } of askers) {
    if (suggestion.stops !== started) {
      return {};
    }
    // "" leaves the model to the agent's own configuration.
    const args = [...ask.args, ...(model === "" ? [] : ask.modelArgs(model))];
    try {
      const reply = await suggestion.run((onSpawn) => askAgent(root, agent.executable(), args, `${prompt}\n\n${read}`, onSpawn));
      const message = commitMessageFrom(reply);
      if (message.length > 0) {
        return { value: message };
      }
      error = NO_MESSAGE;
    } catch (failure) {
      error = `Could not suggest a commit message: ${errorMessage(failure)}`;
    }
  }
  return suggestion.stops === started ? { error } : {};
}

/** For the commit prompt's Cancel. */
export function cancelCommitSuggestion(): void {
  suggestion.stop();
}
