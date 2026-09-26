import { memo, useCallback, useEffect, useRef, useState } from "react";
import { isWorking } from "../../shared/types";
import type { AgentId, AgentInfo, ProjectRef, TerminalDescriptor } from "../../shared/types";
import { fitTerminal, focusTerminal, hideTerminal, showTerminal } from "./terminal-views";
import { PANE_LABELS, PRESET_PANES, TAB_DRAG_TYPE } from "./pane-layout";
import type { PaneId, SplitPreset } from "./pane-layout";
import { AgentIcon } from "../ui/agent-icons";
import { ContextMenu, SEPARATOR, useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { askName, refusal } from "../ui/Dialog";
import { baseName } from "../files/explorer-tree";
import { TerminalHost } from "./TerminalHost";
import { isEditorTab, isEditorTabId, type PaneTab } from "./editor-tab";
import { EditorHost, useEditorBusy, useEditorPreview } from "../diff/EditorHost";
import { getEditorSnapshot, keepEditor } from "../diff/editor-views";
import { CloseIcon, FilesIcon, GearIcon, GitIcon, PlusIcon } from "../ui/icons";
import { SessionMark } from "../ui/SessionMark";
import { ProgressBar } from "../ui/ProgressBar";

/** A window-edge drag fires dozens of observations; every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;
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

/** The side pane's view: one of two, never both. */
export type SideView = "git" | "files";

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
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  const tabMenu = useContextMenu<string>();
  const closeTabMenu = tabMenu.close;
  const stack = useRef<HTMLDivElement>(null);
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

  // An editor tab has no pty and focuses and measures itself (`EditorHost`).
  const activeTerminalId = activeTabId !== null && isEditorTabId(activeTabId) ? null : activeTabId;
  const editorBusy = useEditorBusy(at, tabs);

  // Refit on becoming visible: hidden, its size went stale. The resize also starts its process.
  // Shown before the fit, since the renderer decides the cell width the fit measures
  // (`showTerminal`).
  useEffect(() => {
    if (!visible || !activeTerminalId) {
      return;
    }
    showTerminal(at, activeTerminalId);
    fitTerminal(at, activeTerminalId);
    return () => hideTerminal(at, activeTerminalId);
  }, [visible, activeTerminalId, at]);

  // Keyboard focus follows the focused pane's active tab — only that pane's, or the last effect
  // wins. Apart from the refit: a focus change alone must not resize the pty (repaints the CLI).
  //
  // A new tab is activated before its push arrives, with no view yet. `activeTabReady` retriggers
  // once it is in `tabs`, without unrelated tab updates stealing focus back.
  const activeTabReady = activeTerminalId !== null && tabs.some((tab) => tab.tabId === activeTerminalId);
  useEffect(() => {
    if (visible && focused && activeTerminalId) {
      focusTerminal(at, activeTerminalId);
    }
  }, [visible, focused, activeTerminalId, at, activeTabReady]);

  useEffect(() => {
    const element = stack.current;
    if (!element) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only the debounced pty resize, never an immediate local reflow: xterm reflowed ahead of the
    // pty has a CLI's redraw land on a ConPTY buffer reflowed for a size it doesn't know yet
    // (`fitTerminal`). The trade: a dragged sash shows background until it settles.
    const observer = new ResizeObserver(() => {
      if (!visible || !activeTerminalId) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => fitTerminal(at, activeTerminalId), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, activeTerminalId, at]);

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

  const agentName = (agentId: AgentId): string =>
    agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;

  /** The session title; a session-less agent's name; the editor tab's file name. */
  const tabLabel = (tab: PaneTab): string => {
    if (isEditorTab(tab)) {
      return baseName(tab.path);
    }
    if (tab.title) {
      return tab.title;
    }
    return agents.find((agent) => agent.id === tab.agentId)?.hasSessions === false
      ? agentName(tab.agentId)
      : "New session";
  };

  const tabTooltip = (tab: PaneTab): string => {
    if (isEditorTab(tab)) {
      return tab.path;
    }
    const lines =
      tab.status === "missing"
        ? [`${agentName(tab.agentId)} was not found — install it and reopen the project`]
        : [`${agentName(tab.agentId)}${tab.title ? `: ${tab.title}` : ""}`];
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
   * Restart, the close actions, rename, and the moves to sibling panes. A close with nothing to
   * close is disabled. An editor tab gets "Keep Open" while a preview, the close actions and the
   * moves.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = tabs.map((tab) => tab.tabId);
    const terminal = tabs.find((tab): tab is TerminalDescriptor => tab.tabId === tabId && !isEditorTab(tab));
    const renamable = terminal?.sessionId !== undefined ? terminal : undefined;
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
    return [
      {
        label: "Restart",
        run: restartable ? () => restartTab(tabId) : undefined
      },
      SEPARATOR,
      ...closeEntries,
      SEPARATOR,
      // No persisted session, nothing to rename: the host would revert the label.
      {
        label: "Rename...",
        run: renamable ? () => void askRename(renamable) : undefined
      },
      ...moveEntries
    ];
  };

  // Built only while the menu is open: a pane re-renders on every tab push, and icons are elements.
  const newSessionEntries = (): ContextMenuEntry[] =>
    agents.map((agent) => ({
      label: agent.displayName,
      icon: <AgentIcon agentId={agent.id} className="tab-icon" />,
      run: () => void createTab(agent.id)
    }));

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
            <button
              className={`icon-button${chrome.sideView === "git" ? " active" : ""}`}
              onClick={() => chrome.onToggleSideView("git")}
              title={chrome.sideView === "git" ? "Hide the repository" : "Show the repository"}
            >
              <GitIcon />
            </button>
            <button
              className={`icon-button${chrome.sideView === "files" ? " active" : ""}`}
              onClick={() => chrome.onToggleSideView("files")}
              title={chrome.sideView === "files" ? "Hide the files" : "Show the files"}
            >
              <FilesIcon />
            </button>
            <button className="icon-button" title="Settings" onClick={chrome.onOpenSettings}>
              <GearIcon />
            </button>
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
              onDoubleClick={() => !isEditorTab(tab) && tab.sessionId !== undefined && void askRename(tab)}
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
              <button
                className="icon-button"
                title={
                  isEditorTab(tab)
                    ? "Close file"
                    : tab.sessionId !== undefined
                      ? "Close tab and delete its session"
                      : "Close tab"
                }
                onClick={(event) => {
                  event.stopPropagation();
                  closeTabs([tab.tabId]);
                }}
              >
                <CloseIcon />
              </button>
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
            onMouseDown={(event) => {
              event.stopPropagation();
              // The menu's capture-phase outside-click handler already closed it; don't reopen.
              if (plusMenu) {
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setPlusMenu({ x: rect.left, y: rect.bottom + 6 });
            }}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="terminal-stack" ref={stack}>
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
              agent={agents.find((agent) => agent.id === tab.agentId)}
              active={tab.tabId === activeTabId}
              visible={visible}
            />
          )
        )}
        {tabs.length === 0 && <div className="placeholder">No sessions open.</div>}
      </div>

      {tabMenuOpen && tabMenu.render(tabMenuEntries)}
      {plusMenu && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          entries={newSessionEntries()}
          onClose={() => setPlusMenu(null)}
          className="new-session-menu"
        />
      )}
    </div>
  );
});
