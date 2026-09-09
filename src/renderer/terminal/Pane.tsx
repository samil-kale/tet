import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, AgentInfo, TerminalDescriptor } from "../../shared/types";
import { fitTerminal, focusTerminal } from "./terminal-views";
import { PANE_LABELS, PRESETS, PRESET_LABELS, PRESET_PANES, TAB_DRAG_TYPE } from "./pane-layout";
import type { PaneId, SplitPreset } from "./pane-layout";
import { AgentIcon } from "../ui/agent-icons";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { prompt } from "../ui/Dialog";
import { TerminalHost } from "./TerminalHost";
import {
  CloseIcon,
  CommentIcon,
  ExclamationIcon,
  FilesIcon,
  GearIcon,
  GitIcon,
  LayoutCols2Icon,
  LayoutGrid2x2Icon,
  LayoutSingleIcon,
  LayoutSplitRightIcon,
  PlusIcon,
  QuestionIcon,
  SpinnerIcon
} from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

/** Dragging the window edge fires dozens of observations, and every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;
/** What VS Code's own tab rename accepts. */
const MAX_TITLE_LENGTH = 50;

/** The layout dropdown's own glyph, and each preset's icon in its menu. */
function PresetIcon({ preset, className }: { preset: SplitPreset; className?: string }) {
  switch (preset) {
    case "single":
      return <LayoutSingleIcon className={className} />;
    case "cols2":
      return <LayoutCols2Icon className={className} />;
    case "split-right":
      return <LayoutSplitRightIcon className={className} />;
    case "grid2x2":
      return <LayoutGrid2x2Icon className={className} />;
  }
}

