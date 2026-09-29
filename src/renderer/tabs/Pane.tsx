import { memo, useCallback, useEffect, useRef } from "react";
import { isWorking } from "../../shared/types/terminals";
import type { SideView } from "../ui/use-side-pane";
import type { AgentId, AgentInfo } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type { TerminalDescriptor } from "../../shared/types/terminals";
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
import { isEditorTab, isEditorTabId, type PaneTab } from "../editor/editor-tab";
import { EditorHost, useEditorBusy, useEditorPreview } from "../editor/EditorHost";
import { getEditorSnapshot, keepEditor } from "../editor/editor-views";
import { IconButton } from "../ui/IconButton";
import { CloseIcon, FilesIcon, GearIcon, GitIcon, PlusIcon } from "../ui/icons";
import { SessionMark } from "../ui/SessionMark";
import { ProgressBar } from "../ui/ProgressBar";

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

/** The one row of icon buttons, on pane "a" alone whatever the preset. */
export interface PaneChrome {
  /** Null while the side pane is in. */
  sideView: SideView | null;
  onToggleSideView: (view: SideView) => void;
  onOpenSettings: () => void;
}

interface PaneProps {
  at: ProjectRef;
  paneId: PaneId;
  /** The project's preset, for this pane's "move to" siblings. */
  preset: SplitPreset;
  /** This pane's tabs in project order, the editor tabs last. */
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
  /** Only on pane "a". */
  chrome?: PaneChrome;
  /** One of this pane's tabs starting, or — only where `chrome` is — a project-wide reason. */
  showProgress: boolean;
  /**
   * Pixels: one of the two for a divider-sized pane, neither for the filling one. Numbers, not a
   * style object, so the memo sees an unchanged size as the same prop.
   */
  width?: number;
  height?: number;
  /** Whether the drop would land here — `TerminalsPane` decides. */
  dragOver: boolean;
  onDragStart: (paneId: PaneId) => void;
  onDragOverChange: (paneId: PaneId, position: DragPosition | null) => void;
  onDropTab: (paneId: PaneId, tabId: string) => void;
  onDragEnd: () => void;
}

