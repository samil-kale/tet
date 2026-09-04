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
  /** Whether the repository has local changes — colors the toggle regardless of pane state. */
  gitDirty: boolean;
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
   * this pane's active tab changes. Nothing is drawn for it: a frame around the focused pane was
   * tried and taken out, and the drag-over frame below is the one this pane shows.
   */
  focused: boolean;
  onActivate: (paneId: PaneId, tabId: string) => void;
  onFocus: (paneId: PaneId) => void;
  markedTabIds: string[];
  waitingTabIds: string[];
  /** Present only for the pane that carries the project's shared chrome — see `PaneChrome`. */
  chrome?: PaneChrome;
  /**
   * Present only for the pane that carries the layout picker — the same pane `chrome` is on
   * (pane "a"), right of the browse-files button.
   */
  onPresetChange?: (preset: SplitPreset) => void;
  /**
   * Browsing the repository's files — the diff dialog reopened on whatever it last showed —
   * right of the git toggle, present on exactly the pane `onPresetChange` is and for the same
   * reason.
   */
  onBrowseFiles?: () => void;
  /**
   * The settings, right of the layout picker — present on exactly the pane `onPresetChange` is,
   * for the same reason: it belongs to the window rather than to a project, so it sits beside the
   * git toggle rather than following any one project's own layout.
   */
  onOpenSettings?: () => void;
  /**
   * Whether this pane's own progress bar shows — one of its own tabs starting, or (only ever
   * true where `chrome` also is) a project-wide reason with no tab of its own to point at.
   * Independent of `chrome`, the same way `onPresetChange` is: unlike the git toggle, the reason
   * this bar is up is not bound to pane "a" once it is a tab starting somewhere else.
   */
  showProgress: boolean;
  /**
   * This pane's own size within the grid, in pixels — one of the two for a pane a divider sizes,
   * neither for the one that fills what is left. Numbers rather than a style object so the memo
   * above sees a size that has not changed as the same prop.
   */
  width?: number;
  height?: number;
  /**
   * Whether a plain drop would land the dragged tab here — `TerminalsPane` is what decides,
   * since only it knows which dividers border which, where the tab came from, and whether the
   * pointer is in a snap zone instead. This pane only reports what it sees: the drag starting
   * on one of its tabs, the pointer over it (and where), the drop, and the drag ending.
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

  // VS Code scrolls its tab strip horizontally with the vertical wheel. Registered by hand
  // because preventDefault needs a non-passive listener, which React's onWheel isn't.
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

  // A new or newly activated tab can land past the strip's visible width once it no longer
  // fits — scroll it into view rather than leaving it reachable only by manually scrolling.
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

  // Keyboard focus follows the focused pane's active tab — on the project coming on screen, on
  // that pane's selection changing, on focus moving to this pane. Only the focused pane's: with
  // several panes each doing this for their own tab, whichever effect ran last would win, and a
  // tab closed in a pane the user is not in would pull the cursor over there. Separate from the
  // refit above on purpose — a focus change alone must not resize the pty, which repaints the CLI.
  //
  // A freshly created tab is activated before its own push arrives (`activateTab`'s own comment:
  // "a tab just activated can be ahead of its own push") — its TerminalHost has not mounted yet,
  // so there is no view to focus. `activeTabReady` retriggers this once the tab actually shows up
  // in `tabs`, without reacting to unrelated tab updates that would otherwise steal focus back
  // from wherever the user is.
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
    // Only ever the debounced pty resize, never an immediate local reflow — see `fitTerminal`'s
    // own comment for why: reflowing xterm ahead of the pty is what let a CLI's own redraw land
    // on a ConPTY buffer already reflowed for a size it does not know about yet. A dragged sash
    // can show an empty strip of background until it settles; that is the trade for it.
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
   * VS Code's editor tab context menu, reduced to its close actions plus rename, and — once this
   * project has more than one pane — where else this tab could live. What a close action would
   * close is what decides whether it is enabled, so "nothing to close" (a right-click on the
   * only tab, or on the last one) renders it disabled.
   */
  const tabMenuEntries = (tabId: string): ContextMenuEntry[] => {
    const ids = tabs.map((tab) => tab.tabId);
    const renamable = tabs.find((tab) => tab.tabId === tabId && tab.sessionId !== undefined);
    const restartable = tabs.find((tab) => tab.tabId === tabId && tab.savedCommand === true);
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
      // A tab whose agent hasn't persisted a session yet has nothing to rename — the host
      // would just revert the new label, so don't offer it in the first place.
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
      // has turned on mouse tracking (agent CLIs commonly do), which would otherwise stop a
      // click inside the terminal from ever reaching this handler — leaving focusedPane stuck
      // wherever it last was.
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
        // Fires for every tab and button inside the pane too; only leaving the pane itself
        // counts — the same rule `terminal-views.ts` applies to a file dragged over a terminal.
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
      // A drag cancelled mid-air (Escape, or dropped somewhere that refuses it) fires neither
      // `drop` nor `dragleave` for the pane the preview is over — this still clears it.
      onDragEnd={onDragEnd}
    >
      <div className={`tab-strip${chrome?.gitOpen ? " git-open" : ""}`}>
        {/* Where the git tab used to be, and no longer a tab: toggling it shows a pane of its own
            beside this one rather than taking its place. Grouped with browse-files, the layout
            picker and settings — none of them about a tab, all of them window chrome rather than
            anything a project's own tab strip owns. Present only on pane "a". */}
        {(chrome || onPresetChange) && (
          <div className="tab-strip-actions">
            {chrome && (
              <button
                className={`icon-button${chrome.gitDirty ? " active" : ""}`}
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
              // Keeps the terminal focused across the whole right-click interaction: without
              // this, mousedown's default focus handling blurs xterm's textarea (the tab isn't
              // focusable, so focus falls back to <body>), leaving the user unable to type
              // after the menu closes until they click the terminal again.
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
              {/* What this session is doing takes the agent icon's place rather than claiming room
                  of its own — the tab is as wide as its label and nothing more. In the order of
                  how much they say: a tab whose agent cannot even start, or whose process ended on
                  its own rather than at the user's own request, outranks everything else — none of
                  the other three can ever be true for it. Of the rest, a standing question outranks
                  working, because such a session is precisely *not* working and nothing moves until
                  it is answered; working outranks finished, since a turn that started after the
                  last one ended is the newer truth, and the mark is still there underneath for when
                  it stops. */}
              {tab.status === "missing" || tab.status === "error" ? (
                <ExclamationIcon className="tab-icon session-mark session-mark-error" />
              ) : waitingTabIds.includes(tab.tabId) ? (
                <QuestionIcon className="tab-icon session-mark" />
              ) : tab.busy && tab.waitingAt === undefined ? (
                // Not merely the ranking above: a question is *hidden* on the tab in front of the
                // user (`waitingTabIds` leaves it out), and the spinner must not step in for it —
                // a session stopped on a question is not working, on screen or off, the same rule
                // `App`'s `marks[].busy` applies to the project row.
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
            one project-wide reason with no tab of its own to point at (the session listing at
            bootstrap). Every pane carries the reason that is its own, so an agent opened in
            another pane no longer lights up the bar the user is not looking at. */}
        {showProgress && <ProgressBar />}
        <div className="new-tab">
          <button
            className="icon-button"
            title="New session"
            onMouseDown={(event) => {
              event.stopPropagation();
              // The context menu's own outside-click handler already closed it by the time
              // this runs (it listens on the capture phase), so a second click only reopens
              // when the check below still sees the menu as open from before that happened.
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