/** ISO 8601 date/time, space instead of "T", local time, seconds precision. */
function formatIso(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** What only the first pane of a split project shows — the git toggle. */
export interface PaneChrome {
  gitOpen: boolean;
  onToggleGit: () => void;
}

interface PaneProps {
  projectId: string;
  paneId: PaneId;
  /** The whole project's preset — needed to know this pane's siblings for "move to" and the picker. */
  preset: SplitPreset;
  /** Already filtered to this pane, in the project's own tab order. */
  tabs: TerminalDescriptor[];
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
  markedTabIds: string[];
  waitingTabIds: string[];
  /** Present only for the pane that carries the project's shared chrome — see `PaneChrome`. */
  chrome?: PaneChrome;
  /** The layout picker, right of the browse-files button. Present only on pane "a". */
  onPresetChange?: (preset: SplitPreset) => void;
  /** Browsing the repository's files, right of the git toggle. Present only on pane "a". */
  onBrowseFiles?: () => void;
  /** The settings, right of the layout picker. Present only on pane "a". */
  onOpenSettings?: () => void;
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
  markedTabIds,
  waitingTabIds,
  chrome,
  onPresetChange,
  onBrowseFiles,
  onOpenSettings,
  showProgress,
  dragOver,
  onDragStart,
  onDragOverChange,
  onDropTab,
  onDragEnd
}: PaneProps) {
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number } | null>(null);
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

  // Refit whenever the terminal becomes the visible one: while its pane was hidden it had no
  // layout, so its last measured size is stale. The resize is also what starts its process.
  useEffect(() => {
    if (visible && activeTabId) {
      fitTerminal(projectId, activeTabId);
    }
  }, [visible, activeTabId, projectId]);

  // Keyboard focus follows the focused pane's active tab. Only the focused pane's: with several
  // panes each doing this, whichever effect ran last would win. Separate from the refit above —
  // a focus change alone must not resize the pty, which repaints the CLI.
  //
  // A freshly created tab is activated before its own push arrives, so its TerminalHost has not
  // mounted yet and there is no view to focus. `activeTabReady` retriggers this once the tab
  // shows up in `tabs`, without reacting to unrelated tab updates that would steal focus back.
  const activeTabReady = activeTabId !== null && tabs.some((tab) => tab.tabId === activeTabId);
  useEffect(() => {
    if (visible && focused && activeTabId) {
      focusTerminal(projectId, activeTabId);
    }
  }, [visible, focused, activeTabId, projectId, activeTabReady]);

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
      if (!visible || !activeTabId) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => fitTerminal(projectId, activeTabId), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, activeTabId, projectId]);

  const createTab = useCallback(
    async (agentId: AgentId) => {
      const descriptor = await window.tet.terminals.create(projectId, agentId);
      onActivate(paneId, descriptor.tabId);
    },
    [projectId, paneId, onActivate]
  );

  const closeTabs = useCallback(
    (tabIds: string[]) => void window.tet.terminals.close(projectId, tabIds),
    [projectId]
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

  /** Agents label their tab with the session title; a shell tab has no session to name. */
  const tabLabel = (tab: TerminalDescriptor): string => {
    if (tab.title) {
      return tab.title;
    }
    return agents.find((agent) => agent.id === tab.agentId)?.hasSessions === false
      ? agentName(tab.agentId)
      : "New session";
  };

  const tabTooltip = (tab: TerminalDescriptor): string => {
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
   * this tab could live. A close action with nothing to close renders disabled.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = tabs.map((tab) => tab.tabId);
    const renamable = tabs.find((tab) => tab.tabId === tabId && tab.sessionId !== undefined);
    // A saved command can be run again whenever; anything else only once its process is gone. A
    // running tab is ended by closing it, not by this.
    const restartable = tabs.some(
      (tab) => tab.tabId === tabId && (tab.savedCommand === true || tab.status === "stopped" || tab.status === "error")
    );
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

  const presetEntries = (): ContextMenuEntry[] =>
    onPresetChange
      ? PRESETS.map((value) => ({
          label: PRESET_LABELS[value],
          icon: <PresetIcon preset={value} className="tab-icon" />,
          run: () => onPresetChange(value)
        }))
      : [];

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
        {/* Window chrome rather than tabs — the git toggle, browse-files, the layout picker and
            settings. Present only on pane "a". */}
        {(chrome || onPresetChange) && (
          <div className="tab-strip-actions">
            {chrome && (
              <button
                className={`icon-button${chrome.gitOpen ? " active" : ""}`}
                onClick={chrome.onToggleGit}
                title={chrome.gitOpen ? "Hide the repository" : "Show the repository"}
              >
                <GitIcon />
              </button>
            )}
            {onBrowseFiles && (
              <button className="icon-button" title="Browse files" onClick={onBrowseFiles}>
                <FilesIcon />
              </button>
            )}
            {onPresetChange && (
              <button
                className="icon-button"
                title="Split layout"
                onMouseDown={(event) => {
                  event.stopPropagation();
                  if (layoutMenu) {
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  setLayoutMenu({ x: rect.left, y: rect.bottom + 6 });
                }}
              >
                <PresetIcon preset={preset} />
              </button>
            )}
            {onOpenSettings && (
              <button className="icon-button" title="Settings" onClick={onOpenSettings}>
                <GearIcon />
              </button>
            )}
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
              className={`tab${tab.tabId === activeTabId ? " active" : ""}${tab.status === "stopped" ? " inactive" : ""}`}
              // Always: even the only pane has the snap zones to drop on.
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_DRAG_TYPE, tab.tabId);
                event.dataTransfer.effectAllowed = "move";
                onDragStart(paneId);
              }}
              onClick={() => onActivate(paneId, tab.tabId)}
              onDoubleClick={() => tab.sessionId !== undefined && void askRename(tab)}
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
                  > finished. See "Both ends of a turn" in CLAUDE.md. */}
              {tab.status === "missing" || tab.status === "error" ? (
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
                title={tab.sessionId !== undefined ? "Close tab and delete its session" : "Close tab"}
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
        {/* This pane's own progress bar — a new agent starting here, or, in pane "a" alone, the
            project-wide reason with no tab to point at (the session listing at bootstrap). */}
        {showProgress && <ProgressBar />}
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
        {tabs.map((tab) => (
          <TerminalHost
            key={tab.tabId}
            projectId={projectId}
            tabId={tab.tabId}
            agent={agents.find((agent) => agent.id === tab.agentId)}
            active={tab.tabId === activeTabId}
            visible={visible}
          />
        ))}
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
      {layoutMenu && (
        <ContextMenu
          x={layoutMenu.x}
          y={layoutMenu.y}
          entries={presetEntries()}
          onClose={() => setLayoutMenu(null)}
          className="new-session-menu"
        />
      )}
    </div>
  );
});
