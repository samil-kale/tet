import { memo, useState } from "react";
import type { TabDescriptor } from "../../../shared/types/terminals";
import { AgentIcon } from "../../ui/agent-icons";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { askName, confirmed, refusal } from "../../ui/Dialog";
import { FilterField } from "../../ui/FilterField";
import { notify } from "../../ui/Notices";
import { IconButton } from "../../ui/IconButton";
import { ArrowUpIcon, CloseIcon } from "../../ui/icons";
import { Section } from "../../ui/Section";
import { agentName, useAgents } from "../../ui/use-agents";
import { reorder, useDragReorder } from "../../ui/drag-reorder";
import type { ResolvedRef } from "../../resolved-ref";
import { MAX_TITLE_LENGTH } from "../../tabs/Pane";
import { useArchive } from "./use-archive";

const DRAG_TYPE = "application/x-tet-archive";

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
 * The tabs taken off the strip with their sessions kept (`tabs.archive`). A row reopens its tab at
 * the end of the strip, or deletes its session for good. A row drags to reorder the list, newest
 * archived on top otherwise; disabled while filtering. Keyed by repository or worktree by the app.
 */
export const ArchiveList = memo(function ArchiveList({ resolved, shown, onOpenTab }: ArchiveListProps) {
  const agents = useAgents();
  const tabs = useArchive(resolved);
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const shownTabs = tabs.map((tab, index) => ({ tab, index })).filter(({ tab }) => labelOf(tab).toLowerCase().includes(query));
  const menu = useContextMenu<TabDescriptor>();

  const reorderTabs = async (next: TabDescriptor[]): Promise<void> => {
    const result = await window.tet.archive.reorder(
      resolved.ref,
      next.map((tab) => tab.tabId),
    );
    if (!result.ok) {
      notify("error", result.error ?? "Could not reorder the archive");
    }
  };

  // Disabled while filtering: a drag's index is the full list's, and a filtered-out row no longer sits there.
  const reorderable = query === "";
  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: tabs.length,
    // The id, not the position: it survives a list change mid-drag.
    payloadOf: (index) => tabs[index].tabId,
    indexOf: (tabId) => tabs.findIndex((tab) => tab.tabId === tabId),
    onMove: (from, to) => void reorderTabs(reorder(tabs, from, to)),
  });

  const reopen = async (tab: TabDescriptor): Promise<void> => {
    const result = await window.tet.archive.reopen(resolved.ref, tab.tabId);
    if (result.ok) {
      onOpenTab(resolved.refKey, tab.tabId);
    } else {
      notify("error", result.error ?? "Could not reopen the session");
    }
  };

  const askRename = async (tab: TabDescriptor): Promise<void> => {
    await askName({
      title: "Rename session",
      current: tab.title,
      confirmLabel: "Rename",
      maxLength: MAX_TITLE_LENGTH,
      submit: async (name) => refusal(await window.tet.archive.rename(resolved.ref, tab.tabId, name), "Could not rename the session"),
    });
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
    { label: "Rename...", run: () => void askRename(tab) },
    SEPARATOR,
    { label: "Delete...", run: () => void askDelete(tab) },
  ];

  return (
    <div className={`lane-content${shown ? "" : " hidden"}`}>
      <Section title="ARCHIVE" count={tabs.length}>
        <div className="filter-list">
          <FilterField placeholder="Filter archive..." value={filter} onChange={setFilter} />
          <div className="tree" {...(reorderable ? listProps : {})}>
            {shownTabs.map(({ tab, index }) => (
              <div
                key={tab.tabId}
                className={["list-row", "archive-row", ...(reorderable ? rowClasses(index) : [])].join(" ")}
                title={`${agentName(agents, tab.agentId)}${tab.title ? `: ${tab.title}` : ""}`}
                onDoubleClick={() => void reopen(tab)}
                onContextMenu={(event) => menu.open(event, tab)}
                {...(reorderable ? rowProps(index) : {})}
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
