import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { closedWith, EMPTY_REPOSITORY_STATE, isWorking, refName, worktreeBase } from "../shared/types";
import type { AgentInfo, EnvRequest, Project, RepositoryState, TerminalDescriptor } from "../shared/types";
import { AddRepositoryDialog } from "./dialogs/AddRepositoryDialog";
import { EnvDialog } from "./dialogs/EnvDialog";
import { CommandList } from "./sidebar/CommandList";
import { useBranchActions } from "./git/run-action";
import { Dialogs } from "./ui/Dialog";
import { SbxSettingsDialog } from "./dialogs/SbxSettingsDialog";
import { FilesPane } from "./files/FilesPane";
import { GitPane } from "./git/GitPane";
import { Notices, notify } from "./ui/Notices";
import { ProjectList } from "./sidebar/ProjectList";
import type { ProjectHead, ProjectMarks } from "./sidebar/ProjectList";
import { activeAfterChange, activeAtStart, rememberActive } from "./sidebar/active-project";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { usePaneSize, usePaneToggle } from "./ui/layout-storage";
import { MIN_CONTENT_WIDTH, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, Sash } from "./ui/Sash";
import { TerminalsPane } from "./terminal/TerminalsPane";
import type { SideView } from "./terminal/Pane";
import { clearTerminal, disposeProjectTerminals } from "./terminal/terminal-views";
import { PlusIcon } from "./ui/icons";
import { isWindowCovered, useWindowCovered } from "./ui/window-covered";
import { useAgents } from "./ui/use-agents";
import { forget, sameList, stableRecord } from "./identity";
import { matchesShortcut } from "./shortcuts";
import { reportSlow } from "./slow-report";
import { defaultLayout, paneOf, tabsInFront } from "./terminal/pane-layout";
import { NO_TABS, useProjectLayouts } from "./terminal/use-project-layouts";
import { nextEditorTabId, type EditorTab, type OpenEditor, type PaneTab } from "./terminal/editor-tab";
import {
  canDiscardEdits,
  canDiscardProjectEdits,
  disposeEditor,
  disposeProjectEditors,
  keepEditor,
  openEditorFile,
  previewEditorTab,
  revealEditorMatch,
  showDiff,
  showMarkdownPreview
} from "./diff/editor-views";
import { useEditorSync } from "./diff/use-editor-sync";

/** Who asks for environment variables, as the window names that tab: "Claude (fix login) in
 *  autocontract". */
function requesterOf(
  request: EnvRequest,
  projects: Project[],
  tabs: Record<string, TerminalDescriptor[]>,
  agents: AgentInfo[]
): string {
  const project = projects.find((entry) => entry.id === request.projectId);
  const tab = project && tabs[project.id]?.find((entry) => entry.tabId === request.tabId);
  const agent = tab && (agents.find((entry) => entry.id === tab.agentId)?.displayName ?? tab.agentId);
  const who = agent ? (tab.title ? `${agent} (${tab.title})` : agent) : "An agent";
  return project ? `${who} in ${project.name}` : who;
}

/** Shared instance, so a pane's props stay identical for a project with none. */
const NO_IDS: string[] = [];

const DEFAULT_LAYOUT = defaultLayout();

let renderStartedAt = 0;

