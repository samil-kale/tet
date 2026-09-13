import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, AgentInfo, TerminalDescriptor } from "../../shared/types";
import { fitTerminal, focusTerminal } from "./terminal-views";
import { PANE_LABELS, PRESET_PANES, TAB_DRAG_TYPE } from "./pane-layout";
import type { PaneId, SplitPreset } from "./pane-layout";
import { AgentIcon } from "../ui/agent-icons";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { prompt } from "../ui/Dialog";
import { TerminalHost } from "./TerminalHost";
import { EDITOR_TAB_ID, isEditorTab, type PaneTab } from "./editor-tab";
import { EditorHost, useEditorBusy } from "../diff/EditorHost";
import {
  CloseIcon,
  CommentIcon,
  ExclamationIcon,
  FilesIcon,
  GearIcon,
  GitIcon,
  PlusIcon,
  QuestionIcon,
  SpinnerIcon
} from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

/** Dragging the window edge fires dozens of observations, and every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;
/** What VS Code's own tab rename accepts. */
const MAX_TITLE_LENGTH = 50;

/** ISO 8601 date/time, space instead of "T", local time, seconds precision. */
function formatIso(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** The one row of icon buttons, carried by pane "a" alone whatever the preset. */
export interface PaneChrome {
  gitOpen: boolean;
  onToggleGit: () => void;
  onOpenSettings: () => void;
}

interface PaneProps {
  projectId: string;
  paneId: PaneId;
  /** The whole project's preset — needed to know this pane's siblings for "move to". */
  preset: SplitPreset;
  /** Already filtered to this pane, in the project's own tab order — the editor tab last. */
  tabs: PaneTab[];
  activeTabId: string | null;
  agents: AgentInfo[];
  visible: boolean;
  /**
   * The project's focused pane — where keyboard focus goes when the project comes on screen or
   * this pane's active tab changes. Nothing is drawn for it.
   */
  focused: boolean;
  onActivate: (paneId: PaneId, tabId: string) => void;
  onFocus: (paneId: PaneId) => void;
  /** Closes the project's editor tab — a renderer-only tab, not one `terminals.close` knows. */
  onCloseEditor: () => void;
  markedTabIds: string[];
  waitingTabIds: string[];
  /** Present only on pane "a", which carries the project's shared chrome — see `PaneChrome`. */
  chrome?: PaneChrome;
  /** One of this pane's tabs starting, or — only where `chrome` is — a project-wide reason. */
  showProgress: boolean;
  /**
   * This pane's own size within the grid, in pixels — one of the two for a pane a divider sizes,
   * neither for the one that fills what is left. Numbers rather than a style object so the memo
   * above sees a size that has not changed as the same prop.
   */
  width?: number;
  height?: number;
  /**
   * Whether a plain drop would land the dragged tab here. `TerminalsPane` decides; this pane
   * only reports what it sees.
   */
  dragOver: boolean;
  onDragStart: (paneId: PaneId) => void;
  onDragOverChange: (paneId: PaneId, position: DragPosition | null) => void;
  onDropTab: (paneId: PaneId, tabId: string) => void;
  onDragEnd: () => void;
}

/** Where a dragged tab is over a pane: the pointer, and whether it is over the tab strip. */
export interface DragPosition {
  x: number;
  y: number;
  overStrip: boolean;
}

export const Pane = memo(function Pane({
  projectId,
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
  onCloseEditor,
  markedTabIds,
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
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const tabElements = useRef(new Map<string, HTMLDivElement>());

  // The vertical wheel scrolls the tab strip horizontally. Registered by hand because
  // preventDefault needs a non-passive listener, which React's onWheel isn't.
  useEffect(() => {
    const element = strip.current;
    if (!element) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      // Scrolling moves the tab the menu was opened on out from under it.
      setTabMenu(null);
      if (event.deltaY !== 0) {
        event.preventDefault();
        element.scrollLeft += event.deltaY;
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  // A new or newly activated tab can land past the strip's visible width.
  useEffect(() => {
    if (!activeTabId) {
      return;
    }
    tabElements.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  // The editor tab has no pty to fit and focuses itself (`EditorHost`); monaco measures itself.
  const activeTerminalId = activeTabId === EDITOR_TAB_ID ? null : activeTabId;
  const holdsEditor = tabs.some(isEditorTab);
  const editorBusy = useEditorBusy(projectId);

  // Refit whenever the terminal becomes the visible one: while its pane was hidden it had no
  // layout, so its last measured size is stale. The resize is also what starts its process.
  useEffect(() => {
    if (visible && activeTerminalId) {
      fitTerminal(projectId, activeTerminalId);
    }
  }, [visible, activeTerminalId, projectId]);

  // Keyboard focus follows the focused pane's active tab. Only the focused pane's: with several
  // panes each doing this, whichever effect ran last would win. Separate from the refit above —
  // a focus change alone must not resize the pty, which repaints the CLI.
  //
  // A freshly created tab is activated before its own push arrives, so its TerminalHost has not
  // mounted yet and there is no view to focus. `activeTabReady` retriggers this once the tab
  // shows up in `tabs`, without reacting to unrelated tab updates that would steal focus back.
  const activeTabReady = activeTerminalId !== null && tabs.some((tab) => tab.tabId === activeTerminalId);
  useEffect(() => {
    if (visible && focused && activeTerminalId) {
      focusTerminal(projectId, activeTerminalId);
    }
  }, [visible, focused, activeTerminalId, projectId, activeTabReady]);

  useEffect(() => {
    const element = stack.current;
    if (!element) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only ever the debounced pty resize, never an immediate local reflow: reflowing xterm ahead
    // of the pty lets a CLI's own redraw land on a ConPTY buffer already reflowed for a size it
    // does not know about yet (see `fitTerminal`). A dragged sash shows background until it
    // settles; that is the trade.
    const observer = new ResizeObserver(() => {
      if (!visible || !activeTerminalId) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => fitTerminal(projectId, activeTerminalId), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, activeTerminalId, projectId]);

  const createTab = useCallback(
    async (agentId: AgentId) => {
      const descriptor = await window.tet.terminals.create(projectId, agentId);
      onActivate(paneId, descriptor.tabId);
    },
    [projectId, paneId, onActivate]
  );

  /**
   * The editor tab is closed in the renderer, the rest by the main process. Its unsaved-edit
   * question may keep it open while the terminals of the same "Close All" go.
   */
  const closeTabs = useCallback(
    (tabIds: string[]) => {
      const terminalIds = tabIds.filter((tabId) => tabId !== EDITOR_TAB_ID);
      if (terminalIds.length < tabIds.length) {
        onCloseEditor();
      }
      if (terminalIds.length > 0) {
        void window.tet.terminals.close(projectId, terminalIds);
      }
    },
    [projectId, onCloseEditor]
  );

  const restartTab = useCallback(
    (tabId: string) => void window.tet.terminals.restart(projectId, tabId),
    [projectId]
  );

  const closeTabMenu = useCallback(() => setTabMenu(null), []);

  const askRename = useCallback(
    async (tab: TerminalDescriptor) => {
      const answer = await prompt({
        title: "Rename session",
        label: "Name",
        value: tab.title,
        confirmLabel: "Rename",
        maxLength: MAX_TITLE_LENGTH
      });
      if (answer !== null && answer.value !== tab.title) {
        void window.tet.terminals.rename(projectId, tab.tabId, answer.value);
      }
    },
    [projectId]
  );

  const agentName = (agentId: AgentId): string =>
    agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;

  /** Agents label their tab with the session title; a shell tab has no session to name; the
   *  editor tab takes its file's name. */
  const tabLabel = (tab: PaneTab): string => {
    if (isEditorTab(tab)) {
      return tab.path.split("/").at(-1) ?? tab.path;
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
   * The close actions plus rename, and — once this project has more than one pane — where else
   * this tab could live. A close action with nothing to close renders disabled. The editor tab has
   * nothing to restart or rename: its menu is the close and the moves.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = tabs.map((tab) => tab.tabId);
    const terminal = tabs.find((tab): tab is TerminalDescriptor => tab.tabId === tabId && !isEditorTab(tab));
    const renamable = terminal?.sessionId !== undefined ? terminal : undefined;
    // A saved command can be run again whenever; anything else only once its process is gone. A
    // running tab is ended by closing it, not by this.
    const restartable =
      terminal !== undefined &&
      (terminal.savedCommand === true || terminal.status === "stopped" || terminal.status === "error");
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
                run: () => onActivate(target, tabId)
              })
            )
          ]
        : [];
    if (!terminal) {
      return [closeAction("Close", [tabId]), ...moveEntries];
    }
    return [
      {
        label: "Restart",
        run: restartable ? () => restartTab(tabId) : undefined
      },
      SEPARATOR,
      closeAction("Close", [tabId]),
      closeAction(
        "Close Others",
        ids.filter((id) => id !== tabId)
      ),
      closeAction("Close to the Right", ids.slice(ids.indexOf(tabId) + 1)),
      closeAction("Close All", ids),
      SEPARATOR,
      // A tab whose agent hasn't persisted a session yet has nothing to rename: the host would
      // revert the new label.
      {
        label: "Rename...",
        run: renamable ? () => void askRename(renamable) : undefined
      },
      ...moveEntries
    ];
  };

  // Functions like `tabMenuEntries`, built only while their menu is open: a pane re-renders on
  // every tab push, and the icons in these are elements.
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
      // Capture, not bubble: xterm's own mousedown handler calls stopPropagation() once a TUI
      // has turned on mouse tracking (agent CLIs commonly do), so a click inside the terminal
      // would never reach this handler.
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
        // Fires for every tab and button inside the pane too; only leaving the pane itself counts.
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
      // A drag cancelled mid-air fires neither `drop` nor `dragleave` for the pane the preview
      // is over; this clears it.
      onDragEnd={onDragEnd}
    >
      <div className={`tab-strip${chrome?.gitOpen ? " git-open" : ""}`}>
        {/* Window chrome rather than tabs, on pane "a" alone. */}
        {chrome && (
          <div className="tab-strip-actions">
            <button
              className={`icon-button${chrome.gitOpen ? " active" : ""}`}
              onClick={chrome.onToggleGit}
              title={chrome.gitOpen ? "Hide the repository" : "Show the repository"}
            >
              <GitIcon />
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
              onClick={() => onActivate(paneId, tab.tabId)}
              onDoubleClick={() => !isEditorTab(tab) && tab.sessionId !== undefined && void askRename(tab)}
              // Keeps the terminal focused across the right-click: without this, mousedown's
              // default focus handling blurs xterm's textarea (the tab isn't focusable, so focus
              // falls back to <body>) and the user cannot type once the menu closes.
              onMouseDown={(event) => {
                if (event.button === 2) {
                  event.preventDefault();
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({ tabId: tab.tabId, x: event.clientX, y: event.clientY });
              }}
              title={tabTooltip(tab)}
            >
              {/* The mark takes the agent icon's place, ranked error/missing > waiting > working
                  > finished. See "Both ends of a turn" in CLAUDE.md. The editor tab has no turns. */}
              {isEditorTab(tab) ? (
                <FilesIcon className="tab-icon" />
              ) : tab.status === "missing" || tab.status === "error" ? (
                <ExclamationIcon className="tab-icon session-mark session-mark-error" />
              ) : waitingTabIds.includes(tab.tabId) ? (
                <QuestionIcon className="tab-icon session-mark" />
              ) : tab.busy && tab.waitingAt === undefined ? (
                // A question is *hidden* on the tab in front of the user (`waitingTabIds` leaves
                // it out), and the spinner must not step in for it: a session stopped on a
                // question is not working, on screen or off.
                <SpinnerIcon className="tab-icon session-mark spinning" />
              ) : markedTabIds.includes(tab.tabId) ? (
                <CommentIcon className="tab-icon session-mark" />
              ) : (
                <AgentIcon agentId={tab.agentId} className="tab-icon" />
              )}
              <span className="tab-label">{tabLabel(tab)}</span>
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
        {/* This pane's own progress bar — a new agent starting here, the editor tab reading or
            saving its file here, or, in pane "a" alone, the project-wide reason with no tab to
            point at (the session listing at bootstrap). */}
        {(showProgress || (holdsEditor && editorBusy)) && <ProgressBar />}
        <div className="new-tab">
          <button
            className="icon-button"
            title="New session"
            onMouseDown={(event) => {
              event.stopPropagation();
              // The context menu's outside-click handler listens on the capture phase and has
              // already closed it by the time this runs, so a second click would reopen it.
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
              projectId={projectId}
              active={tab.tabId === activeTabId}
              visible={visible}
              focused={focused}
            />
          ) : (
            <TerminalHost
              key={tab.tabId}
              projectId={projectId}
              tabId={tab.tabId}
              agent={agents.find((agent) => agent.id === tab.agentId)}
              active={tab.tabId === activeTabId}
              visible={visible}
            />
          )
        )}
        {tabs.length === 0 && <div className="placeholder">No sessions open.</div>}
      </div>

      {tabMenu && (
        <ContextMenu x={tabMenu.x} y={tabMenu.y} entries={tabMenuEntries(tabMenu.tabId)} onClose={closeTabMenu} />
      )}
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
