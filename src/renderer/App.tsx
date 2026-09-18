import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMPTY_REPOSITORY_STATE, isWorking } from "../shared/types";
import type { GitActionResult, Project, RepositoryState, TerminalDescriptor } from "../shared/types";
import { AddRepositoryDialog } from "./dialogs/AddRepositoryDialog";
import { CommandList } from "./sidebar/CommandList";
import type { BranchActions } from "./git/BranchTree";
import { Dialogs } from "./ui/Dialog";
import { SbxSettingsDialog } from "./dialogs/SbxSettingsDialog";
import { FilesPane } from "./git/FilesPane";
import { GitPane } from "./git/GitPane";
import { Notices, notify } from "./ui/Notices";
import { ProjectList } from "./sidebar/ProjectList";
import type { ProjectHead, ProjectMarks } from "./sidebar/ProjectList";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import {
  MIN_CONTENT_WIDTH,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  Sash,
  usePaneSize,
  usePaneToggle
} from "./ui/Sash";
import { TerminalsPane } from "./terminal/TerminalsPane";
import type { SideView } from "./terminal/Pane";
import { clearTerminal, disposeProjectTerminals } from "./terminal/terminal-views";
import { PlusIcon } from "./ui/icons";
import { useWindowCovered } from "./ui/window-covered";
import { forget, sameList, sameRecord } from "./identity";
import { matchesShortcut } from "./shortcuts";
import { reportSlow } from "./slow-report";
import { activeEditorTab, defaultLayout, paneOf, tabsInFront } from "./terminal/pane-layout";
import { NO_TABS, useProjectLayouts } from "./terminal/use-project-layouts";
import { nextEditorTabId, type EditorTab, type PaneTab } from "./terminal/editor-tab";
import {
  canDiscardEdits,
  canDiscardProjectEdits,
  disposeEditor,
  disposeProjectEditors,
  editorContent,
  keepEditor,
  openEditorFile,
  previewEditorTab,
  setEditorVersion
} from "./diff/editor-views";

/** A little over `.side-pane.sliding`'s 0.15s, so the class outlives the transition. */
const SIDE_PANE_SLIDE_MS = 180;

/** What an open file is re-read for: HEAD's branch and commit (so a pull or reset counts), the
 *  file's status, and a write on disk (`writes`), which leaves a modified file's status unchanged. */
function diffVersion(state: RepositoryState | undefined, filePath: string, writes: number | undefined): string {
  return `${state?.head}:${state?.headCommit}:${state?.changes.find((change) => change.path === filePath)?.status}:${writes ?? 0}`;
}

/** Shared instance, so a pane's props stay identical for a project with none. */
const NO_IDS: string[] = [];
const DEFAULT_LAYOUT = defaultLayout();

let renderStartedAt = 0;

