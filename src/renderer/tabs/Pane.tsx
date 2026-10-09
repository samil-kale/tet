import { memo, useCallback, useEffect, useRef } from "react";
import { isWorking } from "../../shared/types/terminals";
import type { Lane } from "../../shared/types/settings";
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
import { BrowserHost } from "./BrowserHost";
import { EditorHost, useEditorBusy, useEditorPreview } from "../editor/EditorHost";
import { getEditorSnapshot, keepEditor } from "../editor/editor-views";
import { IconButton } from "../ui/IconButton";
import { useDragReorder } from "../ui/drag-reorder";
import { BrowserIcon, CloseIcon, FilesIcon, GearIcon, GitIcon, PlusIcon, ProjectsIcon, ShieldIcon, type IconProps } from "../ui/icons";
import { TabMark } from "../ui/TabMark";
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
  /** The strip toggles the free lane alone; a pinned one is out, its toggle gone. */
  freeLane: Lane | null;
  /** The lanes not pinned, in the user's order. */
  toggleOrder: readonly Lane[];
  onToggleLane: (lane: Lane) => void;
  /** A toggle dragged from `from` to insertion index `to` of `toggleOrder`. */
  onMoveToggle: (from: number, to: number) => void;
  onOpenSettings: () => void;
}

/** The lanes' toggles, drawn in `toggleOrder`. */
const LANE_TOGGLES: Record<Lane, { noun: string; Icon: (props: IconProps) => React.ReactNode }> = {
  projects: { noun: "projects", Icon: ProjectsIcon },
  git: { noun: "git", Icon: GitIcon },
  files: { noun: "files", Icon: FilesIcon },
};

/** A toggle's drag, its own so no tab strip or terminal takes the drop. */
const TOGGLE_DRAG_TYPE = "application/x-tet-lane-toggle";

