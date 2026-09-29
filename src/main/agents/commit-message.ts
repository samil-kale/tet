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
  return quote && ["\"", "'", "`"].includes(quote) && withoutLabel.endsWith(quote)
    ? withoutLabel.slice(1, -1).trim()
    : withoutLabel;
}

/** The agent the commit prompt waits on, for `cancelCommitSuggestion`: one question is up at a
 *  time. */
const suggestion = stoppable();

/** The commit prompt's suggest button, asked of the agent and model picked beside it. `prompt`
 *  (`effectivePrompt`) and `context` (`readCommitContext`, read only once an agent can answer) are
 *  handed in: the git process and the settings are not this layer's. */
export async function suggestCommitMessage(
  suggester: Suggester,
  root: string,
  prompt: string,
  context: () => Promise<string>
): Promise<SuggestionResult> {
  // None ("", where no installed agent can), or one that has gone since it was saved.
  const agent = AGENTS.find((candidate) => candidate.id === suggester.agentId);
  if (!agent?.ask) {
    return { error: "No agent that can suggest a commit message is installed." };
  }
  // "" leaves the model to the agent's own configuration.
  const args = [...agent.ask.args, ...(suggester.model === "" ? [] : agent.ask.modelArgs(suggester.model))];
  try {
    const read = await context();
    const reply =
      read.trim() === "" ? "" : await suggestion.run((onSpawn) => askAgent(root, agent.executable(), args, `${prompt}\n\n${read}`, onSpawn));
    const message = commitMessageFrom(reply);
    return message.length === 0 ? { error: "The agent did not suggest a commit message" } : { value: message };
  } catch (error) {
    return { error: `Could not suggest a commit message: ${errorMessage(error)}` };
  }
}

/** For the commit prompt's Cancel. */
export function cancelCommitSuggestion(): void {
  suggestion.stop();
}
