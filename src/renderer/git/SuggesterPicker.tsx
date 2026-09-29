import { useEffect, useState } from "react";
import type { AgentId, AskModelsResult, ProjectRef, Suggester } from "../../shared/types";
import { Dropdown } from "../ui/Dropdown";
import { DialogError } from "../ui/Field";
import { agentName, useAgents } from "../ui/use-agents";

/** The last agent and model picked, for the next prompt. Renderer storage, as the last directory
 *  (`Field.tsx`): it describes this window's use, not a project. */
const SUGGESTER_KEY = "tet.dialog.suggester";

/** No model argument: the agent's own configuration picks. */
const DEFAULT_MODEL = { value: "", label: "Default", separatorAfter: true };

/** The last pick; an agent of "" until the installed ones are known (`SuggesterPicker`). */
export function rememberedSuggester(): Suggester {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SUGGESTER_KEY) ?? "null");
    if (typeof stored === "object" && stored !== null) {
      const { agentId, model } = stored as Partial<Record<keyof Suggester, unknown>>;
      if (typeof agentId === "string" && typeof model === "string") {
        return { agentId, model };
      }
    }
  } catch {
    // Unreadable: as if nothing was picked.
  }
  return { agentId: "", model: "" };
}

interface SuggesterPickerProps {
  ref: ProjectRef;
  value: Suggester;
  onChange: (suggester: Suggester) => void;
  disabled?: boolean;
}

/**
 * The installed agents that can suggest, and the models of the one picked. Without a pick — or with
 * one no longer offered — the first agent with its default model; only what the user picks is
 * remembered.
 */
export function SuggesterPicker({ ref, value, onChange, disabled }: SuggesterPickerProps) {
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
    localStorage.setItem(SUGGESTER_KEY, JSON.stringify(suggester));
    onChange(suggester);
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
      <DialogError message={models?.error} />
    </>
  );
}