/** The strip's toggles, each dragged elsewhere among them. */
function LaneToggles({ chrome }: { chrome: PaneChrome }) {
  const { toggleOrder, freeLane, onToggleLane, onMoveToggle } = chrome;
  const { rowProps, rowClasses } = useDragReorder({
    dragType: TOGGLE_DRAG_TYPE,
    count: toggleOrder.length,
    payloadOf: (index) => toggleOrder[index],
    indexOf: (lane) => toggleOrder.indexOf(lane as Lane),
    onMove: onMoveToggle,
  });
  return toggleOrder.map((lane, index) => {
    const { noun, Icon } = LANE_TOGGLES[lane];
    return (
      <IconButton
        key={lane}
        {...rowProps(index)}
        className={["lane-toggle", ...rowClasses(index)].join(" ")}
        active={freeLane === lane}
        onClick={() => onToggleLane(lane)}
        title={`${freeLane === lane ? "Hide" : "Show"} ${noun}`}
      >
        <Icon />
      </IconButton>
    );
  });
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
  onDropTab: (paneId: PaneId, tabId: string) => void;
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
  /** Runs in, or loads through, an sbx sandbox: the shield badge. */
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
  chrome,
  busy,
  dragOver,
  onDragStart,
  onDragOverChange,
  onDropTab,
  onDragEnd,
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
  /** A browser tab's page takes its clicks before this pane's mousedown sees them. */
  const focusHere = useCallback(() => onFocus(paneId), [onFocus, paneId]);
  const browserBusy = tabs.some((tab) => {
    const kinded = kindOf(tab);
    return kinded.kind === "browser" && kinded.tab.loading;
  });

  const createTab = useCallback(
    async (agentId: AgentId) => {
      const descriptor = await window.tet.tabs.create(at, agentId);
      onActivate(descriptor.tabId, paneId);
    },
    [at, paneId, onActivate],
  );

  /** A blank page, its address bar focused to type into (BrowserHost); or a page's link. */
  const createBrowserTab = useCallback(
    async (url = "about:blank") => {
      const tab = await window.tet.browser.create(at, url);
      onActivate(tab.tabId, paneId);
    },
    [at, paneId, onActivate],
  );
  const openBrowserTab = useCallback((url: string) => void createBrowserTab(url), [createBrowserTab]);

  /**
   * Editor tabs close in the renderer, the rest in main. Their unsaved-edit question may keep them
   * open while the same "Close All"'s terminals and browser tabs go.
   */
  const closeTabs = useCallback(
    (tabIds: string[]) => {
      const byKind: Record<PaneTabKind, string[]> = { terminal: [], browser: [], editor: [] };
      for (const tabId of tabIds) {
        byKind[paneTabKind(tabId)].push(tabId);
      }
      if (byKind.editor.length > 0) {
        onCloseEditors(byKind.editor);
      }
      if (byKind.terminal.length > 0) {
        void window.tet.tabs.close(at, byKind.terminal);
      }
      for (const tabId of byKind.browser) {
        void window.tet.browser.close(at, tabId);
      }
    },
    [at, onCloseEditors],
  );

  const restartTab = useCallback((tabId: string) => void window.tet.tabs.restart(at, tabId), [at]);

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
      case "browser": {
        const { title, url, sandboxed } = kinded.tab;
        const lines = title ? [title, url] : [url];
        return {
          label: <span className="tab-label">{title || (url === "about:blank" ? "New tab" : url)}</span>,
          tooltip: [...lines, ...(sandboxed ? ["Loads through its agent's SBX sandbox"] : [])].join("\n"),
          icon: <BrowserIcon className="tab-icon" />,
          sandboxed: sandboxed === true,
          inactive: false,
          closeTitle: "Close tab",
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
          closeTitle: terminal.sessionId !== undefined ? "Close tab and delete its session" : "Close tab",
        };
      }
    }
  };

  const siblingPanes = PRESET_PANES[preset].filter((id) => id !== paneId);

  /**
   * Restart, Clear for the shell, the close actions, rename and hand-over for an agent with sessions, and the moves
   * to sibling panes. A close with nothing to close is disabled. An editor tab gets "Keep Open" while a preview, the close actions and the
   * moves; a browser tab the close actions and the moves.
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
              run: () => onActivate(tabId, target),
            })),
          ]
        : [];
    const closeEntries: ContextMenuEntry[] = [
      closeAction("Close", [tabId]),
      closeAction(
        "Close Others",
        ids.filter((id) => id !== tabId),
      ),
      closeAction("Close to the Right", ids.slice(ids.indexOf(tabId) + 1)),
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
          ] satisfies ContextMenuEntry[])
        : []),
      ...handOverEntries,
      ...moveEntries,
    ];
  };

  // Built only while the menu is open: a pane re-renders on every tab push, and icons are elements.
  const newTabEntries = (): ContextMenuEntry[] => [
    ...agents.map((agent) => agentEntry(agent, () => void createTab(agent.id))),
    SEPARATOR,
    { label: "Browser", icon: <BrowserIcon className="tab-icon" />, run: () => void createBrowserTab() },
  ];

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
            <LaneToggles chrome={chrome} />
            <IconButton title="Settings" onClick={chrome.onOpenSettings}>
              <GearIcon />
            </IconButton>
          </div>
        )}
        <div className="tabs" ref={strip}>
          {tabs.map((tab) => {
            const face = faceOf(tab);
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
                className={`tab${tab.tabId === activeTabId ? " active" : ""}${face.inactive ? " inactive" : ""}`}
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
        {/* This pane's one progress bar: a tab starting, an editor tab busy, a page loading, or in
            pane "a" the bootstrap session listing. */}
        {(busy || editorBusy || browserBusy) && <ProgressBar />}
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
            case "browser":
              return (
                <BrowserHost
                  key={tab.tabId}
                  at={at}
                  tab={kinded.tab}
                  active={active}
                  visible={visible}
                  focused={focused}
                  onFocused={focusHere}
                  onOpenTab={openBrowserTab}
                />
              );
            case "terminal":
              return (
                <TerminalHost
                  key={tab.tabId}
                  at={at}
                  tabId={tab.tabId}
                  shiftEnter={agentInfo(agents, kinded.tab.agentId)?.shiftEnter}
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
