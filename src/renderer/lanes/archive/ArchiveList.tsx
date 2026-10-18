import { memo, useState } from "react";
import type { TabDescriptor } from "../../../shared/types/terminals";
import { AgentIcon } from "../../ui/agent-icons";
import { useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { confirmed } from "../../ui/Dialog";
import { FilterField } from "../../ui/FilterField";
import { notify } from "../../ui/Notices";
import { IconButton } from "../../ui/IconButton";
import { ArrowUpIcon, CloseIcon } from "../../ui/icons";
import { Section } from "../../ui/Section";
import { agentName, useAgents } from "../../ui/use-agents";
import type { ResolvedRef } from "../../resolved-ref";
import { useArchive } from "./use-archive";

interface ArchiveListProps {
  /** The active repository or worktree. */
  resolved: ResolvedRef;
  /** False while another lane stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  /** Brings a reopened tab to front. By `refKey`. */
  onOpenTab: (refKey: string, tabId: string) => void;
}

/** The session title; an agent's own stand-in until the CLI named one. */
function labelOf(tab: TabDescriptor): string {
  return tab.title || "New session";
}

/** The day of its last activity, after the title. */
function lastActive({ updatedAt, createdAt }: TabDescriptor) {
  const at = updatedAt ?? createdAt;
  return at !== undefined && <span className="list-extra">{new Date(at).toLocaleDateString()}</span>;
}

/**
 * The tabs taken off the strip with their sessions kept (`tabs.close`). A row reopens its tab at
 * the end of the strip, or deletes its session for good. Keyed by repository or worktree by the app.
 */
export const ArchiveList = memo(function ArchiveList({ resolved, shown, onOpenTab }: ArchiveListProps) {
  const agents = useAgents();
  const tabs = useArchive(resolved);
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shownTabs = tabs.filter((tab) => labelOf(tab).toLowerCase().includes(query));
  const menu = useContextMenu<TabDescriptor>();

  const reopen = async (tab: TabDescriptor): Promise<void> => {
    const result = await window.tet.archive.reopen(resolved.ref, tab.tabId);
    if (result.ok) {
      onOpenTab(resolved.refKey, tab.tabId);
    } else {
      notify("error", result.error ?? "Could not reopen the session");
    }
  };

  const askDelete = async (tab: TabDescriptor): Promise<void> => {
    const answer = await confirmed({
      title: "Delete session",
      message: `Delete "${labelOf(tab)}"?`,
      detail: `The ${agentName(agents, tab.agentId)} session is deleted for good.`,
      confirmLabel: "Delete",
    });
    if (answer) {
      const result = await window.tet.archive.delete(resolved.ref, tab.tabId);
      if (!result.ok) {
        notify("error", result.error ?? "Could not delete the session");
      }
    }
  };

  const menuEntries = (tab: TabDescriptor): ContextMenuEntry[] => [
    { label: "Reopen", run: () => void reopen(tab) },
    { label: "Delete...", run: () => void askDelete(tab) },
  ];

  return (
    <div className={`lane-content${shown ? "" : " hidden"}`}>
      <Section title="ARCHIVE" count={tabs.length}>
        <div className="explorer-tree">
          <FilterField placeholder="Filter archive..." value={filter} onChange={setFilter} />
          <div className="tree">
            {shownTabs.map((tab) => (
              <div
                key={tab.tabId}
                className="list-row archive-row"
                title={`${agentName(agents, tab.agentId)}${tab.title ? `: ${tab.title}` : ""}`}
                onDoubleClick={() => void reopen(tab)}
                onContextMenu={(event) => menu.open(event, tab)}
              >
                <AgentIcon agentId={tab.agentId} className="tree-icon" />
                <span className="list-main">
                  <span className="list-label">{labelOf(tab)}</span>
                  {lastActive(tab)}
                </span>
                <IconButton title="Reopen session" isolated onClick={() => void reopen(tab)}>
                  <ArrowUpIcon />
                </IconButton>
                <IconButton title="Delete session..." isolated onClick={() => void askDelete(tab)}>
                  <CloseIcon />
                </IconButton>
              </div>
            ))}
          </div>
        </div>
        {menu.render(menuEntries)}
      </Section>
    </div>
  );
});
