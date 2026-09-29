import { useEffect, useState } from "react";
import type { AgentId, AskModelsResult, Suggester } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import { Dropdown } from "../ui/Dropdown";
import { DialogError } from "../ui/Field";
import { agentName, useAgents } from "../ui/use-agents";

/** No model argument: the agent's own configuration picks. */
const DEFAULT_MODEL = { value: "", label: "Default", separatorAfter: true };

interface SuggesterPickerProps {
  /** Where the agents and models are listed (`suggestionAgents`). */
  ref: ProjectRef;
  value: Suggester;
  /** What the user picks. */
  onChange: (suggester: Suggester) => void;
  /** What stands in for a pick not offered at `ref`: shown, never saved. */
  onReplace: (suggester: Suggester) => void;
}

/**
 * The installed agents that can suggest, and the models of the one picked. Without a pick — or with
 * one no longer offered — the first agent with its default model, as the commit prompt's suggestion
 * takes it (`repository:suggest-commit-message`).
 */
export function SuggesterPicker({ ref, value, onChange, onReplace }: SuggesterPickerProps) {
  const agents = useAgents();
  const [agentIds, setAgentIds] = useState<AgentId[]>();
  const [listed, setListed] = useState<{ agentId: AgentId; result: AskModelsResult }>();
  const models = listed?.agentId === value.agentId ? listed.result : undefined;

  useEffect(() => {
    let cancelled = false;
    void window.tet.repository.suggestionAgents(ref).then((ids) => {
      if (!cancelled) {
        setAgentIds(ids);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ref]);

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
    void window.tet.repository.suggestionModels(ref, value.agentId).then((result) => {
      if (!cancelled) {
        setListed({ agentId: value.agentId, result });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ref, agentIds, value.agentId]);

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
        : [])
  ];

  return (
    <>
      <div className="dialog-field-row">
        <Dropdown
          fit
          value={value.agentId}
          options={agentOptions}
          onChange={(agentId) => onChange({ agentId, model: "" })}
        />
        <Dropdown
          value={value.model}
          options={modelOptions}
          onChange={(model) => onChange({ ...value, model })}
        />
      </div>
      <DialogError message={models?.error} />
    </>
  );
}
