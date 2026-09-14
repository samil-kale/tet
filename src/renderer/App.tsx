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
import { forget, sameList } from "./identity";
import { matchesShortcut } from "./shortcuts";
import { reportSlow } from "./slow-report";
import { defaultLayout, paneOf, tabsInFront } from "./terminal/pane-layout";
import { NO_TABS, useProjectLayouts } from "./terminal/use-project-layouts";
import { EDITOR_TAB_ID, type EditorTab, type PaneTab } from "./terminal/editor-tab";
import { canDiscardEdit, disposeEditor, openEditorFile, setEditorVersion } from "./diff/editor-views";

/** A little over `.side-pane.sliding`'s 0.15s, so the class outlives the transition. */
const SIDE_PANE_SLIDE_MS = 180;

/** What an open file has to be re-read for: HEAD — the branch and the commit it is at, so a pull or
 *  a reset moving it is one too — and the status of the file it shows. */
function diffVersion(state: RepositoryState | undefined, filePath: string): string {
  return `${state?.head}:${state?.headCommit}:${state?.changes.find((change) => change.path === filePath)?.status}`;
}

/** Shared instance, so a pane's props stay identical for a project with none. */
const NO_IDS: string[] = [];
const DEFAULT_LAYOUT = defaultLayout();

/** When App's current render began — read by the layout effect at the top of App. */
let renderStartedAt = 0;

