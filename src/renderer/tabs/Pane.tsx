import { memo, useCallback, useEffect, useRef } from "react";
import { isWorking } from "../../shared/types/terminals";
import type { AgentId, AgentInfo } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";
import { PANE_LABELS, PRESET_PANES, TAB_DRAG_TYPE } from "./pane-layout";
import type { PaneId, SplitPreset } from "./pane-layout";
import { AgentIcon } from "../ui/agent-icons";
import { agentInfo, agentName } from "../ui/use-agents";
import { SEPARATOR, useAnchoredMenu, useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { askName, refusal } from "../ui/Dialog";
import { notify } from "../ui/Notices";
import { baseName } from "../paths";
import { TerminalHost } from "./TerminalHost";
import { clearTerminalOutput } from "./terminal-views";
import { kindOf, paneTabKind, type PaneTab, type PaneTabKind } from "./pane-tab";
import { EditorHost, useEditorBusy, useEditorPreview } from "../editor/EditorHost";
import { getEditorSnapshot, keepEditor } from "../editor/editor-views";
import { IconButton } from "../ui/IconButton";
import { CloseIcon, FilesIcon, PlusIcon, ShieldIcon } from "../ui/icons";
import { TabMark } from "../ui/TabMark";
import { ProgressBar } from "../ui/ProgressBar";
import { useDragReorder } from "../ui/drag-reorder";

/** What VS Code's own tab rename accepts. */
const MAX_TITLE_LENGTH = 50;

/** Local ISO 8601 date/time to the second, space instead of "T". */
function formatIso(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** An agent as a menu entry: its icon, then its name. */
function agentEntry(agent: AgentInfo, run: () => void): ContextMenuEntry {
  return { label: agent.displayName, icon: <AgentIcon agentId={agent.id} className="tab-icon" />, run };
}

interface PaneProps {
  at: ProjectRef;
  paneId: PaneId;
  /** The project's preset, for this pane's "move to" siblings. */
  preset: SplitPreset;
  /** This pane's tabs in the strip's order (`inOrder`). */
  tabs: PaneTab[];
  activeTabId: string | null;
  agents: AgentInfo[];
  visible: boolean;
  /** Where keyboard focus goes on showing this repository or worktree, or on changing the active
   *  tab; not drawn. */
  focused: boolean;
  /** Shows a tab; in another pane, moves it there. */
  onActivate: (tabId: string, paneId: PaneId) => void;
  onFocus: (paneId: PaneId) => void;
  /** Editor tabs are renderer-only, unknown to `terminals.close`. */
  onCloseEditors: (tabIds: string[]) => void;
  finishedTabIds: string[];
  waitingTabIds: string[];
  /** One of this pane's tabs starting, or — only on pane "a" — a project-wide reason. */
  busy: boolean;
  /**
   * Pixels: one of the two for a sash-sized pane, neither for the filling one. Numbers, not a
   * style object, so the memo sees an unchanged size as the same prop.
   */
  width?: number;
  height?: number;
  /** Whether the drop would land here — `TabArea` decides. */
  dragOver: boolean;
  onDragStart: (paneId: PaneId) => void;
  onDragOverChange: (paneId: PaneId, position: DragPosition | null) => void;
  /** A tab moved to a pane — dropped, or by "Move to": on the strip with the tab it goes before
   *  (`before`, undefined for the end), anywhere else without (`TabArea` places it). */
  onMoveTab: (paneId: PaneId, tabId: string, strip?: { before: string | undefined }) => void;
  onDragEnd: () => void;
}

/** A dragged tab's pointer over a pane, and whether it is over the tab strip. */
export interface DragPosition {
  x: number;
  y: number;
  overStrip: boolean;
}

/** What the strip draws of one tab (faceOf). */
interface TabFace {
  label: React.ReactNode;
  tooltip: string;
  icon: React.ReactNode;
  /** Runs in an sbx sandbox: the shield badge. */
  sandboxed: boolean;
  /** A stopped terminal, drawn dimmed. */
  inactive: boolean;
  closeTitle: string;
}

/** An editor tab's label, in italics while it is the preview — the editor's own state. */
const EditorTabLabel = memo(function EditorTabLabel({ tabId, label }: { tabId: string; label: string }) {
  const preview = useEditorPreview(tabId);
  return <span className={`tab-label${preview ? " preview" : ""}`}>{label}</span>;
});

export const Pane = memo(function Pane({
  at,
  paneId,
  preset,
  tabs,
  activeTabId,
  agents,
  visible,
  focused,
  width,
  height,
  onActivate,
  onFocus,
  onCloseEditors,
  finishedTabIds,
  waitingTabIds,
  busy,
  dragOver,
  onDragStart,
  onDragOverChange,
  onMoveTab,
  onDragEnd,
}: PaneProps) {
  const plusMenu = useAnchoredMenu((rect) => ({ x: rect.left, y: rect.bottom + 6 }));
  const tabMenu = useContextMenu<string>();
  const closeTabMenu = tabMenu.close;
  const strip = useRef<HTMLDivElement>(null);
  const tabElements = useRef(new Map<string, HTMLDivElement>());
  const focusHere = useCallback(() => onFocus(paneId), [onFocus, paneId]);
  // The tab's own drag: the same type the panes and snap zones take, so the one drag reorders,
  // moves and snaps. A drop on the strip is taken here, the pane's own handler leaving it be; one
  // where the tab stands already only shows it.
  const tabDrag = useDragReorder({
    dragType: TAB_DRAG_TYPE,
    count: tabs.length,
    payloadOf: (index) => tabs[index].tabId,
    indexOf: (tabId) => tabs.findIndex((tab) => tab.tabId === tabId),
    onMove: (from, to) => onMoveTab(paneId, tabs[from].tabId, to === from || to === from + 1 ? undefined : { before: tabs[to]?.tabId }),
    onTake: (tabId, to) => onMoveTab(paneId, tabId, { before: tabs[to]?.tabId }),
    halves: true,
  });

  // The wheel scrolls the strip horizontally. By hand: preventDefault needs a non-passive listener.
  useEffect(() => {
    const element = strip.current;
    if (!element) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      // Scrolling moves the menu's tab out from under it.
      closeTabMenu();
      if (event.deltaY !== 0) {
        event.preventDefault();
        element.scrollLeft += event.deltaY;
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [closeTabMenu]);

  // A new or newly activated tab can land past the strip's visible width.
  useEffect(() => {
    if (!activeTabId) {
      return;
    }
    tabElements.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  const editorBusy = useEditorBusy(at, tabs);
  const createTab = useCallback(
    async (agentId: AgentId) => {
      const descriptor = await window.tet.tabs.create(at, agentId);
      onActivate(descriptor.tabId, paneId);
    },
    [at, paneId, onActivate],
  );

  /**
   * Editor tabs close in the renderer, terminals in main. Their unsaved-edit question may keep them
   * open while the same "Close All"'s terminals go — deleting their sessions for good.
   */
  const closeTabs = useCallback(
    (tabIds: string[]) => {
      const byKind: Record<PaneTabKind, string[]> = { terminal: [], editor: [] };
      for (const tabId of tabIds) {
        byKind[paneTabKind(tabId)].push(tabId);
      }
      if (byKind.editor.length > 0) {
        onCloseEditors(byKind.editor);
      }
      if (byKind.terminal.length > 0) {
        void window.tet.tabs.close(at, byKind.terminal);
      }
    },
    [at, onCloseEditors],
  );

  const restartTab = useCallback((tabId: string) => void window.tet.tabs.restart(at, tabId), [at]);

  /** The tab menu's Archive: keeps the session, to the ARCHIVE lane. */
  const archiveTab = useCallback((tabId: string) => void window.tet.tabs.archive(at, [tabId]), [at]);

  /** The new tab opens beside this one; no question is up to show a refusal, so it is a notice. */
  const handOver = useCallback(
    async (tabId: string, agentId: AgentId) => {
      const result = await window.tet.tabs.handOver(at, tabId, agentId);
      if (result.tab) {
        onActivate(result.tab.tabId, paneId);
      } else {
        notify("error", result.error ?? "Could not hand the session over");
      }
    },
    [at, paneId, onActivate],
  );

  // The menu's tab closed or moved away under it (`tet-ctl`, another pane): its close entries,
  // counted from that tab's index, would close the whole pane. Not drawn until the effect closes it.
  const tabMenuOpen = tabMenu.target !== undefined && tabs.some((tab) => tab.tabId === tabMenu.target);
  useEffect(() => {
    if (tabMenu.target !== undefined && !tabMenuOpen) {
      closeTabMenu();
    }
  }, [tabMenu.target, tabMenuOpen, closeTabMenu]);

  const askRename = useCallback(
    async (tab: TabDescriptor) => {
      await askName({
        title: "Rename session",
        current: tab.title,
        confirmLabel: "Rename",
        maxLength: MAX_TITLE_LENGTH,
        submit: async (name) => refusal(await window.tet.tabs.rename(at, tab.tabId, name), "Could not rename the session"),
      });
    },
    [at],
  );

  /**
   * What the strip draws of a tab, by its kind. A terminal's icon gives way to its mark, ranked
   * error/missing > waiting > working > finished ("Turns and tab marks" in AGENTS.md); the sandbox's
   * badge goes over the mark too, as where a tab runs outlasts its turn.
   */
  const faceOf = (tab: PaneTab): TabFace => {
    const kinded = kindOf(tab);
    switch (kinded.kind) {
      case "editor": {
        const { path, commit } = kinded.tab;
        const suffix = commit ? ` (${commit.sha.slice(0, 7)})` : "";
        return {
          label: <EditorTabLabel tabId={tab.tabId} label={baseName(path) + suffix} />,
          tooltip: path + suffix,
          icon: <FilesIcon className="tab-icon" />,
          sandboxed: false,
          inactive: false,
          closeTitle: "Close file",
        };
      }
      case "terminal": {
        const terminal = kinded.tab;
        const name = agentName(agents, terminal.agentId);
        const tooltip =
          terminal.status === "missing"
            ? [`${name} was not found — install it and reopen the project`]
            : [`${name}${terminal.title ? `: ${terminal.title}` : ""}`];
        if (terminal.createdAt) {
          tooltip.push(`Created: ${formatIso(terminal.createdAt)}`);
        }
        if (terminal.updatedAt) {
          tooltip.push(`Updated: ${formatIso(terminal.updatedAt)}`);
        }
        return {
          // The session title; a session-less agent's name.
          label: (
            <span className="tab-label">
              {terminal.title || (agentInfo(agents, terminal.agentId)?.hasSessions === false ? name : "New session")}
            </span>
          ),
          tooltip: tooltip.join("\n"),
          icon:
            terminal.status === "missing" || terminal.status === "error" ? (
              <TabMark kind="error" className="tab-icon" />
            ) : waitingTabIds.includes(terminal.tabId) ? (
              <TabMark kind="waiting" className="tab-icon" />
            ) : isWorking(terminal) ? (
              // A question hidden on the tab on screen (left out of `waitingTabIds`) gets no
              // spinner: a session stopped on a question is not working.
              <TabMark kind="working" className="tab-icon" />
            ) : finishedTabIds.includes(terminal.tabId) ? (
              <TabMark kind="finished" className="tab-icon" />
            ) : (
              <AgentIcon agentId={terminal.agentId} className="tab-icon" />
            ),
          sandboxed: terminal.sandboxed === true,
          inactive: terminal.status === "stopped",
          closeTitle: "Close tab",
        };
      }
    }
  };

  const siblingPanes = PRESET_PANES[preset].filter((id) => id !== paneId);

  /**
   * Restart, Clear for the shell, the close actions, rename, archive and hand-over for an agent
   * with sessions, and the moves to sibling panes. A close with nothing to close is disabled. An
   * editor tab gets "Keep Open" while a preview, the close actions and the moves.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = tabs.map((tab) => tab.tabId);
    const menuTab = tabs.find((tab) => tab.tabId === tabId);
    const closeAction = (label: string, targets: string[]): ContextMenuEntry => ({
      label,
      run: targets.length > 0 ? () => closeTabs(targets) : undefined,
    });
    const moveEntries: ContextMenuEntry[] =
      siblingPanes.length > 0
        ? [
            SEPARATOR,
            ...siblingPanes.map((target): ContextMenuEntry => ({
              label: `Move to ${PANE_LABELS[preset][target]}`,
              run: () => onMoveTab(target, tabId),
            })),
          ]
        : [];
    const closeEntries: ContextMenuEntry[] = [
      closeAction("Close", [tabId]),
      closeAction(
        "Close Others",
        ids.filter((id) => id !== tabId),
      ),
      closeAction("Close All", ids),
    ];
    const kinded = menuTab && kindOf(menuTab);
    if (kinded?.kind !== "terminal") {
      return kinded?.kind === "editor"
        ? [
            // VS Code's wording; a kept tab has nothing to keep.
            { label: "Keep Open", run: getEditorSnapshot(tabId).preview ? () => keepEditor(tabId) : undefined },
            SEPARATOR,
            ...closeEntries,
            ...moveEntries,
          ]
        : [...closeEntries, ...moveEntries];
    }
    const terminal = kinded.tab;
    const withSession = terminal.sessionId !== undefined ? terminal : undefined;
    // A saved command restarts anytime; an agent once started — a running one quits first and its
    // session resumes (restartTab), so it takes up what was saved meanwhile (RestartNote).
    const restartable =
      terminal.savedCommand === true || terminal.status === "running" || terminal.status === "stopped" || terminal.status === "error";
    const info = agentInfo(agents, terminal.agentId);
    // Rename and hand-over act on a session: an agent that keeps none never offers them.
    const hasSessions = info?.hasSessions === true;
    // Every other agent that starts on a prompt — the shell takes none; nothing to hand over
    // before the session is persisted.
    const handOverAgents = agents.filter((agent) => agent.takesPrompt && agent.id !== terminal.agentId);
    const handOverEntries: ContextMenuEntry[] =
      hasSessions && handOverAgents.length > 0
        ? [
            SEPARATOR,
            ...handOverAgents.map((agent): ContextMenuEntry => ({
              label: `Hand over to ${agent.displayName}`,
              icon: <AgentIcon agentId={agent.id} className="tab-icon" />,
              run: withSession ? () => void handOver(withSession.tabId, agent.id) : undefined,
            })),
          ]
        : [];
    return [
      {
        label: "Restart",
        run: restartable ? () => restartTab(tabId) : undefined,
      },
      // Plain line output only (AgentInfo.clearable): an agent's TUI would not redraw what was wiped.
      ...(info?.clearable === true ? [{ label: "Clear", run: () => clearTerminalOutput(at, tabId) }] : []),
      SEPARATOR,
      ...closeEntries,
      ...(hasSessions
        ? ([
            SEPARATOR,
            // No persisted session, nothing to rename: the host would revert the label.
            {
              label: "Rename...",
              run: withSession ? () => void askRename(withSession) : undefined,
            },
            // Unlike Close, keeps the session.
            { label: "Archive", run: () => archiveTab(tabId) },
          ] satisfies ContextMenuEntry[])
        : []),
      ...handOverEntries,
      ...moveEntries,
    ];
  };

  // Built only while the menu is open: a pane re-renders on every tab push, and icons are elements.
  const newTabEntries = (): ContextMenuEntry[] => agents.map((agent) => agentEntry(agent, () => void createTab(agent.id)));

  return (
    <div
      className={`pane${width === undefined && height === undefined ? " fill" : ""}${dragOver ? " drag-over" : ""}`}
      style={width !== undefined ? { width } : height !== undefined ? { height } : undefined}
      // Capture: xterm's mousedown calls stopPropagation() once a TUI turns on mouse tracking.
      onMouseDownCapture={focusHere}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOverChange(paneId, {
          x: event.clientX,
          y: event.clientY,
          overStrip: (event.target as Element).closest(".tab-strip") !== null,
        });
      }}
      onDragLeave={(event) => {
        // Also fires for children; only leaving the pane itself counts.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDragOverChange(paneId, null);
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) {
          // A terminal took it and has the focus now (terminal-views.ts); its pane follows, as on a click.
          if ((event.target as Element).closest(".terminal-host") !== null) {
            focusHere();
          }
          return;
        }
        // The strip took it (`tabDrag`).
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        const dragged = event.dataTransfer.getData(TAB_DRAG_TYPE);
        if (dragged) {
          onMoveTab(paneId, dragged);
        } else {
          onDragOverChange(paneId, null);
        }
      }}
      // A cancelled drag fires neither `drop` nor `dragleave` on the previewed pane.
      onDragEnd={onDragEnd}
    >
      {/* The strip's free space is the end of its tabs. */}
      <div className="tab-strip" {...tabDrag.listProps}>
        <div className="tabs" ref={strip}>
          {tabs.map((tab, index) => {
            const face = faceOf(tab);
            const drag = tabDrag.rowProps(index);
            return (
              <div
                key={tab.tabId}
                ref={(element) => {
                  if (element) {
                    tabElements.current.set(tab.tabId, element);
                  } else {
                    tabElements.current.delete(tab.tabId);
                  }
                }}
                className={[
                  "tab",
                  ...(tab.tabId === activeTabId ? ["active"] : []),
                  ...(face.inactive ? ["inactive"] : []),
                  ...tabDrag.rowClasses(index),
                ].join(" ")}
                // Always: even the only pane has the snap zones to drop on.
                {...drag}
                onDragStart={(event) => {
                  drag.onDragStart?.(event);
                  onDragStart(paneId);
                }}
                onClick={() => onActivate(tab.tabId, paneId)}
                // Keeps the terminal focused across a right-click: mousedown would blur xterm's
                // textarea to <body>, leaving no typing once the menu closes.
                onMouseDown={(event) => {
                  if (event.button === 2) {
                    event.preventDefault();
                  }
                }}
                onContextMenu={(event) => tabMenu.open(event, tab.tabId)}
                title={face.tooltip}
              >
                <span className="tab-icon-box">
                  {face.icon}
                  {face.sandboxed && (
                    <>
                      <ShieldIcon className="tab-badge-ring" />
                      <ShieldIcon className="tab-badge" />
                    </>
                  )}
                </span>
                {face.label}
                <IconButton title={face.closeTitle} isolated onClick={() => closeTabs([tab.tabId])}>
                  <CloseIcon />
                </IconButton>
              </div>
            );
          })}
        </div>
        {/* This pane's one progress bar: a tab starting, an editor tab busy, or in
            pane "a" the bootstrap session listing. */}
        {(busy || editorBusy) && <ProgressBar />}
        <div className="new-tab">
          <button className="icon-button" title="New tab" onMouseDown={plusMenu.open}>
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="pane-body">
        {tabs.map((tab) => {
          const kinded = kindOf(tab);
          const active = tab.tabId === activeTabId;
          switch (kinded.kind) {
            case "editor":
              return <EditorHost key={tab.tabId} tabId={tab.tabId} active={active} visible={visible} focused={focused} />;
            case "terminal":
              return (
                <TerminalHost
                  key={tab.tabId}
                  at={at}
                  tabId={tab.tabId}
                  shiftEnter={agentInfo(agents, kinded.tab.agentId)?.shiftEnter}
                  labelsDrops={agentInfo(agents, kinded.tab.agentId)?.labelsDrops === true}
                  active={active}
                  visible={visible}
                  focused={focused}
                />
              );
          }
        })}
        {tabs.length === 0 && <div className="placeholder">No tabs open.</div>}
      </div>

      {tabMenuOpen && tabMenu.render(tabMenuEntries)}
      {plusMenu.render(newTabEntries, "new-tab-menu")}
    </div>
  );
});
