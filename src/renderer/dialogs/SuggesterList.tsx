import { useEffect, useState } from "react";
import { suggestersFor } from "../../shared/suggesters";
import type { AgentId, SuggesterEntry } from "../../shared/types/agents";
import { reorder } from "../ui/drag-reorder";
import { Dropdown } from "../ui/Dropdown";
import { IconButton } from "../ui/IconButton";
import { PowerIcon, PowerOffIcon } from "../ui/icons";
import { EditRow, RowInput, RowMark, RowSection, type RowReorder } from "../ui/RowSection";
import { agentName, useAgents } from "../ui/use-agents";
import { useAskModels } from "../ui/use-ask-models";

const DRAG_TYPE = "application/x-tet-suggester";

interface SuggesterRowProps {
  entry: SuggesterEntry;
  name: string;
  reorder: RowReorder | undefined;
  onChange: (entry: SuggesterEntry) => void;
  onReplaceModel: (agentId: AgentId) => void;
  hold: (held: boolean) => void;
}

/** One agent: its name, the model it is asked with, and whether it is asked at all. */
function SuggesterRow({ entry, name, reorder: drag, onChange, onReplaceModel, hold }: SuggesterRowProps) {
  const { options, error, offered } = useAskModels(entry.agentId, entry.model, hold);

  useEffect(() => {
    if (!offered) {
      onReplaceModel(entry.agentId);
    }
  }, [offered, entry.agentId, onReplaceModel]);

  return (
    <EditRow className="suggester-row" reorder={drag} off={!entry.enabled}>
      <RowInput readOnly width="fixed" value={name} />
      <Dropdown value={entry.model} options={options} onChange={(model) => onChange({ ...entry, model })} />
      <RowMark title={error} />
      <IconButton title={entry.enabled ? "Switch off" : "Switch on"} onClick={() => onChange({ ...entry, enabled: !entry.enabled })}>
        {entry.enabled ? <PowerIcon /> : <PowerOffIcon />}
      </IconButton>
    </EditRow>
  );
}

interface SuggesterListProps {
  value: SuggesterEntry[];
  /** What the user changes: the whole list, in the order shown. */
  onChange: (entries: SuggesterEntry[]) => void;
  /** What stands in for a model not offered any more: shown, never saved. */
  onReplaceModel: (agentId: AgentId) => void;
  /** The models' listing underway, on the dialog's bar (as `PromptFields.hold`): it asks the agent,
   *  changes nothing and its late answer is dropped, so it holds no Cancel. */
  hold: (held: boolean) => void;
}

/**
 * The installed agents that can suggest, in the order they are asked until one answers
 * (`suggestersFor`, as the commit prompt's suggestion takes them): dragged into place, each with its
 * model and a switch that leaves it unasked.
 */
export function SuggesterList({ value, onChange, onReplaceModel, hold }: SuggesterListProps) {
  const agents = useAgents();
  const [askable, setAskable] = useState<AgentId[]>();

  useEffect(() => {
    let cancelled = false;
    void window.tet.agents.askable().then((ids) => {
      if (!cancelled) {
        setAskable(ids);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = suggestersFor(value, askable ?? []);
  const change = (changed: SuggesterEntry): void => onChange(entries.map((entry) => (entry.agentId === changed.agentId ? changed : entry)));

  return (
    <RowSection
      label="Suggested by, in order"
      rows={entries.map((entry) => ({ id: entry.agentId, entry }))}
      reorder={{ dragType: DRAG_TYPE, onMove: (from, to) => onChange(reorder(entries, from, to)) }}
      renderRow={({ id, entry }, drag) => (
        <SuggesterRow
          key={id}
          entry={entry}
          name={agentName(agents, id)}
          reorder={drag}
          onChange={change}
          onReplaceModel={onReplaceModel}
          hold={hold}
        />
      )}
    />
  );
}