export function App() {
  renderStartedAt = performance.now();
  // From App's render to its commit: the whole tree that re-rendered with it, which is what a
  // state change here costs (React's Profiler reports nothing in a production build). A subtree
  // re-rendering on its own is not seen.
  useLayoutEffect(() => {
    reportSlow("render", performance.now() - renderStartedAt);
  });
  const [projects, setProjects] = useState<Project[]>([]);
  /** The list as it stands after an await: the control channel can add a project meanwhile. */
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /** Every project's terminal tabs, held here because the project list needs all of them at once. */
  const [tabs, setTabs] = useState<Record<string, TerminalDescriptor[]>>({});
  /**
   * For the layout callbacks that only read it on a click: depending on `tabs` would remake them,
   * and every pane's props, on every push from any project.
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** Each project's editor tab, once a file is open — renderer-only, see `editor-tab.ts`. */
  const [editorTabs, setEditorTabs] = useState<Record<string, EditorTab>>({});
  const editorTabsRef = useRef(editorTabs);
  editorTabsRef.current = editorTabs;
  /**
   * What each project's tab strip holds: its terminals, and its editor tab last. What the layout
   * is reconciled against, what the panes draw and what next/previous tab step through; the marks
   * and `seen` stay on `tabs`, the editor tab having no turns. The same list as `tabs` for a project
   * with no file open, so the panes' props keep their identity; for one with a file open, the
   * previous list while neither its terminals nor its editor tab changed.
   */
  const stripTabsRef = useRef<Record<string, PaneTab[]>>({});
  const stripTabs = useMemo(() => {
    const next: Record<string, PaneTab[]> = { ...tabs };
    for (const [projectId, editor] of Object.entries(editorTabs)) {
      next[projectId] = sameList(stripTabsRef.current[projectId], [...(tabs[projectId] ?? []), editor], NO_TABS);
    }
    stripTabsRef.current = next;
    return next;
  }, [tabs, editorTabs]);
  /**
   * Which projects still have something starting up (bootstrap listing, a CLI booting). Read by
   * the active project's progress bar and by the layout persistence.
   */
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  /**
   * Each project's split state, held here rather than in `TerminalsPane` because the shortcuts and
   * the marks/seen logic need what is on screen across every pane — see "Split view" in CLAUDE.md.
   */
  const { layouts, activateTab, snapTab, focusPane, placeTab, forgetLayout } = useProjectLayouts(
    stripTabs,
    starting
  );
  /**
   * Projects with a branch command in flight. Per project, not one slot for the window: a fetch
   * finishing in A must not free B's tree.
   */
  const [branchActions, setBranchActions] = useState<ReadonlySet<string>>(() => new Set());
  /** The same, read synchronously: a second double-click can land before a re-render does. */
  const branchActionsRef = useRef(new Set<string>());
  // Defaults and limits of the draggable panes; the one side pane shares the two below, whichever
  // view it shows (the width keeps its key from when it held git alone).
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
   * Whether the side pane is out, and whether it shows the files rather than the repository —
   * remembered like a pane size. Two views of one pane, never both (VS Code's Explorer and Source
   * Control in one sidebar); `open` keeps its key from when the pane held git alone.
   */
  const [sidePaneOpen, setSidePaneOpen] = usePaneToggle("git-pane", false);
  const [filesShown, setFilesShown] = usePaneToggle("side-pane-files", false);
  const sideView: SideView | null = sidePaneOpen ? (filesShown ? "files" : "git") : null;
  /**
   * `sideMounted` keeps the pane in the DOM through the closing transition; `sideExpanded` drives
   * the width transition. Two nested rAFs before expanding: one alone fires before the 0-width
   * paint as often as after it (observed), which jumped straight to full width. A switch between
   * the two views while the pane is out slides nothing.
   */
  const [sideMounted, setSideMounted] = useState(sidePaneOpen);
  const [sideExpanded, setSideExpanded] = useState(sidePaneOpen);
  /**
   * Whether the slide is running, which is what `.side-pane.sliding` transitions on. Not permanent:
   * the sash sets the same width, and an animated one lags the pointer by the whole duration.
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
  /** A view's button: shows that view, or slides the pane in when it is the one already out. */
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
  /** Whether the add-repository dialog (clone, add, create) is up. */
  const [addOpen, setAddOpen] = useState(false);
  /** Whether the settings are up; they belong to the window, not to a project. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The project the "SBX Settings" dialog is up for, if any. */
  const [sbxSettingsProject, setSbxSettingsProject] = useState<Project | null>(null);
  /**
   * Which projects run their agents in an sbx sandbox — the `sbx.enabled` of each repository's
   * tet.json, by identity only where the answer changed (the memoized list re-renders otherwise).
   * Any writer of that file (dialog, agent, editor, checkout) arrives as `commands:changed`.
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
      // A status arrives alone, not as a list: patch the one tab it names.
      window.tet.terminals.onStatus(({ projectId, tabId, status }) => {
      // A saved command's restart kills the process first, and the kill writes a trailing "^C";
      // clearing once the respawned process runs keeps that off screen (the old output has
      // arrived by then, the new one's has not).
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
      // Pushes that landed while this was in flight are newer than what was fetched.
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

  /** What the add-repository dialog ends in, whichever tab produced the project. A machine with no
   *  agent on it can only run this project in a sandbox, so its sbx settings open right away —
   *  locked, the dialog deriving that from the same question (see SbxSettingsDialog). */
  const projectAdded = useCallback((project: Project) => {
    setProjects((current) => (current.some((entry) => entry.id === project.id) ? current : [...current, project]));
    setActiveProjectId(project.id);
    void window.tet.startup.anyAgentInstalled().then((installed) => {
      if (!installed) {
        setSbxSettingsProject(project);
      }
    });
  }, []);

  /** Everything held for a project, let go of; the project list itself is the caller's. */
  const forgetProject = useCallback((projectId: string) => {
    setStates((current) => forget(current, projectId));
    setTabs((current) => forget(current, projectId));
    setStarting((current) => forget(current, projectId));
    setSandboxed((current) => forget(current, projectId));
    setEditorTabs((current) => forget(current, projectId));
    disposeEditor(projectId);
    forgetLayout(projectId);
    busyCursor.current = forget(busyCursor.current, projectId);
    // The xterm instances live outside React; this is the one moment a project ends for good.
    disposeProjectTerminals(projectId);
  }, [forgetLayout]);

  const closeProject = useCallback(
    async (projectId: string) => {
      if (!(await canDiscardEdit(projectId))) {
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
  // row's close, with the list handed over.
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

  // One tet.json write is one `commands:changed`, whichever half changed; the saved commands
  // read the same event.
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
   * One branch command per project at a time: a second click mid-switch would stack two
   * `git switch` on one repository. Per project: two repositories working at once is no conflict.
   */
  const runBranchAction = useCallback(
    async (projectId: string, label: string, action: () => Promise<GitActionResult>) => {
      if (branchActionsRef.current.has(projectId)) {
        return;
      }
      // Which project is working, not just that one is: the active project may not be the busy one.
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

  /** Shows a tab opened from outside its own pane, bringing its project to the front first. */
  const showTab = useCallback(
    (projectId: string, tabId: string, command?: string) => {
      setActiveProjectId(projectId);
      placeTab(projectId, tabId, command);
    },
    [placeTab]
  );

  // A tab the control channel opened, shown like a saved command's: drawing it starts its process.
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
   * The active project's tabs in front of the user (`tabsInFront`). The one definition the marks,
   * `seen` and the toasts (`terminals.inFront`) all go by; identity-stable, since it is reported
   * on change.
   */
  const inFrontRef = useRef<string[]>(NO_IDS);
  const inFront = useMemo(() => {
    const next = activeProjectId ? tabsInFront(layouts[activeProjectId] ?? DEFAULT_LAYOUT, focused, covered) : NO_IDS;
    inFrontRef.current = sameList(inFrontRef.current, next, NO_IDS);
    return inFrontRef.current;
  }, [focused, covered, activeProjectId, layouts]);

  // May name the editor tab, which the main process never matches against a tab of its own.
  useEffect(() => {
    window.tet.terminals.inFront(activeProjectId, inFront);
  }, [activeProjectId, inFront]);

  /**
   * Finished and waiting sessions not in front of the user, oldest first — the tab strip's marks,
   * and what the project row's marks step through. Leaves out the tabs in front: a turn that
   * finished or a question asked there was never out of sight. Decided here, once: the main process
   * holds the mark but cannot know what is on screen, and two views must not each decide.
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
   * Sessions whose own tab is what the progress bar is about — a runtime being prepared, a CLI
   * not yet past its first frame. The tab on screen is not excluded: the bar is about the pane's
   * own tabs, wherever the pane is.
   */
  const startingTabs = useCallback(
    (projectId: string): TerminalDescriptor[] => (tabs[projectId] ?? []).filter((tab) => tab.starting === true),
    [tabs]
  );

  /**
   * The three above as tab ids plus `busy` (see `ProjectMarks`), per project, identity-stable
   * where the answer is unchanged: panes and the project list take these as props, and most pushes
   * (a spinner tick) change nothing here. `busy` keeps the tab on screen (a spinner says what is
   * happening now, wherever the tab is) but excludes a tab waiting on a question: that session is
   * not working, and the two marks would otherwise stand side by side.
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
   * The project row's HEAD, first remote and dirty flag, identity-stable where unchanged: `states`
   * is a fresh record on every push. Costs no git call of its own (`changes` is part of every
   * refresh).
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
        previous.remote?.name === remote?.name &&
        previous.remote?.url === remote?.url &&
        previous.dirty === dirty
          ? previous
          : { head: state.head, remote, dirty };
      changed ||= next[projectId] !== previous;
    }
    if (!changed) {
      return headsRef.current;
    }
    headsRef.current = next;
    return next;
  }, [states]);

  /**
   * The project row's spinner: the working sessions, one per press. Watching a session does not
   * stop it working, so this remembers where it left off. A ref: it changes what the next press
   * does, nothing on screen.
   *
   * These three read `tabsRef`/`marksRef` rather than depending on `tabs`: a dependency would
   * remake them, and the project list, on every push.
   */
  const busyCursor = useRef<Record<string, string>>({});
  const showBusy = useCallback(
    (projectId: string) => {
      const working = (tabsRef.current[projectId] ?? []).filter(isWorking);
      if (working.length === 0) {
        return;
      }
      // -1 when the last shown tab has since stopped or gone; the next index wraps.
      const at = working.findIndex((tab) => tab.tabId === busyCursor.current[projectId]);
      const next = working[(at + 1) % working.length];
      busyCursor.current[projectId] = next.tabId;
      showTab(projectId, next.tabId);
    },
    [showTab]
  );

  /** The project row's mark: the session that finished first, then the next one. */
  const showFinished = useCallback(
    (projectId: string) => {
      const next = marksRef.current[projectId]?.finished[0];
      if (next) {
        showTab(projectId, next);
      }
    },
    [showTab]
  );

  /** The same, for the session that has been waiting on an answer the longest. */
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
   * Every tab in front of the user (`inFront`) has been seen, so its mark goes — a turn that
   * finished behind a dialog or while another window was in front keeps its bubble until the user
   * is back. The main process holds the mark but never learns what is on screen. Only the bubble: a
   * standing question is hidden while in front (`markedTabs`), not cleared, so reporting it would
   * be an IPC per push.
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

  /** Opens a shell tab in that project, which is what a project row offers as "terminal". */
  const openTerminal = useCallback(
    (projectId: string) => {
      void window.tet.terminals.create(projectId, "shell").then((tab) => showTab(projectId, tab.tabId));
    },
    [showTab]
  );

  /**
   * Ctrl/Cmd+Shift+U: across every project, the session waiting on a question the longest, else
   * the one that finished out of sight first — so a project nobody clicked into is not missed.
   */
  const showNeedsAttention = useCallback(() => {
    // Through `markedTabs`, so the "not the tab on screen" rule stays in one place.
    const collect = (field: "waitingAt" | "finishedAt"): { projectId: string; tab: TerminalDescriptor }[] =>
      Object.keys(tabs)
        .flatMap((projectId) => markedTabs(projectId, field).map((tab) => ({ projectId, tab })))
        .sort((a, b) => (a.tab[field] ?? 0) - (b.tab[field] ?? 0));
    const next = collect("waitingAt")[0] ?? collect("finishedAt")[0];
    if (next) {
      showTab(next.projectId, next.tab.tabId);
    }
  }, [tabs, markedTabs, showTab]);

  /** Ctrl/Cmd+Shift+./, — the focused pane's own tabs, one over. */
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

  /** Ctrl/Cmd+Shift+T — a shell tab in the project on screen. */
  const newShellTab = useCallback(() => {
    if (activeProjectId) {
      openTerminal(activeProjectId);
    }
  }, [activeProjectId, openTerminal]);

  /**
   * Refresh on window focus: when a change the watcher missed would show. Only the project on
   * screen — every open one would cost three git processes each for a state nobody reads.
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
   * The window's shortcuts, on `document` in the capture phase, so they win against xterm's own
   * listener on its textarea further down the tree. Every `matchesShortcut` combination is one
   * xterm never encodes — see `shortcuts.ts`.
   */
  // Actions in a ref: `showNeedsAttention` and `cycleTab` are remade on every tab push, and the
  // listener is registered once.
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

  // Stable handles, so a memoized view re-renders for a change in what it shows only.
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
   * The project row's git mark: switches to that project and slides the repository out. On the
   * project already on screen it is the same toggle as the one in the terminal strip.
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
   * Shows a file in the project's editor tab, which the next file reuses. The editor is told
   * before the tab is drawn, since the tab attaches what it made; the tab is activated ahead of
   * its own appearance in `stripTabs`, the way a new terminal tab is.
   */
  const openDiff = useCallback(
    async (projectId: string, path: string) => {
      if (editorTabsRef.current[projectId]?.path !== path) {
        if (!(await canDiscardEdit(projectId))) {
          return;
        }
        openEditorFile(projectId, path);
        setEditorTabs((current) => ({ ...current, [projectId]: { tabId: EDITOR_TAB_ID, projectId, path } }));
      }
      activateTab(projectId, EDITOR_TAB_ID);
    },
    [activateTab]
  );
  const openDiffSync = useCallback((projectId: string, path: string) => void openDiff(projectId, path), [openDiff]);
  const openActiveDiff = useCallback(
    (path: string) => {
      if (activeProjectId) {
        void openDiff(activeProjectId, path);
      }
    },
    [activeProjectId, openDiff]
  );
  /** Closing the tab lets go of its editor; the layout collapses a pane it leaves empty. */
  const closeEditor = useCallback((projectId: string) => {
    void canDiscardEdit(projectId).then((discard) => {
      if (discard) {
        setEditorTabs((current) => forget(current, projectId));
        disposeEditor(projectId);
      }
    });
  }, []);
  // Folds a change of HEAD or of the file's status into the open file — not on every push: a
  // reload reads and colours the whole diff again, hundreds of milliseconds for a long file. The
  // editor compares against the version it last had.
  useEffect(() => {
    for (const { projectId, path } of Object.values(editorTabs)) {
      setEditorVersion(projectId, diffVersion(states[projectId], path));
    }
  }, [editorTabs, states]);
  const runActiveBranchAction = useCallback(
    (label: string, action: () => Promise<GitActionResult>) => {
      if (activeProjectId) {
        void runBranchAction(activeProjectId, label, action);
      }
    },
    [activeProjectId, runBranchAction]
  );
  /** What the git pane may start, in the shape its views take it — for the project on screen. */
  const activeBranch = useMemo<BranchActions>(
    () => ({ busy: activeProjectId !== null && branchActions.has(activeProjectId), run: runActiveBranchAction }),
    [branchActions, activeProjectId, runActiveBranchAction]
  );

  return (
    <div className="app">
      {/* The app name; the bar is the drag region and the window controls' space. */}
      <div className="titlebar">
        <img className="titlebar-icon" src="icon.png" alt="" />
        <span className="titlebar-name">TET</span>
      </div>

      <div className="body">
        {/* Projects on top, the selected one's saved commands below them. */}
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

        {/* The active project's repository or its files, one view at a time. One pane for all
            projects. Both views stay mounted while it is out, the other one hidden, so a switch
            between them keeps a selection, a filter, the open folders and a running action's bar.
            While it slides in, it keeps the view it had. */}
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
                openPath={activeProjectId ? (editorTabs[activeProjectId]?.path ?? null) : null}
                onOpenDiff={openActiveDiff}
              />
              <GitPane
                project={activeProject}
                state={activeState}
                shown={!filesShown}
                branch={activeBranch}
                treeHeight={branchTreeHeight}
                onTreeHeight={setBranchTreeHeight}
                onOpenDiff={openActiveDiff}
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
              // Only the bootstrap listing, which has no tab to point a pane at; once a tab is
              // what is starting, `startingTabIds` shows it.
              externalBusy={starting[project.id] === true && (marks[project.id]?.starting ?? NO_IDS).length === 0}
              onOpenDiff={openDiffSync}
              onCloseEditor={closeEditor}
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
