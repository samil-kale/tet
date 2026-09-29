import { useEffect, useState } from "react";
import { errorMessage } from "../../shared/errors";
import type { AgentId, AskModelsResult, ProjectRef, Suggester } from "../../shared/types";
import { Dropdown } from "../ui/Dropdown";
import { DialogError } from "../ui/Field";
import { agentName, useAgents } from "../ui/use-agents";

/** No model argument: the agent's own configuration picks. */
const DEFAULT_MODEL = { value: "", label: "Default", separatorAfter: true };

interface SuggesterPickerProps {
  ref: ProjectRef;
  value: Suggester;
  onChange: (suggester: Suggester) => void;
  disabled?: boolean;
}

/**
 * The installed agents that can suggest, and the models of the one picked. Without a pick — or with
 * one no longer offered — the first agent with its default model. What the user picks is saved at
 * once (`AppSettings.commitSuggester`), a replacement is not.
 */
export function SuggesterPicker({ ref, value, onChange, disabled }: SuggesterPickerProps) {
  const agents = useAgents();
  const [agentIds, setAgentIds] = useState<AgentId[]>();
  const [listed, setListed] = useState<{ agentId: AgentId; result: AskModelsResult }>();
  const [unsaved, setUnsaved] = useState<string>();
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
      onChange({ agentId: agentIds[0], model: "" });
    }
  }, [agentIds, value.agentId, onChange]);

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
      onChange({ ...value, model: "" });
    }
  }, [models, value, onChange]);

  const pick = (suggester: Suggester): void => {
    setUnsaved(undefined);
    onChange(suggester);
    // The pick holds for this commit either way; only the next prompt misses it.
    window.tet.settings
      .patch({ commitSuggester: suggester })
      .catch((error: unknown) => setUnsaved(`Could not save the pick: ${errorMessage(error)}`));
  };

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
          disabled={disabled}
          onChange={(agentId) => pick({ agentId, model: "" })}
        />
        <Dropdown
          value={value.model}
          options={modelOptions}
          disabled={disabled}
          onChange={(model) => pick({ ...value, model })}
        />
      </div>
      <DialogError message={models?.error ?? unsaved} />
    </>
  );
}
