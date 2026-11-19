import { errorMessage } from "../../shared/errors";
import { suggestersFor } from "../../shared/suggesters";
import type { SuggesterEntry, SuggestionResult } from "../../shared/types/agents";
import { askAgent } from "./ask";
import { AGENTS, listAskableAgents } from "./index";
import { stoppable } from "../util/process";

/** What an agent is asked to suggest: the tag its answer stands between (the prompt's to say,
 *  `COMMIT_MESSAGE_PROMPT`), and what is said where none comes: no agent to ask (`missing`), one
 *  that failed (`failed`, before its reason), an answer without the tags (`none`), and nothing to
 *  ask about (`empty`). */
interface SuggestionKind {
  tag: string;
  missing: string;
  failed: string;
  none: string;
  empty: string;
}

/** The commit prompt asks only with changes to commit, so its `empty` is its `none`. */
const COMMIT_MESSAGE: SuggestionKind = {
  tag: "commit",
  missing: "No agent that can suggest a commit message is installed.",
  failed: "Could not suggest a commit message",
  none: "The agent did not suggest a commit message",
  empty: "The agent did not suggest a commit message",
};

/** Shaped as a commit message: the title, an empty line, the description. Its `empty` names the
 *  branches (`suggestChangeRequest`). */
const CHANGE_REQUEST: Omit<SuggestionKind, "empty"> = {
  tag: "change-request",
  missing: "No agent that can suggest a title is installed.",
  failed: "Could not suggest a title",
  none: "The agent answered without a title",
};

/** The text between the answer's last `<tag>` and `</tag>`, whole: how many lines it has is the
 *  prompt's to say. An answer without them is none, so whatever an agent says around its answer never
 *  becomes the text. */
export function answerFrom(reply: string, tag: string): string {
  const answers = [...reply.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi"))];
  return (answers.at(-1)?.[1] ?? "").trim();
}

/** The agent a suggestion waits on, for `cancelSuggestion`: one question is up at a time. */
const suggestion = stoppable();

/**
 * A prompt's suggest button, asked of the suggesters the settings keep (`saved`) as their dialog
 * lists them (`suggestersFor`): what is not installed here is left out, a new agent comes last, and
 * the ones switched off are not asked. The first to answer wins, and the last one's failure is the
 * one told. A Cancel (`cancelSuggestion`) ends the chain: the agent it killed failed like any other,
 * and the next must not be asked in its place. `prompt` (`effectivePrompt`) and `context` (read only
 * once an agent can answer) are handed in: the git process and the settings are not this layer's.
 */
async function suggest(
  saved: readonly SuggesterEntry[],
  root: string,
  prompt: string,
  context: () => Promise<string>,
  { tag, missing, failed, none, empty }: SuggestionKind,
): Promise<SuggestionResult> {
  const started = suggestion.stops;
  const suggesters = suggestersFor(saved, await listAskableAgents(root)).filter((entry) => entry.enabled);
  // None where no installed agent can, or all are switched off.
  const askers = suggesters.flatMap((suggester) => {
    const agent = AGENTS.find((candidate) => candidate.id === suggester.agentId);
    return agent?.ask ? [{ agent, ask: agent.ask, model: suggester.model }] : [];
  });
  if (askers.length === 0) {
    return { error: missing };
  }
  let read: string;
  try {
    read = await context();
  } catch (error) {
    return { error: `${failed}: ${errorMessage(error)}` };
  }
  if (read.trim() === "") {
    return { error: empty };
  }
  let error = none;
  for (const { agent, ask, model } of askers) {
    if (suggestion.stops !== started) {
      return {};
    }
    // "" leaves the model to the agent's own configuration.
    const args = [...ask.args, ...(model === "" ? [] : ask.modelArgs(model))];
    try {
      const reply = await suggestion.run((onSpawn) => askAgent(root, agent.executable(), args, `${prompt}\n\n${read}`, onSpawn));
      const answer = answerFrom(reply, tag);
      if (answer.length > 0) {
        return { value: answer };
      }
      error = none;
    } catch (failure) {
      error = `${failed}: ${errorMessage(failure)}`;
    }
  }
  return suggestion.stops === started ? { error } : {};
}

/** The commit prompt's suggestion; `context` is `readCommitContext`. */
export function suggestCommitMessage(
  saved: readonly SuggesterEntry[],
  root: string,
  prompt: string,
  context: () => Promise<string>,
): Promise<SuggestionResult> {
  return suggest(saved, root, prompt, context, COMMIT_MESSAGE);
}

/** The pull or merge request prompt's; `context` is `readRangeContext`, which is empty where the
 *  branch has no commit its target lacks, as `empty` says. */
export function suggestChangeRequest(
  saved: readonly SuggesterEntry[],
  root: string,
  prompt: string,
  context: () => Promise<string>,
  empty: string,
): Promise<SuggestionResult> {
  return suggest(saved, root, prompt, context, { ...CHANGE_REQUEST, empty });
}

/** For a suggesting prompt's Cancel. */
export function cancelSuggestion(): void {
  suggestion.stop();
}