/** A dragged tab's pointer over a pane, and whether it is over the tab strip. */
export interface DragPosition {
  x: number;
  y: number;
  overStrip: boolean;
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
  chrome,
  showProgress,
  dragOver,
  onDragStart,
  onDragOverChange,
  onDropTab,
  onDragEnd
}: PaneProps) {
  const plusMenu = useAnchoredMenu((rect) => ({ x: rect.left, y: rect.bottom + 6 }));
  const tabMenu = useContextMenu<string>();
  const closeTabMenu = tabMenu.close;
  const strip = useRef<HTMLDivElement>(null);
  const tabElements = useRef(new Map<string, HTMLDivElement>());

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
      const descriptor = await window.tet.terminals.create(at, agentId);
      onActivate(descriptor.tabId, paneId);
    },
    [at, paneId, onActivate]
  );

  /**
   * Editor tabs close in the renderer, the rest in main. Their unsaved-edit question may keep them
   * open while the same "Close All"'s terminals go.
   */
  const closeTabs = useCallback(
    (tabIds: string[]) => {
      const editorIds = tabIds.filter(isEditorTabId);
      const terminalIds = tabIds.filter((tabId) => !isEditorTabId(tabId));
      if (editorIds.length > 0) {
        onCloseEditors(editorIds);
      }
      if (terminalIds.length > 0) {
        void window.tet.terminals.close(at, terminalIds);
      }
    },
    [at, onCloseEditors]
  );

  const restartTab = useCallback(
    (tabId: string) => void window.tet.terminals.restart(at, tabId),
    [at]
  );

  /** The new tab opens beside this one; no question is up to show a refusal, so it is a notice. */
  const handOff = useCallback(
    async (tabId: string, agentId: AgentId) => {
      const result = await window.tet.terminals.handOff(at, tabId, agentId);
      if (result.tab) {
        onActivate(result.tab.tabId, paneId);
      } else {
        notify("error", result.error ?? "Could not hand the session over");
      }
    },
    [at, paneId, onActivate]
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
    async (tab: TerminalDescriptor) => {
      await askName({
        title: "Rename session",
        current: tab.title,
        confirmLabel: "Rename",
        maxLength: MAX_TITLE_LENGTH,
        submit: async (name) =>
          refusal(await window.tet.terminals.rename(at, tab.tabId, name), "Could not rename the session")
      });
    },
    [at]
  );

  /** The session title; a session-less agent's name; the editor tab's file name. */
  const tabLabel = (tab: PaneTab): string => {
    if (isEditorTab(tab)) {
      return baseName(tab.path);
    }
    if (tab.title) {
      return tab.title;
    }
    return agentInfo(agents, tab.agentId)?.hasSessions === false
      ? agentName(agents, tab.agentId)
      : "New session";
  };

  const tabTooltip = (tab: PaneTab): string => {
    if (isEditorTab(tab)) {
      return tab.path;
    }
    const lines =
      tab.status === "missing"
        ? [`${agentName(agents, tab.agentId)} was not found — install it and reopen the project`]
        : [`${agentName(agents, tab.agentId)}${tab.title ? `: ${tab.title}` : ""}`];
    if (tab.createdAt) {
      lines.push(`Created: ${formatIso(tab.createdAt)}`);
    }
    if (tab.updatedAt) {
      lines.push(`Updated: ${formatIso(tab.updatedAt)}`);
    }
    return lines.join("\n");
  };

  const siblingPanes = PRESET_PANES[preset].filter((id) => id !== paneId);

  /**
   * Restart, Clear for the shell, the close actions, rename and hand-over for an agent with sessions, and the moves
   * to sibling panes. A close with nothing to close is disabled. An editor tab gets "Keep Open" while a preview, the close actions and the
   * moves.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = tabs.map((tab) => tab.tabId);
    const terminal = tabs.find((tab): tab is TerminalDescriptor => tab.tabId === tabId && !isEditorTab(tab));
    const withSession = terminal?.sessionId !== undefined ? terminal : undefined;
    // A saved command restarts anytime; an agent once started — a running one quits first and its
    // session resumes (restartTab), so it takes up what was saved meanwhile (RestartNote).
    const restartable =
      terminal !== undefined &&
      (terminal.savedCommand === true ||
        terminal.status === "running" ||
        terminal.status === "stopped" ||
        terminal.status === "error");
    const closeAction = (label: string, targets: string[]): ContextMenuEntry => ({
      label,
      run: targets.length > 0 ? () => closeTabs(targets) : undefined
    });
    const moveEntries: ContextMenuEntry[] =
      siblingPanes.length > 0
        ? [
            SEPARATOR,
            ...siblingPanes.map(
              (target): ContextMenuEntry => ({
                label: `Move to ${PANE_LABELS[preset][target]}`,
                run: () => onActivate(tabId, target)
              })
            )
          ]
        : [];
    const closeEntries: ContextMenuEntry[] = [
      closeAction("Close", [tabId]),
      closeAction("Close Others", ids.filter((id) => id !== tabId)),
      closeAction("Close to the Right", ids.slice(ids.indexOf(tabId) + 1)),
      closeAction("Close All", ids)
    ];
    if (!terminal) {
      return [
        // VS Code's wording; a kept tab has nothing to keep.
        { label: "Keep Open", run: getEditorSnapshot(tabId).preview ? () => keepEditor(tabId) : undefined },
        SEPARATOR,
        ...closeEntries,
        ...moveEntries
      ];
    }
    // Rename and hand-over act on a session: an agent that keeps none never offers them.
    const hasSessions = agentInfo(agents, terminal.agentId)?.hasSessions === true;
    // Every other agent that starts on a prompt — the shell takes none; nothing to hand over
    // before the session is persisted.
    const handOffAgents = agents.filter((agent) => agent.takesPrompt && agent.id !== terminal.agentId);
    const handOffEntries: ContextMenuEntry[] =
      hasSessions && handOffAgents.length > 0
        ? [
            SEPARATOR,
            ...handOffAgents.map(
              (agent): ContextMenuEntry => ({
                label: `Hand over to ${agent.displayName}`,
                icon: <AgentIcon agentId={agent.id} className="tab-icon" />,
                run: withSession ? () => void handOff(withSession.tabId, agent.id) : undefined
              })
            )
          ]
        : [];
    return [
      {
        label: "Restart",
        run: restartable ? () => restartTab(tabId) : undefined
      },
      // Plain line output only (AgentInfo.clearable): an agent's TUI would not redraw what was wiped.
      ...(agentInfo(agents, terminal.agentId)?.clearable === true
        ? [{ label: "Clear", run: () => clearTerminalOutput(at, tabId) }]
        : []),
      SEPARATOR,
      ...closeEntries,
      ...(hasSessions
        ? ([
            SEPARATOR,
            // No persisted session, nothing to rename: the host would revert the label.
            {
              label: "Rename...",
              run: withSession ? () => void askRename(withSession) : undefined
            }
          ] satisfies ContextMenuEntry[])
        : []),
      ...handOffEntries,
      ...moveEntries
    ];
  };

  // Built only while the menu is open: a pane re-renders on every tab push, and icons are elements.
  const newSessionEntries = (): ContextMenuEntry[] =>
    agents.map((agent) => agentEntry(agent, () => void createTab(agent.id)));

  return (
    <div
      className={`terminal-pane${width === undefined && height === undefined ? " fill" : ""}${dragOver ? " drag-over" : ""}`}
      style={width !== undefined ? { width } : height !== undefined ? { height } : undefined}
      // Capture: xterm's mousedown calls stopPropagation() once a TUI turns on mouse tracking.
      onMouseDownCapture={() => onFocus(paneId)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOverChange(paneId, {
          x: event.clientX,
          y: event.clientY,
          overStrip: (event.target as Element).closest(".tab-strip") !== null
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
          return;
        }
        event.preventDefault();
        const dragged = event.dataTransfer.getData(TAB_DRAG_TYPE);
        if (dragged) {
          onDropTab(paneId, dragged);
        } else {
          onDragOverChange(paneId, null);
        }
      }}
      // A cancelled drag fires neither `drop` nor `dragleave` on the previewed pane.
      onDragEnd={onDragEnd}
    >
      <div className="tab-strip">
        {/* Window chrome, on pane "a" alone. */}
        {chrome && (
          <div className="tab-strip-actions">
            <IconButton
              active={chrome.sideView === "git"}
              onClick={() => chrome.onToggleSideView("git")}
              title={chrome.sideView === "git" ? "Hide the repository" : "Show the repository"}
            >
              <GitIcon />
            </IconButton>
            <IconButton
              active={chrome.sideView === "files"}
              onClick={() => chrome.onToggleSideView("files")}
              title={chrome.sideView === "files" ? "Hide the files" : "Show the files"}
            >
              <FilesIcon />
            </IconButton>
            <IconButton title="Settings" onClick={chrome.onOpenSettings}>
              <GearIcon />
            </IconButton>
          </div>
        )}
        <div className="tabs" ref={strip}>
          {tabs.map((tab) => (
            <div
              key={tab.tabId}
              ref={(element) => {
                if (element) {
                  tabElements.current.set(tab.tabId, element);
                } else {
                  tabElements.current.delete(tab.tabId);
                }
              }}
              className={`tab${tab.tabId === activeTabId ? " active" : ""}${!isEditorTab(tab) && tab.status === "stopped" ? " inactive" : ""}`}
              // Always: even the only pane has the snap zones to drop on.
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_DRAG_TYPE, tab.tabId);
                event.dataTransfer.effectAllowed = "move";
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
              title={tabTooltip(tab)}
            >
              {/* The mark takes the agent icon's place, ranked error/missing > waiting > working
                  > finished ("Turns and session marks" in AGENTS.md). */}
              {isEditorTab(tab) ? (
                <FilesIcon className="tab-icon" />
              ) : tab.status === "missing" || tab.status === "error" ? (
                <SessionMark kind="error" className="tab-icon" />
              ) : waitingTabIds.includes(tab.tabId) ? (
                <SessionMark kind="waiting" className="tab-icon" />
              ) : isWorking(tab) ? (
                // A question hidden on the tab in front (left out of `waitingTabIds`) gets no
                // spinner: a session stopped on a question is not working.
                <SessionMark kind="working" className="tab-icon" />
              ) : finishedTabIds.includes(tab.tabId) ? (
                <SessionMark kind="finished" className="tab-icon" />
              ) : (
                <AgentIcon agentId={tab.agentId} className="tab-icon" />
              )}
              {isEditorTab(tab) ? (
                <EditorTabLabel tabId={tab.tabId} label={tabLabel(tab)} />
              ) : (
                <span className="tab-label">{tabLabel(tab)}</span>
              )}
              <IconButton
                title={
                  isEditorTab(tab)
                    ? "Close file"
                    : tab.sessionId !== undefined
                      ? "Close tab and delete its session"
                      : "Close tab"
                }
                isolated
                onClick={() => closeTabs([tab.tabId])}
              >
                <CloseIcon />
              </IconButton>
            </div>
          ))}
        </div>
        {/* This pane's one progress bar: a tab starting, an editor tab busy, or in pane "a" the
            bootstrap session listing. */}
        {(showProgress || editorBusy) && <ProgressBar />}
        <div className="new-tab">
          <button
            className="icon-button"
            title="New session"
            onMouseDown={plusMenu.open}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="terminal-stack">
        {tabs.map((tab) =>
          isEditorTab(tab) ? (
            <EditorHost
              key={tab.tabId}
              tabId={tab.tabId}
              active={tab.tabId === activeTabId}
              visible={visible}
              focused={focused}
            />
          ) : (
            <TerminalHost
              key={tab.tabId}
              at={at}
              tabId={tab.tabId}
              shiftEnter={agentInfo(agents, tab.agentId)?.shiftEnter}
              active={tab.tabId === activeTabId}
              visible={visible}
              focused={focused}
            />
          )
        )}
        {tabs.length === 0 && <div className="placeholder">No sessions open.</div>}
      </div>

      {tabMenuOpen && tabMenu.render(tabMenuEntries)}
      {plusMenu.render(newSessionEntries, "new-session-menu")}
    </div>
  );
});
