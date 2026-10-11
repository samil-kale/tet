import type { AgentId, SuggesterEntry } from "./types/agents";

/**
 * The suggesters the settings keep, as the installed agents offer them: the saved order for the
 * ones installed, then each installed agent not saved yet — switched on, with its default model.
 * One list for the settings dialog and for the commit prompt, so what is shown is what is asked.
 */
export function suggestersFor(saved: readonly SuggesterEntry[], askable: readonly AgentId[]): SuggesterEntry[] {
  const kept = saved.filter((entry) => askable.includes(entry.agentId));
  const added = askable.filter((id) => !kept.some((entry) => entry.agentId === id));
  return [...kept, ...added.map((agentId) => ({ agentId, model: "", enabled: true }))];
}