export function App() {
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
  /** Per project, per watched path: writes on disk — see diffVersion. */
  const [fileWrites, setFileWrites] = useState<Record<string, Record<string, number>>>({});
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
   * through `onActivateTab`. See "Split view" in CLAUDE.md.
   */
  const { layouts, activateTab, snapTab, focusPane, placeTab, forgetLayout } = useProjectLayouts(
    stripTabs,
    starting
  );
  /** Projects with a branch command in flight — per project: a fetch ending in A must not free B. */
  const [branchActions, setBranchActions] = useState<ReadonlySet<string>>(() => new Set());
  /** Read synchronously: a second double-click can land before a re-render. */
  const branchActionsRef = useRef(new Set<string>());
  // Pane defaults and limits; both side-pane views share the two below ("git-panels" predates the
  // files view).
  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebar", 240, MIN_PANE_WIDTH);
  const [sidePaneWidth, setSidePaneWidth] = usePaneSize("git-panels", 300, MIN_PANE_WIDTH);
  const [branchTreeHeight, setBranchTreeHeight] = usePaneSize("branch-tree", 260, MIN_PANE_HEIGHT);
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
  /**
   * `sideMounted` keeps the pane in the DOM through the closing transition; `sideExpanded` drives
   * the width. Two nested rAFs before expanding: one alone often fires before the 0-width paint
   * (observed), skipping the slide. Switching views while out slides nothing.
   */
  const [sideMounted, setSideMounted] = useState(sidePaneOpen);
  const [sideExpanded, setSideExpanded] = useState(sidePaneOpen);
  /**
   * Gates `.side-pane.sliding`'s transition to the slide alone: the sash sets the same width, and an
   * animated one would lag the pointer.
   */
  const [sideSliding, setSideSliding] = useState(false);
  useEffect(() => {
    setSideSliding(true);
    let stop: ReturnType<typeof setTimeout> | undefined;
    if (sidePaneOpen) {
      setSideMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          setSideExpanded(true);
          stop = setTimeout(() => setSideSliding(false), SIDE_PANE_SLIDE_MS);
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        clearTimeout(stop);
      };
    }
    setSideExpanded(false);
    stop = setTimeout(() => {
      setSideMounted(false);
      setSideSliding(false);
    }, SIDE_PANE_SLIDE_MS);
    return () => clearTimeout(stop);
  }, [sidePaneOpen]);
  /** Shows that view, or slides the pane in when that view is already out. */
  const toggleSideView = useCallback(
    (view: SideView) => {
      if (sideView === view) {
        setSidePaneOpen(false);
        return;
      }
      setFilesShown(view === "files");
      setSidePaneOpen(true);
    },
    [sideView, setFilesShown, setSidePaneOpen]
  );
  const [addOpen, setAddOpen] = useState(false);
  /** Window-wide, not per project. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sbxSettingsProject, setSbxSettingsProject] = useState<Project | null>(null);
  /**
   * Each tet.json's `sbx.enabled`, replaced only where it changed (the memoized list re-renders
   * otherwise). Any writer of that file (dialog, agent, editor, checkout) arrives as `commands:changed`.
   */
  const [sandboxed, setSandboxed] = useState<Record<string, boolean>>({});

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
      // it off screen (the old output has arrived by then, the new one's has not).
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
      setActiveProjectId((current) => current ?? stored[0]?.id ?? null);
      const loaded = await Promise.all(
        stored.map(async (project) => {
          const [state, list, isStarting] = await Promise.all([
            window.tet.repository.state(project.id),
            window.tet.terminals.list(project.id),
            window.tet.terminals.starting(project.id)
          ]);
          return [project.id, state, list, isStarting] as const;
        })
      );
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

  /** The add-repository dialog's result. With no agent installed the project can only run
   *  sandboxed, so its sbx settings open at once — locked (see SbxSettingsDialog). */
  const projectAdded = useCallback((project: Project) => {
    setProjects((current) => (current.some((entry) => entry.id === project.id) ? current : [...current, project]));
    setActiveProjectId(project.id);
    void window.tet.startup.anyAgentInstalled().then((installed) => {
      if (!installed) {
        setSbxSettingsProject(project);
      }
    });
  }, []);

  /** A branch's worktree from the git pane: its project, else the folder opened as one. */
  const openWorktree = useCallback(
    async (worktreePath: string) => {
      const open = projectsRef.current.find((project) => project.path === worktreePath);
      if (open) {
        setActiveProjectId(open.id);
        return;
      }
      const result = await window.tet.projects.open(worktreePath);
      if (result.project) {
        projectAdded(result.project);
      } else {
        notify("error", result.error ?? `Could not open ${worktreePath}`);
      }
    },
    [projectAdded]
  );

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
    setEditorTabs((current) => forget(current, projectId));
    setFileWrites((current) => forget(current, projectId));
    disposeProjectEditors(projectId);
    forgetLayout(projectId);
    busyCursor.current = forget(busyCursor.current, projectId);
    // The xterms live outside React; this is where a project ends for good.
    disposeProjectTerminals(projectId);
  }, [forgetLayout]);

  const closeProject = useCallback(
    async (projectId: string) => {
      if (!(await canDiscardProjectEdits(projectId))) {
        return;
      }
      await window.tet.projects.remove(projectId);
      const remaining = projectsRef.current.filter((project) => project.id !== projectId);
      setProjects(remaining);
      setActiveProjectId((current) => (current === projectId ? (remaining[0]?.id ?? null) : current));
      forgetProject(projectId);
    },
    [forgetProject]
  );

  // The control channel opened or closed a project: the same paths as the dialog's add and the
  // row's close.
  useEffect(
    () =>
      window.tet.projects.onChanged(({ projects: list, added, removed }) => {
        setProjects(list);
        if (removed !== undefined) {
          setActiveProjectId((current) => (current === removed ? (list[0]?.id ?? null) : current));
          forgetProject(removed);
        }
        if (added !== undefined) {
          setActiveProjectId(added);
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

  // Every tet.json write is one `commands:changed`, shared with the saved commands.
  useEffect(() => {
    for (const project of projects) {
      void readSandboxed(project.id);
    }
    return window.tet.commands.onChanged(({ projectId }) => void readSandboxed(projectId));
  }, [projects, readSandboxed]);

  const reorderProjects = useCallback((ordered: Project[]) => {
    setProjects(ordered);
    void window.tet.projects.reorder(ordered.map((project) => project.id));
  }, []);

  /**
   * One branch command per project at a time: a second click mid-switch would stack two `git switch`.
   * Mirrors `Repository.runAction`; `BranchActions.run` is the one way in, a view asking its own
   * question first.
   */
  const runBranchAction = useCallback(
    async (projectId: string, label: string, action: () => Promise<GitActionResult>) => {
      if (branchActionsRef.current.has(projectId)) {
        return;
      }
      branchActionsRef.current.add(projectId);
      setBranchActions(new Set(branchActionsRef.current));
      try {
        const result = await action();
        if (!result.ok) {
          notify("error", result.error ?? `${label} failed`);
        }
      } finally {
        branchActionsRef.current.delete(projectId);
        setBranchActions(new Set(branchActionsRef.current));
      }
    },
    []
  );

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
    let changed = Object.keys(marksRef.current).length !== Object.keys(tabs).length;
    for (const projectId of Object.keys(tabs)) {
      const previous = marksRef.current[projectId];
      const entry: ProjectMarks = {
        finished: sameList(previous?.finished, markedTabs(projectId, "finishedAt").map((tab) => tab.tabId), NO_IDS),
        waiting: sameList(previous?.waiting, markedTabs(projectId, "waitingAt").map((tab) => tab.tabId), NO_IDS),
        starting: sameList(previous?.starting, startingTabs(projectId).map((tab) => tab.tabId), NO_IDS),
        busy: (tabs[projectId] ?? []).some(isWorking)
      };
      next[projectId] =
        previous &&
        previous.finished === entry.finished &&
        previous.waiting === entry.waiting &&
        previous.starting === entry.starting &&
        previous.busy === entry.busy
          ? previous
          : entry;
      changed ||= next[projectId] !== previous;
    }
    if (!changed) {
      return marksRef.current;
    }
    marksRef.current = next;
    return next;
  }, [tabs, markedTabs, startingTabs]);

  /**
   * The project row's HEAD, first remote and dirty flag, identity-stable where unchanged (`states`
   * is fresh on every push). No git call of its own: `changes` comes with every refresh.
   */
  const headsRef = useRef<Record<string, ProjectHead>>({});
  const heads = useMemo(() => {
    const next: Record<string, ProjectHead> = {};
    let changed = Object.keys(headsRef.current).length !== Object.keys(states).length;
    for (const [projectId, state] of Object.entries(states)) {
      const previous = headsRef.current[projectId];
      const remote = state.remotes[0];
      const dirty = state.changes.length > 0;
      next[projectId] =
        previous &&
        previous.head === state.head &&
        previous.detached === state.detached &&
        previous.upstream === state.upstream &&
        previous.remote?.name === remote?.name &&
        previous.remote?.url === remote?.url &&
        previous.dirty === dirty
          ? previous
          : { head: state.head, detached: state.detached, upstream: state.upstream, remote, dirty };
      changed ||= next[projectId] !== previous;
    }
    if (!changed) {
      return headsRef.current;
    }
    headsRef.current = next;
    return next;
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

  /** The project row's mark: the oldest finished session first. */
  const showFinished = useCallback(
    (projectId: string) => {
      const next = marksRef.current[projectId]?.finished[0];
      if (next) {
        showTab(projectId, next);
      }
    },
    [showTab]
  );

  /** The same, for the longest-waiting question. */
  const showWaiting = useCallback(
    (projectId: string) => {
      const next = marksRef.current[projectId]?.waiting[0];
      if (next) {
        showTab(projectId, next);
      }
    },
    [showTab]
  );

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
        run = () => setSettingsOpen(true);
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
  const closeProjectSync = useCallback((projectId: string) => void closeProject(projectId), [closeProject]);
  const openAdd = useCallback(() => setAddOpen(true), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSbxSettings = useCallback(
    (projectId: string) => setSbxSettingsProject(projects.find((candidate) => candidate.id === projectId) ?? null),
    [projects]
  );
  const closeSbxSettings = useCallback(() => setSbxSettingsProject(null), []);
  const toggleGit = useCallback(() => toggleSideView("git"), [toggleSideView]);
  const toggleFiles = useCallback(() => toggleSideView("files"), [toggleSideView]);
  /**
   * The project row's git mark: switches to the project and slides git out; on the shown project,
   * the strip's toggle.
   */
  const showChanges = useCallback(
    (projectId: string) => {
      setActiveProjectId(projectId);
      if (projectId === activeProjectId) {
        toggleSideView("git");
      } else {
        setFilesShown(false);
        setSidePaneOpen(true);
      }
    },
    [activeProjectId, toggleSideView, setFilesShown, setSidePaneOpen]
  );
  /**
   * Shows a file in an editor tab (the preview rule: `editor-tab.ts`). A path already open is
   * brought to front, kept if asked; else the preview tab takes it, unless `keep`; else a new tab.
   * The editor is told before the tab draws, since the tab attaches what it made; the tab is
   * activated before it appears in `stripTabs`, as a new terminal tab is — both in one handler, so
   * the layout and the list agree on the first render.
   */
  const openDiff = useCallback(
    (projectId: string, path: string, keep = false) => {
      const open = editorTabsRef.current[projectId]?.find((tab) => tab.path === path);
      const preview = keep ? undefined : previewEditorTab(projectId);
      let tabId: string;
      if (open) {
        tabId = open.tabId;
        if (keep) {
          keepEditor(tabId);
        }
      } else if (preview !== undefined) {
        tabId = preview;
        openEditorFile(projectId, tabId, path, true);
        setEditorTabs((current) => ({
          ...current,
          [projectId]: (current[projectId] ?? []).map((tab) => (tab.tabId === tabId ? { ...tab, path } : tab))
        }));
      } else {
        tabId = nextEditorTabId();
        openEditorFile(projectId, tabId, path, !keep);
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
        openDiff(projectId, path, keep);
      }),
    [openDiff]
  );
  useEffect(
    () =>
      window.tet.repository.onEditorContentRequest((projectId) => {
        const tabId = activeEditorsRef.current[projectId];
        return tabId === undefined ? undefined : editorContent(tabId);
      }),
    []
  );
  const openActiveDiff = useCallback(
    (path: string, keep?: boolean) => {
      if (activeProjectId) {
        openDiff(activeProjectId, path, keep);
      }
    },
    [activeProjectId, openDiff]
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
  /**
   * Each project's active editor tab (`activeEditorTab`) — the file the Explorer reveals and
   * `tet-ctl editor-state` answers. Derived, not tracked: a tab is activated from many places (a
   * click, next/previous, a drop, a snap). Identity-stable where unchanged.
   */
  const activeEditorsRef = useRef<Record<string, string>>({});
  const activeEditors = useMemo(() => {
    const next: Record<string, string> = {};
    for (const [projectId, editors] of Object.entries(editorTabs)) {
      const tabId = activeEditorTab(
        layouts[projectId] ?? DEFAULT_LAYOUT,
        editors.map((tab) => tab.tabId),
        activeEditorsRef.current[projectId]
      );
      if (tabId !== undefined) {
        next[projectId] = tabId;
      }
    }
    activeEditorsRef.current = sameRecord(activeEditorsRef.current, next);
    return activeEditorsRef.current;
  }, [editorTabs, layouts]);
  // Reported to main as `inFront` is: only App knows. A project whose last editor tab closed
  // reports nothing; main finds no report under the old id.
  const reportedActive = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [projectId, tabId] of Object.entries(activeEditors)) {
      if (reportedActive.current[projectId] !== tabId) {
        window.tet.repository.reportActiveEditor(projectId, tabId);
      }
    }
    reportedActive.current = activeEditors;
  }, [activeEditors]);
  // Each editor tab's file, whose writes the watcher reports (onFileChanged): a project's open
  // paths, sent when they change.
  const watchedFiles = useRef<Record<string, string[]>>({});
  useEffect(() => {
    const previous = watchedFiles.current;
    const next: Record<string, string[]> = {};
    for (const [projectId, editors] of Object.entries(editorTabs)) {
      next[projectId] = sameList(previous[projectId], editors.map((tab) => tab.path).sort(), NO_IDS);
    }
    for (const [projectId, paths] of Object.entries(next)) {
      if (previous[projectId] !== paths) {
        void window.tet.repository.watchFiles(projectId, paths);
      }
    }
    for (const projectId of Object.keys(previous)) {
      if (!(projectId in next)) {
        void window.tet.repository.watchFiles(projectId, NO_IDS);
      }
    }
    watchedFiles.current = next;
  }, [editorTabs]);
  useEffect(
    () =>
      // Only watched paths are reported; a count left by a closed tab is inert.
      window.tet.repository.onFileChanged(({ projectId, path }) => {
        setFileWrites((current) => ({
          ...current,
          [projectId]: { ...current[projectId], [path]: (current[projectId]?.[path] ?? 0) + 1 }
        }));
      }),
    []
  );
  // Reloads an open file only when its diffVersion changes, not on every push: a reload re-reads
  // and recolours the whole diff, hundreds of ms for a long file.
  useEffect(() => {
    for (const [projectId, editors] of Object.entries(editorTabs)) {
      for (const { tabId, path } of editors) {
        setEditorVersion(tabId, diffVersion(states[projectId], path, fileWrites[projectId]?.[path]));
      }
    }
  }, [editorTabs, states, fileWrites]);
  const runActiveBranchAction = useCallback(
    (label: string, action: () => Promise<GitActionResult>) => {
      if (activeProjectId) {
        void runBranchAction(activeProjectId, label, action);
      }
    },
    [activeProjectId, runBranchAction]
  );
  /** The git pane's actions, for the project on screen. */
  const activeBranch = useMemo<BranchActions>(
    () => ({ busy: activeProjectId !== null && branchActions.has(activeProjectId), run: runActiveBranchAction }),
    [branchActions, activeProjectId, runActiveBranchAction]
  );

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
            onClose={closeProjectSync}
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
            onGitAction={runBranchAction}
          />
          <Sash
            orientation="horizontal"
            size={commandsHeight}
            min={MIN_PANE_HEIGHT}
            minOther={MIN_PANE_HEIGHT}
            reverse
            onResize={setCommandsHeight}
          />
          <CommandList projectId={activeProjectId} height={commandsHeight} onOpenTab={showTab} />
        </div>
        <Sash
          orientation="vertical"
          size={sidebarWidth}
          min={MIN_PANE_WIDTH}
          minOther={MIN_CONTENT_WIDTH}
          onResize={setSidebarWidth}
        />

        {/* One side pane for all projects. Both views stay mounted while it is out, one hidden, so
            a switch keeps selection, filter, open folders and a running action's bar. */}
        {sideMounted && activeProject && (
          <>
            <div
              className={`side-pane${sideSliding ? " sliding" : ""}`}
              style={{ width: sideExpanded ? sidePaneWidth : 0 }}
            >
              <FilesPane
                project={activeProject}
                state={activeState}
                shown={filesShown}
                openPath={
                  activeProjectId
                    ? (editorTabs[activeProjectId]?.find((tab) => tab.tabId === activeEditors[activeProjectId])?.path ?? null)
                    : null
                }
                onOpen={openActiveDiff}
              />
              <GitPane
                project={activeProject}
                state={activeState}
                shown={!filesShown}
                branch={activeBranch}
                treeHeight={branchTreeHeight}
                onTreeHeight={setBranchTreeHeight}
                onOpenDiff={openActiveDiff}
                onOpenWorktree={openWorktree}
                canCloseWorktree={canCloseWorktree}
              />
            </div>
            {sidePaneOpen && (
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
              onToggleGit={toggleGit}
              onToggleFiles={toggleFiles}
              // Only the bootstrap listing, which has no tab; a starting tab shows via `startingTabIds`.
              externalBusy={starting[project.id] === true && (marks[project.id]?.starting ?? NO_IDS).length === 0}
              onOpenDiff={openDiff}
              onCloseEditors={closeEditors}
              layout={layouts[project.id] ?? DEFAULT_LAYOUT}
              onActivateTab={activateTab}
              onSnapTab={snapTab}
              onFocusPane={focusPane}
              onOpenSettings={openSettings}
              markedTabIds={marks[project.id]?.finished ?? NO_IDS}
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

      {addOpen && <AddRepositoryDialog onAdded={projectAdded} onClose={closeAdd} />}

      {settingsOpen && <SettingsDialog activeProject={activeProject} onClose={closeSettings} />}
      {sbxSettingsProject && <SbxSettingsDialog project={sbxSettingsProject} onClose={closeSbxSettings} />}

      <Notices />
      <Dialogs />
    </div>
  );
}