/** `worktreesSupported`: git creates and renames them (Requirements.worktrees). */
export function App({ worktreesSupported }: { worktreesSupported: boolean }) {
  renderStartedAt = performance.now();
  // App's render to commit: what a state change here costs across the tree (React's Profiler is
  // silent in production). A subtree re-rendering alone is not seen.
  useLayoutEffect(() => {
    reportSlow("render", performance.now() - renderStartedAt);
  });
  const [projects, setProjects] = useState<Project[]>([]);
  /** The list after an await: the control channel can add a project meanwhile. */
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  /** For callbacks the project list gets, read on a click: see `tabsRef`. */
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  useEffect(() => rememberActive(activeProjectId), [activeProjectId]);
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /** Every project's tabs: the project list needs all of them at once. */
  const [tabs, setTabs] = useState<Record<string, TerminalDescriptor[]>>({});
  /**
   * For callbacks that read it only on a click: depending on `tabs` would remake them, and every
   * pane's props, on every push.
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /**
   * Renderer-only, see `editor-tab.ts`; a project with none has no entry. Untouched tabs keep
   * their instance across updates: `stripTabs` compares items.
   */
  const [editorTabs, setEditorTabs] = useState<Record<string, EditorTab[]>>({});
  const editorTabsRef = useRef(editorTabs);
  editorTabsRef.current = editorTabs;
  /**
   * Each project's tab strip: its terminals, then its editor tabs. The layout reconciles against
   * it, panes draw it, next/previous step through it; marks and `seen` stay on `tabs` (the editor
   * has no turns). Identity: `tabs`' own list without a file open, else the previous list while
   * unchanged.
   */
  const stripTabsRef = useRef<Record<string, PaneTab[]>>({});
  const stripTabs = useMemo(() => {
    const next: Record<string, PaneTab[]> = { ...tabs };
    for (const [projectId, editors] of Object.entries(editorTabs)) {
      next[projectId] = sameList(stripTabsRef.current[projectId], [...(tabs[projectId] ?? []), ...editors], NO_TABS);
    }
    stripTabsRef.current = next;
    return next;
  }, [tabs, editorTabs]);
  /**
   * Projects with something starting (bootstrap listing, a CLI booting). Read by the progress bar
   * and the layout persistence.
   */
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  /**
   * Split state lives here, not in `TerminalsPane`: shortcuts and marks/seen need what is on screen
   * across every pane — one tab per pane (`visibleTabIds`). A pane asks for a selection change
   * through `onActivateTab`. See "Split view" in AGENTS.md.
   */
  const { layouts, activateTab, snapTab, focusPane, placeTab, forgetLayout } = useProjectLayouts(
    stripTabs,
    starting
  );
  /** The editors kept in step with the tabs, the layout and the states (use-editor-sync.ts). */
  const { activeEditors, forgetProject: forgetEditorSync } = useEditorSync(editorTabs, layouts, states);
  /** The branch commands' gate, and the git pane's and project list's ways in (run-action.ts). */
  const { activeBranch, projectListBusy, runInProject } = useBranchActions(activeProjectId);
  // Pane defaults and limits; both side-pane views share the two below ("git-panels" predates the
  // files view).
  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebar", 240, MIN_PANE_WIDTH);
  const [sidePaneWidth, setSidePaneWidth] = usePaneSize("git-panels", 300, MIN_PANE_WIDTH);
  const [branchTreeHeight, setBranchTreeHeight] = usePaneSize("branch-tree", 260, MIN_PANE_HEIGHT);
  const [fileSearchHeight, setFileSearchHeight] = usePaneSize("file-search", 260, MIN_PANE_HEIGHT);
  // 40% of the window it first opens in.
  const [commandsHeight, setCommandsHeight] = usePaneSize(
    "commands",
    Math.round(window.innerHeight * 0.4),
    MIN_PANE_HEIGHT
  );
  /**
   * Whether the side pane is out, and whether it shows files instead of git — remembered like a
   * pane size. One view at a time, as VS Code's Explorer and Source Control ("git-pane" predates
   * the files view).
   */
  const [sidePaneOpen, setSidePaneOpen] = usePaneToggle("git-pane", false);
  const [filesShown, setFilesShown] = usePaneToggle("side-pane-files", false);
  const sideView: SideView | null = sidePaneOpen ? (filesShown ? "files" : "git") : null;
  /** Read on a click, so `toggleSideView` — and every view handed it — stays the same across a
   *  toggle. */
  const sideViewRef = useRef(sideView);
  sideViewRef.current = sideView;
  /**
   * Gates `.side-pane.sliding`'s width transition to the slide alone — the pane stays in the DOM
   * at width 0 while in, so opening and closing both transition — and the sash sets the same
   * width, where an animated one would lag the pointer. Set by what opens or closes the pane,
   * cleared once the transition ends; switching views while out slides nothing. Not without a
   * project: no pane is drawn then, and nothing would end the transition.
   */
  const [sideSliding, setSideSliding] = useState(false);
  const stopSliding = useCallback(() => setSideSliding(false), []);
  const slidePane = useCallback((open: boolean) => {
    setSidePaneOpen(open);
    if (activeProjectIdRef.current !== null) {
      setSideSliding(true);
    }
  }, [setSidePaneOpen]);
  /** Shows that view, or slides the pane in when that view is already out. */
  const toggleSideView = useCallback(
    (view: SideView) => {
      if (sideViewRef.current === view) {
        slidePane(false);
        return;
      }
      setFilesShown(view === "files");
      if (sideViewRef.current === null) {
        slidePane(true);
      }
    },
    [setFilesShown, slidePane]
  );
  const [addOpen, setAddOpen] = useState(false);
  /** Window-wide, not per project. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sbxSettingsProject, setSbxSettingsProject] = useState<Project | null>(null);
  /** What an agent asked for with `tet-ctl env-request`; main sends one at a time. */
  const [envRequest, setEnvRequest] = useState<EnvRequest | null>(null);
  /**
   * Each tet.json's `sbx.enabled`, replaced only where it changed (the memoized list re-renders
   * otherwise). Any writer of that file (dialog, agent, editor, checkout) arrives as `commands:changed`.
   */
  const [sandboxed, setSandboxed] = useState<Record<string, boolean>>({});
  /** Projects whose flag was read on arrival — not `sandboxed`, which holds no entry for "off".
   *  Forgotten with the project, so one added again is read again. */
  const sandboxedRead = useRef(new Set<string>());

  useEffect(() => {
    const unsubscribers = [
      window.tet.repository.onState(({ projectId, state }) =>
        setStates((current) => ({ ...current, [projectId]: state }))
      ),
      window.tet.terminals.onTabs(({ projectId, tabs: list }) =>
        setTabs((current) => ({ ...current, [projectId]: list }))
      ),
      window.tet.terminals.onStatus(({ projectId, tabId, status }) => {
      // A saved command's restart kill writes a trailing "^C"; clearing once the respawn runs keeps
      // it off screen (main flushes the old output before the status, the new one's has not come).
        if (status === "running" && tabsRef.current[projectId]?.some((tab) => tab.tabId === tabId && tab.savedCommand)) {
          clearTerminal(projectId, tabId);
        }
        setTabs((current) => {
          const list = current[projectId];
          return list
            ? { ...current, [projectId]: list.map((tab) => (tab.tabId === tabId ? { ...tab, status } : tab)) }
            : current;
        });
      }),
      window.tet.terminals.onStartupProgress(({ projectId, show }) =>
        setStarting((current) => (current[projectId] === show ? current : { ...current, [projectId]: show }))
      )
    ];

    void (async () => {
      const stored = await window.tet.projects.list();
      setProjects(stored);
      setActiveProjectId((current) => current ?? activeAtStart(stored));
      const fetched = await Promise.all(
        stored.map(async (project) => {
          const [state, list, isStarting] = await Promise.all([
            window.tet.repository.state(project.id),
            window.tet.terminals.list(project.id),
            window.tet.terminals.starting(project.id)
          ]);
          return [project.id, state, list, isStarting] as const;
        })
      );
      // A project removed meanwhile was forgotten already: merging its entries would revive it.
      const open = new Set(projectsRef.current.map((project) => project.id));
      const loaded = fetched.filter(([id]) => open.has(id));
      // Pushes that landed meanwhile are newer than what was fetched.
      setStates((current) => ({
        ...Object.fromEntries(loaded.map(([id, state]) => [id, state])),
        ...current
      }));
      setTabs((current) => ({ ...Object.fromEntries(loaded.map(([id, , list]) => [id, list])), ...current }));
      setStarting((current) => ({
        ...Object.fromEntries(loaded.map(([id, , , isStarting]) => [id, isStarting])),
        ...current
      }));
    })();

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(
    () => window.tet.onNotice(({ severity, message }) => notify(severity, message)),
    []
  );

  /** A branch's worktree from the git pane: its project, else the folder opened as one (which
   *  `projects:changed` then shows). */
  const openWorktree = useCallback(async (worktreePath: string) => {
    const open = projectsRef.current.find((project) => project.path === worktreePath);
    if (open) {
      setActiveProjectId(open.id);
      return;
    }
    const result = await window.tet.projects.open(worktreePath);
    if (!result.project) {
      notify("error", result.error ?? `Could not open ${worktreePath}`);
    }
  }, []);

  /** A worktree's own project, if it is one, before its terminals close. */
  const canCloseWorktree = useCallback(async (worktreePath: string) => {
    const project = projectsRef.current.find((entry) => entry.path === worktreePath);
    return project ? canDiscardProjectEdits(project.id) : true;
  }, []);

  /** Drops everything held for a project; the project list is the caller's. */
  const forgetProject = useCallback((projectId: string) => {
    setStates((current) => forget(current, projectId));
    setTabs((current) => forget(current, projectId));
    setStarting((current) => forget(current, projectId));
    setSandboxed((current) => forget(current, projectId));
    sandboxedRead.current.delete(projectId);
    setEditorTabs((current) => forget(current, projectId));
    forgetEditorSync(projectId);
    disposeProjectEditors(projectId);
    forgetLayout(projectId);
    busyCursor.current = forget(busyCursor.current, projectId);
    // The xterms live outside React; this is where a project ends for good.
    disposeProjectTerminals(projectId);
  }, [forgetLayout, forgetEditorSync]);

  /** The project row's close, its worktrees' with it (closedWith); the list follows through
   *  `projects:changed`. */
  const closeProject = useCallback(async (projectId: string) => {
    if (await canDiscardProjectEdits(...closedWith(projectsRef.current, projectId))) {
      await window.tet.projects.remove(projectId);
    }
  }, []);

  // The one way the list changes, whoever asked — the dialog, a row's close, the git pane's
  // worktrees or the control channel (projects.ts): main announces, this follows. A project
  // opened where no agent is installed can only run sandboxed, so its sbx settings open at once,
  // locked (SbxSettingsDialog); not one reopened under a new id (a renamed worktree: removed and
  // added at once), whose settings came along with its folder, nor a worktree, which has none.
  useEffect(
    () =>
      window.tet.projects.onChanged(({ projects: list, added, removed }) => {
        const before = projectsRef.current;
        setProjects(list);
        setActiveProjectId((current) => activeAfterChange(current, before, list, added, removed));
        if (removed !== undefined) {
          forgetProject(removed);
        }
        const opened = added !== undefined && removed === undefined ? list.find((project) => project.id === added) : undefined;
        if (opened && !opened.mainPath) {
          void window.tet.startup.anyAgentInstalled().then((installed) => {
            if (!installed) {
              setSbxSettingsProject(opened);
            }
          });
        }
      }),
    [forgetProject]
  );

  const readSandboxed = useCallback(async (projectId: string) => {
    const config = await window.tet.sbx.getConfig(projectId);
    setSandboxed((current) =>
      (current[projectId] ?? false) === config.enabled ? current : { ...current, [projectId]: config.enabled }
    );
  }, []);

  // Once per project; after that every tet.json write is one `commands:changed`, shared with the
  // saved commands.
  useEffect(() => {
    for (const project of projects) {
      if (!sandboxedRead.current.has(project.id)) {
        sandboxedRead.current.add(project.id);
        void readSandboxed(project.id);
      }
    }
  }, [projects, readSandboxed]);
  useEffect(() => window.tet.commands.onChanged(({ projectId }) => void readSandboxed(projectId)), [readSandboxed]);

  const reorderProjects = useCallback((ordered: Project[]) => {
    setProjects(ordered);
    void window.tet.projects.reorder(ordered.map((project) => project.id));
  }, []);

  /**
   * Shows a tab opened from outside the terminals pane, bringing its project to front — a one-off
   * write into the layout (`placeTab`: a saved command's goes where its line last lay).
   */
  const showTab = useCallback(
    (projectId: string, tabId: string, command?: string) => {
      setActiveProjectId(projectId);
      placeTab(projectId, tabId, command);
    },
    [placeTab]
  );

  // A control-channel tab, shown like a saved command's: drawing it starts its process.
  useEffect(() => window.tet.terminals.onShow(({ projectId, tabId }) => showTab(projectId, tabId)), [showTab]);

  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const covered = useWindowCovered();

  /**
   * The active project's tabs in front of the user (`tabsInFront`) — the one definition marks,
   * `seen` and toasts (`terminals.inFront`) go by. Identity-stable: it is reported on change.
   */
  const inFrontRef = useRef<string[]>(NO_IDS);
  const inFront = useMemo(() => {
    const next = activeProjectId ? tabsInFront(layouts[activeProjectId] ?? DEFAULT_LAYOUT, focused, covered) : NO_IDS;
    inFrontRef.current = sameList(inFrontRef.current, next, NO_IDS);
    return inFrontRef.current;
  }, [focused, covered, activeProjectId, layouts]);

  // May include editor tabs, which match no tab in the main process.
  useEffect(() => {
    window.tet.terminals.inFront(activeProjectId, inFront);
  }, [activeProjectId, inFront]);

  /**
   * Finished or waiting sessions not in front of the user, oldest first — the tab strip's marks and
   * what the project row steps through. Tabs in front are left out: nothing there was out of sight.
   * Decided here, once: main holds the mark but cannot see the screen, and two views must not each
   * decide.
   */
  const markedTabs = useCallback(
    (projectId: string, field: "finishedAt" | "waitingAt"): TerminalDescriptor[] => {
      const onScreen = projectId === activeProjectId ? inFront : NO_IDS;
      return (tabs[projectId] ?? [])
        .filter((tab) => tab[field] !== undefined && !onScreen.includes(tab.tabId))
        .sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
    },
    [tabs, inFront, activeProjectId]
  );

  /**
   * Tabs the progress bar is about — runtime being prepared, CLI before its first frame. Tabs on
   * screen included: the bar is about the pane's own tabs.
   */
  const startingTabs = useCallback(
    (projectId: string): TerminalDescriptor[] => (tabs[projectId] ?? []).filter((tab) => tab.starting === true),
    [tabs]
  );

  /**
   * The above as tab ids plus `busy` (`ProjectMarks`), per project, identity-stable where unchanged:
   * panes and the project list take them as props, and most pushes change nothing here. `busy`
   * includes the tab on screen (a spinner is about now) but not one waiting on a question: that
   * session is not working, and both marks would stand side by side.
   */
  const marksRef = useRef<Record<string, ProjectMarks>>({});
  const marks = useMemo(() => {
    const next: Record<string, ProjectMarks> = {};
    for (const projectId of Object.keys(tabs)) {
      const previous = marksRef.current[projectId];
      next[projectId] = {
        finished: sameList(previous?.finished, markedTabs(projectId, "finishedAt").map((tab) => tab.tabId), NO_IDS),
        waiting: sameList(previous?.waiting, markedTabs(projectId, "waitingAt").map((tab) => tab.tabId), NO_IDS),
        starting: sameList(previous?.starting, startingTabs(projectId).map((tab) => tab.tabId), NO_IDS),
        busy: (tabs[projectId] ?? []).some(isWorking)
      };
    }
    return stableRecord(marksRef, next);
  }, [tabs, markedTabs, startingTabs]);

  /**
   * The project row's HEAD, first remote and dirty flag, identity-stable where unchanged (`states`
   * is fresh on every push, so every field is a value — the remote by what the row shows of it).
   * No git call of its own: `changes` comes with every refresh.
   */
  const headsRef = useRef<Record<string, ProjectHead>>({});
  const heads = useMemo(() => {
    const next: Record<string, ProjectHead> = {};
    for (const [projectId, state] of Object.entries(states)) {
      const base = state.worktrees.find((worktree) => worktree.current)?.base;
      const target = worktreeBase(state);
      next[projectId] = {
        head: state.head,
        detached: state.detached,
        upstream: state.upstream,
        base,
        baseAt: base === undefined ? undefined : state.worktrees.find((worktree) => worktree.branch === base)?.path,
        defaultBranch: target && refName(target),
        remoteName: state.remotes[0]?.name,
        remoteUrl: state.remotes[0]?.url,
        dirty: state.changes.length > 0
      };
    }
    return stableRecord(headsRef, next);
  }, [states]);

  /**
   * The project row's spinner steps through working sessions, one per press. Viewing one does not
   * stop it, so the position is remembered — in a ref, since nothing on screen depends on it.
   *
   * These three read `tabsRef`/`marksRef`, not `tabs`: a dependency would remake them, and the
   * project list, on every push.
   */
  const busyCursor = useRef<Record<string, string>>({});
  const showBusy = useCallback(
    (projectId: string) => {
      const working = (tabsRef.current[projectId] ?? []).filter(isWorking);
      if (working.length === 0) {
        return;
      }
      // -1 when the last shown tab stopped or is gone; the index wraps.
      const at = working.findIndex((tab) => tab.tabId === busyCursor.current[projectId]);
      const next = working[(at + 1) % working.length];
      busyCursor.current[projectId] = next.tabId;
      showTab(projectId, next.tabId);
    },
    [showTab]
  );

  /** The project row's marks: the oldest finished session first, and the longest-waiting question. */
  const [showFinished, showWaiting] = useMemo(() => {
    const showFirst = (mark: "finished" | "waiting") => (projectId: string) => {
      const next = marksRef.current[projectId]?.[mark][0];
      if (next) {
        showTab(projectId, next);
      }
    };
    return [showFirst("finished"), showFirst("waiting")];
  }, [showTab]);

  /**
   * Tabs in front (`inFront`) count as seen, so their finished mark clears — behind a dialog or
   * another window it stays until the user is back. Main holds the mark but cannot see the screen.
   * Only the bubble: a question is hidden while in front (`markedTabs`), not cleared, and reporting
   * it would cost an IPC per push.
   */
  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    for (const tab of tabs[activeProjectId] ?? []) {
      if (inFront.includes(tab.tabId) && tab.finishedAt !== undefined) {
        window.tet.terminals.seen(activeProjectId, tab.tabId);
      }
    }
  }, [activeProjectId, inFront, tabs]);

  /** A shell tab — the project row's "terminal". */
  const openTerminal = useCallback(
    (projectId: string) => {
      void window.tet.terminals.create(projectId, "shell").then((tab) => showTab(projectId, tab.tabId));
    },
    [showTab]
  );

  /**
   * Ctrl/Cmd+Shift+U, across all projects: the longest-waiting question, else the oldest finished
   * turn out of sight — so an unvisited project is not missed.
   */
  const showNeedsAttention = useCallback(() => {
    // Through `markedTabs`, so the "not on screen" rule stays in one place.
    const collect = (field: "waitingAt" | "finishedAt"): { projectId: string; tab: TerminalDescriptor }[] =>
      Object.keys(tabs)
        .flatMap((projectId) => markedTabs(projectId, field).map((tab) => ({ projectId, tab })))
        .sort((a, b) => (a.tab[field] ?? 0) - (b.tab[field] ?? 0));
    const next = collect("waitingAt")[0] ?? collect("finishedAt")[0];
    if (next) {
      showTab(next.projectId, next.tab.tabId);
    }
  }, [tabs, markedTabs, showTab]);

  /** Ctrl/Cmd+Shift+./, — within the focused pane. */
  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (!activeProjectId) {
        return;
      }
      const layout = layouts[activeProjectId] ?? DEFAULT_LAYOUT;
      const list = (stripTabs[activeProjectId] ?? []).filter((tab) => paneOf(layout, tab.tabId) === layout.focusedPane);
      if (list.length === 0) {
        return;
      }
      const at = list.findIndex((tab) => tab.tabId === layout.activeTab[layout.focusedPane]);
      const next = list[(at + direction + list.length) % list.length];
      activateTab(activeProjectId, next.tabId, layout.focusedPane);
    },
    [activeProjectId, stripTabs, layouts, activateTab]
  );

  /** Ctrl/Cmd+Shift+T. */
  const newShellTab = useCallback(() => {
    if (activeProjectId) {
      openTerminal(activeProjectId);
    }
  }, [activeProjectId, openTerminal]);

  /**
   * Refresh on window focus, for changes the watcher missed. Only the project on screen — each
   * other would cost three git processes for a state nobody reads.
   */
  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    const onFocus = (): void => {
      void window.tet.repository.refresh(activeProjectId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeProjectId]);

  /**
   * The window's shortcuts, on `document` in the capture phase to beat xterm's textarea listener.
   * xterm never encodes any of them — see `shortcuts.ts`.
   */
  // A ref: the actions are remade on every tab push, the listener is registered once.
  const shortcutActions = useRef({ toggleSideView, showNeedsAttention, cycleTab, newShellTab });
  shortcutActions.current = { toggleSideView, showNeedsAttention, cycleTab, newShellTab };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const actions = shortcutActions.current;
      let run: (() => void) | undefined;
      if (matchesShortcut(event, "settings")) {
        // Never over another dialog: Escape closes the last one opened (use-escape.ts), which has
        // to be the one on top — an agent's environment dialog, drawn last, can already be up.
        run = () => !isWindowCovered() && setSettingsOpen(true);
      } else if (matchesShortcut(event, "toggleGit")) {
        run = () => actions.toggleSideView("git");
      } else if (matchesShortcut(event, "toggleFiles")) {
        run = () => actions.toggleSideView("files");
      } else if (matchesShortcut(event, "needsAttention")) {
        run = actions.showNeedsAttention;
      } else if (matchesShortcut(event, "nextTab")) {
        run = () => actions.cycleTab(1);
      } else if (matchesShortcut(event, "previousTab")) {
        run = () => actions.cycleTab(-1);
      } else if (matchesShortcut(event, "newShellTab")) {
        run = actions.newShellTab;
      }
      if (run) {
        event.preventDefault();
        event.stopPropagation();
        run();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_REPOSITORY_STATE;

  // Stable handles, so memoized views re-render only for what they show.
  const openAdd = useCallback(() => setAddOpen(true), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSbxSettings = useCallback(
    (projectId: string) => setSbxSettingsProject(projects.find((candidate) => candidate.id === projectId) ?? null),
    [projects]
  );
  const closeSbxSettings = useCallback(() => setSbxSettingsProject(null), []);
  /**
   * The project row's git mark: switches to the project and slides git out; on the shown project,
   * the strip's toggle.
   */
  const showChanges = useCallback(
    (projectId: string) => {
      setActiveProjectId(projectId);
      if (projectId === activeProjectIdRef.current) {
        toggleSideView("git");
      } else {
        setFilesShown(false);
        if (sideViewRef.current === null) {
          slidePane(true);
        }
      }
    },
    [toggleSideView, setFilesShown, slidePane]
  );
  /**
   * Shows a file in an editor tab (the preview rule: `editor-tab.ts`), the way `how` asks for
   * (`OpenEditor`). A path already open is brought to front, kept if asked; else the preview tab
   * takes it, unless `keep`; else a new tab.
   * The editor is told before the tab draws, since the tab attaches what it made; the tab is
   * activated before it appears in `stripTabs`, as a new terminal tab is — both in one handler, so
   * the layout and the list agree on the first render.
   *
   * A tab already open only ever has its diff switched on, never off, so opening a file again
   * leaves what the user chose there (`showDiff`).
   *
   * Handed as is to every way in but the changes list (`openActiveDiff`) — the Explorer, its
   * search, a path ctrl-clicked in a terminal, a Markdown preview's link: the file itself, in the
   * project the view names.
   */
  const openEditor = useCallback(
    (projectId: string, path: string, how: OpenEditor = {}) => {
      const open = editorTabsRef.current[projectId]?.find((tab) => tab.path === path);
      const preview = how.keep ? undefined : previewEditorTab(projectId);
      let tabId: string;
      if (open) {
        tabId = open.tabId;
        if (how.keep) {
          keepEditor(tabId);
        }
        if (how.markdownPreview) {
          showMarkdownPreview(tabId, true);
        }
        if (how.diff) {
          showDiff(tabId, true);
        }
        if (how.reveal) {
          revealEditorMatch(tabId, how.reveal);
        }
      } else if (preview !== undefined) {
        tabId = preview;
        openEditorFile(projectId, tabId, path, true, how);
        setEditorTabs((current) => ({
          ...current,
          [projectId]: (current[projectId] ?? []).map((tab) => (tab.tabId === tabId ? { ...tab, path } : tab))
        }));
      } else {
        tabId = nextEditorTabId();
        openEditorFile(projectId, tabId, path, how.keep !== true, how);
        setEditorTabs((current) => ({ ...current, [projectId]: [...(current[projectId] ?? []), { tabId, projectId, path }] }));
      }
      activateTab(projectId, tabId);
    },
    [activateTab]
  );
  // A file the control channel asked for, brought to front.
  useEffect(
    () =>
      window.tet.repository.onOpenEditor(({ projectId, path, keep }) => {
        setActiveProjectId(projectId);
        openEditor(projectId, path, { keep });
      }),
    [openEditor]
  );
  useEffect(() => {
    const offRequest = window.tet.environment.onRequest(setEnvRequest);
    const offWithdrawn = window.tet.environment.onWithdrawn((id) =>
      setEnvRequest((current) => (current?.id === id ? null : current))
    );
    return () => {
      offRequest();
      offWithdrawn();
    };
  }, []);
  const closeEnvRequest = useCallback(() => setEnvRequest(null), []);
  const agents = useAgents();
  /** The changes list's, the one view that opens a file against HEAD. */
  const openActiveDiff = useCallback(
    (path: string, how?: OpenEditor) => {
      if (activeProjectId) {
        openEditor(activeProjectId, path, { ...how, diff: true });
      }
    },
    [activeProjectId, openEditor]
  );
  /** Disposes the editors; the layout collapses a pane left empty. */
  const closeEditors = useCallback((projectId: string, tabIds: string[]) => {
    void canDiscardEdits(tabIds).then((discard) => {
      if (!discard) {
        return;
      }
      setEditorTabs((current) => {
        const rest = (current[projectId] ?? []).filter((tab) => !tabIds.includes(tab.tabId));
        return rest.length > 0 ? { ...current, [projectId]: rest } : forget(current, projectId);
      });
      for (const tabId of tabIds) {
        disposeEditor(tabId);
      }
    });
  }, []);

  return (
    <div className="app">
      {/* The drag region and the window controls' space. */}
      <div className="titlebar">
        <img className="titlebar-icon" src="icon.png" alt="" />
        <span className="titlebar-name">TET</span>
      </div>

      <div className="body">
        <div className="sidebar" style={{ width: sidebarWidth }}>
          <ProjectList
            projects={projects}
            activeProjectId={activeProjectId}
            onSelect={setActiveProjectId}
            onClose={closeProject}
            onReorder={reorderProjects}
            onAdd={openAdd}
            heads={heads}
            marks={marks}
            sandboxed={sandboxed}
            onShowChanges={showChanges}
            onOpenTerminal={openTerminal}
            onShowBusy={showBusy}
            onShowFinished={showFinished}
            onShowWaiting={showWaiting}
            onSbxSettings={openSbxSettings}
            runIn={runInProject}
            gitBusy={projectListBusy}
            worktreesSupported={worktreesSupported}
          />
          <Sash
            orientation="horizontal"
            size={commandsHeight}
            min={MIN_PANE_HEIGHT}
            minOther={MIN_PANE_HEIGHT}
            reverse
            onResize={setCommandsHeight}
          />
          <CommandList projectId={activeProjectId} height={commandsHeight} editable={!activeProject?.mainPath} onOpenTab={showTab} />
        </div>
        <Sash
          orientation="vertical"
          size={sidebarWidth}
          min={MIN_PANE_WIDTH}
          minOther={MIN_CONTENT_WIDTH}
          onResize={setSidebarWidth}
        />

        {/* One side pane for all projects, in the DOM at width 0 while in (so a slide has a box to
            transition). Both views stay mounted, hidden while not shown, so a switch keeps
            selection, filter, open folders and a running action's bar. */}
        {activeProject && (
          <>
            <div
              className={`side-pane${sideSliding ? " sliding" : ""}`}
              style={{ width: sideView ? sidePaneWidth : 0 }}
              onTransitionEnd={stopSliding}
            >
              <FilesPane
                project={activeProject}
                state={activeState}
                shown={sideView === "files"}
                openPath={
                  activeProjectId
                    ? (editorTabs[activeProjectId]?.find((tab) => tab.tabId === activeEditors[activeProjectId])?.path ?? null)
                    : null
                }
                onOpenFile={openEditor}
                searchHeight={fileSearchHeight}
                onSearchHeight={setFileSearchHeight}
              />
              <GitPane
                project={activeProject}
                state={activeState}
                shown={sideView === "git"}
                branch={activeBranch}
                treeHeight={branchTreeHeight}
                onTreeHeight={setBranchTreeHeight}
                onOpenDiff={openActiveDiff}
                onOpenWorktree={openWorktree}
                canCloseWorktree={canCloseWorktree}
                worktreesSupported={worktreesSupported}
              />
            </div>
            {sideView && (
              <Sash
                orientation="vertical"
                size={sidePaneWidth}
                min={MIN_PANE_WIDTH}
                minOther={MIN_CONTENT_WIDTH}
                onResize={setSidePaneWidth}
              />
            )}
          </>
        )}

        <main className="content">
          {/* Every project's terminals stay mounted, so switching keeps buffers and processes. */}
          {projects.map((project) => (
            <TerminalsPane
              key={project.id}
              project={project}
              tabs={stripTabs[project.id] ?? NO_TABS}
              visible={project.id === activeProjectId}
              sideView={sideView}
              onToggleSideView={toggleSideView}
              agents={agents}
              // Only the bootstrap listing, which has no tab; a starting tab shows via `startingTabIds`.
              externalBusy={starting[project.id] === true && (marks[project.id]?.starting ?? NO_IDS).length === 0}
              onOpenFile={openEditor}
              onCloseEditors={closeEditors}
              layout={layouts[project.id] ?? DEFAULT_LAYOUT}
              onActivateTab={activateTab}
              onSnapTab={snapTab}
              onFocusPane={focusPane}
              onOpenSettings={openSettings}
              finishedTabIds={marks[project.id]?.finished ?? NO_IDS}
              waitingTabIds={marks[project.id]?.waiting ?? NO_IDS}
              startingTabIds={marks[project.id]?.starting ?? NO_IDS}
            />
          ))}
          {!activeProject && (
            <div className="empty-workspace">
              <p>No repository open.</p>
              <button className="button" onClick={openAdd}>
                <PlusIcon />
                <span>Add repository</span>
              </button>
            </div>
          )}
        </main>
      </div>

      {addOpen && <AddRepositoryDialog onClose={closeAdd} />}

      {settingsOpen && <SettingsDialog activeProject={activeProject?.mainPath ? null : activeProject} onClose={closeSettings} />}
      {sbxSettingsProject && <SbxSettingsDialog project={sbxSettingsProject} onClose={closeSbxSettings} />}
      {envRequest && (
        <EnvDialog
          key={envRequest.id}
          request={envRequest}
          requester={requesterOf(envRequest, projects, tabs, agents)}
          onClose={closeEnvRequest}
        />
      )}

      <Notices />
      <Dialogs />
    </div>
  );
}
