import { useEffect, useState } from "react";
import type { AgentId, AskModelsResult, Suggester } from "../../shared/types/agents";
import { Dropdown } from "../ui/Dropdown";
import { DialogError, FieldRow } from "../ui/Field";
import { agentName, useAgents } from "../ui/use-agents";

/** No model argument: the agent's own configuration picks. */
const DEFAULT_MODEL = { value: "", label: "Default", separatorAfter: true };

interface SuggesterPickerProps {
  value: Suggester;
  /** What the user picks. */
  onChange: (suggester: Suggester) => void;
  /** What stands in for a pick not offered: shown, never saved. */
  onReplace: (suggester: Suggester) => void;
  /** The models' listing underway, on the dialog's bar (as `PromptFields.hold`): it asks the agent,
   *  changes nothing and its late answer is dropped, so it holds no Cancel. */
  hold: (held: boolean) => void;
}

/**
 * The installed agents that can suggest, and the models of the one picked. Without a pick — or with
 * one no longer offered — the first agent with its default model, as the commit prompt's suggestion
 * takes it (`repository:suggest-commit-message`).
 */
export function SuggesterPicker({ value, onChange, onReplace, hold }: SuggesterPickerProps) {
  const agents = useAgents();
  const [agentIds, setAgentIds] = useState<AgentId[]>();
  const [listed, setListed] = useState<{ agentId: AgentId; result: AskModelsResult }>();
  const models = listed?.agentId === value.agentId ? listed.result : undefined;

  useEffect(() => {
    let cancelled = false;
    void window.tet.agents.askable().then((ids) => {
      if (!cancelled) {
        setAgentIds(ids);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (agentIds?.[0] !== undefined && !agentIds.includes(value.agentId)) {
      onReplace({ agentId: agentIds[0], model: "" });
    }
  }, [agentIds, value.agentId, onReplace]);

  useEffect(() => {
    if (!agentIds?.includes(value.agentId)) {
      return;
    }
    let cancelled = false;
    let fetching = true;
    hold(true);
    void window.tet.agents
      .askModels(value.agentId)
      .then((result) => {
        if (!cancelled) {
          setListed({ agentId: value.agentId, result });
        }
      })
      .finally(() => {
        if (!cancelled) {
          fetching = false;
          hold(false);
        }
      });
    return () => {
      cancelled = true;
      // Only a listing still running: one that ended has released the bar already.
      if (fetching) {
        hold(false);
      }
    };
  }, [agentIds, value.agentId, hold]);

  useEffect(() => {
    if (models && value.model !== "" && !models.models.some((model) => model.id === value.model)) {
      onReplace({ ...value, model: "" });
    }
  }, [models, value, onReplace]);

  const agentOptions = (agentIds ?? []).map((id) => ({ value: id, label: agentName(agents, id) }));
  // Until its list lands, a remembered model stands by its id.
  const modelOptions = [
    DEFAULT_MODEL,
    ...(models
      ? models.models.map((model) => ({ value: model.id, label: model.label }))
      : value.model !== ""
        ? [{ value: value.model, label: value.model }]
        : []),
  ];

  return (
    <>
      <FieldRow>
        <Dropdown fit value={value.agentId} options={agentOptions} onChange={(agentId) => onChange({ agentId, model: "" })} />
        <Dropdown value={value.model} options={modelOptions} onChange={(model) => onChange({ ...value, model })} />
      </FieldRow>
      <DialogError message={models?.error} />
    </>
  );
}
