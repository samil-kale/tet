import { useEffect, useState } from "react";
import type { AgentId, AskModelsResult } from "../../shared/types/agents";
import type { DropdownOption } from "./Dropdown";
import { fetchHeld } from "./fetch-held";

/** No model argument: the agent's own configuration picks. */
const DEFAULT_MODEL = { value: "", label: "Default", separatorAfter: true };

/**
 * The models `agentId` can be asked with, as a `Dropdown`'s options, and why they could not be
 * listed. The listing runs on the view's bar (`hold`, as `fetchHeld`); until it lands a remembered
 * `model` stands in for it.`offered` is false once it has landed without `model`, for the caller
 * to replace a model the agent no longer offers.
 */
export function useAskModels(
  agentId: AgentId,
  model: string,
  hold: (held: boolean) => void,
): { options: DropdownOption<string>[]; error: string | undefined; offered: boolean } {
  const [listed, setListed] = useState<{ agentId: AgentId; result: AskModelsResult }>();
  const result = listed?.agentId === agentId ? listed.result : undefined;

  useEffect(
    () =>
      fetchHeld(
        () => window.tet.agents.askModels(agentId),
        hold,
        (answer) => setListed({ agentId, result: answer }),
      ),
    [agentId, hold],
  );

  const options = [
    DEFAULT_MODEL,
    ...(result
      ? result.models.map((entry) => ({ value: entry.id, label: entry.id }))
      : model !== ""
        ? [{ value: model, label: model }]
        : []),
  ];
  return {
    options,
    error: result?.error,
    offered: result === undefined || model === "" || result.models.some((entry) => entry.id === model),
  };
}
