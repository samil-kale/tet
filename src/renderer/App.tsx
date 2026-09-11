import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMPTY_REPOSITORY_STATE } from "../shared/types";
import type { GitActionResult, Project, RepositoryState, TerminalDescriptor } from "../shared/types";
import { AddRepositoryDialog } from "./dialogs/AddRepositoryDialog";
import { CommandList } from "./sidebar/CommandList";
import type { BranchActions } from "./git/BranchTree";
import { DiffDialog } from "./diff/DiffDialog";
import { Dialogs } from "./ui/Dialog";
import { SbxSettingsDialog } from "./dialogs/SbxSettingsDialog";
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
import { clearTerminal, disposeProjectTerminals } from "./terminal/terminal-views";
import { PlusIcon } from "./ui/icons";
import { sameList } from "./identity";
import { matchesShortcut } from "./shortcuts";
import { reportSlow } from "./slow-report";
import { defaultLayout, paneOf, visibleTabIds } from "./terminal/pane-layout";
import { NO_TABS, useProjectLayouts } from "./terminal/use-project-layouts";

/** A little over `.git-pane.sliding`'s 0.15s, so the class outlives the transition. */
const GIT_SLIDE_MS = 180;

/**
 * A per-project record without that project. Nothing pushes for a closed project, and a folder
 * opened again gets the same id, so stale entries would show for a frame.
 */
function forget<T>(record: Record<string, T>, projectId: string): Record<string, T> {
  const rest = { ...record };
  delete rest[projectId];
  return rest;
}

/** What an open diff has to be re-read for: HEAD, and the status of the file it shows. */
function diffVersion(state: RepositoryState | undefined, filePath: string): string {
  return `${state?.head}:${state?.changes.find((change) => change.path === filePath)?.status}`;
}

/** Per project, under the `tet.layout.` namespace `Sash.tsx` and `pane-layout.ts` use for window state. */
function lastDiffPathKey(projectId: string): string {
  return `tet.layout.diff.${projectId}.lastPath`;
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
  /**
   * Which projects still have something starting up (bootstrap listing, a CLI booting). Read by
   * the active project's progress bar and by the layout persistence.
   */
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  /**
   * Each project's split state, held here rather than in `TerminalsPane` because the shortcuts and
   * the marks/seen logic need what is on screen across every pane — see "Split view" in CLAUDE.md.
   */
  const { layouts, activateTab, snapTab, focusPane, setPreset, placeTab, forgetLayout } = useProjectLayouts(
    tabs,
    starting
  );
  /**
   * Projects with a branch command in flight. Per project, not one slot for the window: a fetch
   * finishing in A must not free B's tree.
   */
  const [branchActions, setBranchActions] = useState<ReadonlySet<string>>(() => new Set());
  /** The same, read synchronously: a second double-click can land before a re-render does. */
  const branchActionsRef = useRef(new Set<string>());
  // Defaults and limits of the draggable panes; the one git pane shares the two below.
  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebar", 240, MIN_PANE_WIDTH);
  const [gitPanelsWidth, setGitPanelsWidth] = usePaneSize("git-panels", 300, MIN_PANE_WIDTH);
  const [branchTreeHeight, setBranchTreeHeight] = usePaneSize("branch-tree", 260, MIN_PANE_HEIGHT);
  // 40% of the window it first opens in.
  const [commandsHeight, setCommandsHeight] = usePaneSize(
    "commands",
    Math.round(window.innerHeight * 0.4),
    MIN_PANE_HEIGHT
  );
  /** Whether the git pane is out; remembered like a pane size. */
  const [gitOpen, setGitOpen] = usePaneToggle("git-pane", false);
  /**
   * `gitMounted` keeps the pane in the DOM through the closing transition; `gitExpanded` drives
   * the width transition. Two nested rAFs before expanding: one alone fires before the 0-width
   * paint as often as after it (observed), which jumped straight to full width.
   */
  const [gitMounted, setGitMounted] = useState(gitOpen);
  const [gitExpanded, setGitExpanded] = useState(gitOpen);
  /**
   * Whether the slide is running, which is what `.git-pane.sliding` transitions on. Not permanent:
   * the sash sets the same width, and an animated one lags the pointer by the whole duration.
   */
  const [gitSliding, setGitSliding] = useState(false);
  useEffect(() => {
    setGitSliding(true);
    let stop: ReturnType<typeof setTimeout> | undefined;
    if (gitOpen) {
      setGitMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          setGitExpanded(true);
          stop = setTimeout(() => setGitSliding(false), GIT_SLIDE_MS);
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        clearTimeout(stop);
      };
    }
    setGitExpanded(false);
    stop = setTimeout(() => {
      setGitMounted(false);
      setGitSliding(false);
    }, GIT_SLIDE_MS);
    return () => clearTimeout(stop);
  }, [gitOpen]);
  /** The diff dialog, if any — `path` null once it's open with nothing chosen. */
  const [diffFile, setDiffFile] = useState<{ projectId: string; path: string | null } | null>(null);
  /** Whether the add-repository dialog (clone, add, create) is up. */
  const [addOpen, setAddOpen] = useState(false);
  /** Whether the settings are up; they belong to the window, not to a project. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The project the "Enable sbx" dialog is up for, if any. */
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
    () => window.tet.onNotice(({ severity, message, progress }) => notify(severity, message, progress)),
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
    forgetLayout(projectId);
    busyCursor.current = forget(busyCursor.current, projectId);
    // The xterm instances live outside React; this is the one moment a project ends for good.
    disposeProjectTerminals(projectId);
  }, [forgetLayout]);

  const closeProject = useCallback(
    async (projectId: string) => {
      await window.tet.projects.remove(projectId);
      const remaining = projects.filter((project) => project.id !== projectId);
      setProjects(remaining);
      setActiveProjectId((current) => (current === projectId ? (remaining[0]?.id ?? null) : current));
      forgetProject(projectId);
    },
    [projects, forgetProject]
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

  /**
   * Finished and waiting sessions not on screen, oldest first — the tab strip's marks, and what the
   * project row's marks step through. Leaves out the tab in front of the user: a turn that finished
   * or a question asked there was never out of sight. Decided here, once: the main process holds
   * the mark but cannot know what is on screen, and two views must not each decide.
   */
  const markedTabs = useCallback(
    (projectId: string, field: "finishedAt" | "waitingAt"): TerminalDescriptor[] => {
      const onScreen = projectId === activeProjectId ? visibleTabIds(layouts[projectId] ?? DEFAULT_LAYOUT) : NO_IDS;
      return (tabs[projectId] ?? [])
        .filter((tab) => tab[field] !== undefined && !onScreen.includes(tab.tabId))
        .sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
    },
    [tabs, layouts, activeProjectId]
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
        busy: (tabs[projectId] ?? []).some((tab) => tab.busy && tab.waitingAt === undefined)
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
      const working = (tabsRef.current[projectId] ?? []).filter((tab) => tab.busy && tab.waitingAt === undefined);
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
   * Every tab on screen (one per pane) has been seen, so its mark goes. The main process holds
   * the mark but never learns what is on screen. Only the bubble: a standing question is hidden
   * while on screen (`markedTabs`), not cleared, so reporting it would be an IPC per push.
   */
  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    const onScreen = visibleTabIds(layouts[activeProjectId] ?? DEFAULT_LAYOUT);
    for (const tab of tabs[activeProjectId] ?? []) {
      if (onScreen.includes(tab.tabId) && tab.finishedAt !== undefined) {
        window.tet.terminals.seen(activeProjectId, tab.tabId);
      }
    }
  }, [activeProjectId, layouts, tabs]);

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
      const list = (tabs[activeProjectId] ?? []).filter((tab) => paneOf(layout, tab.tabId) === layout.focusedPane);
      if (list.length === 0) {
        return;
      }
      const at = list.findIndex((tab) => tab.tabId === layout.activeTab[layout.focusedPane]);
      const next = list[(at + direction + list.length) % list.length];
      activateTab(activeProjectId, next.tabId, layout.focusedPane);
    },
    [activeProjectId, tabs, layouts, activateTab]
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
  const shortcutActions = useRef({ gitOpen, setGitOpen, showNeedsAttention, cycleTab, newShellTab });
  shortcutActions.current = { gitOpen, setGitOpen, showNeedsAttention, cycleTab, newShellTab };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const actions = shortcutActions.current;
      let run: (() => void) | undefined;
      if (matchesShortcut(event, "settings")) {
        run = () => setSettingsOpen(true);
      } else if (matchesShortcut(event, "toggleGit")) {
        run = () => actions.setGitOpen(!actions.gitOpen);
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
  /** The project whose file the diff dialog shows — gone, the dialog goes with it. */
  const diffProject = diffFile ? projects.find((project) => project.id === diffFile.projectId) : undefined;
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
  const closeDiff = useCallback(() => setDiffFile(null), []);
  const toggleGit = useCallback(() => setGitOpen(!gitOpen), [gitOpen, setGitOpen]);
  /**
   * The project row's git mark: switches to that project and slides the git pane out. On the
   * project already on screen it is the same toggle as the one in the terminal strip.
   */
  const showChanges = useCallback(
    (projectId: string) => {
      setActiveProjectId(projectId);
      setGitOpen(projectId !== activeProjectId || !gitOpen);
    },
    [activeProjectId, gitOpen, setGitOpen]
  );
  /** No explicit path — "Browse files" itself — reopens whatever this project last showed. */
  const openDiff = useCallback((projectId: string, path?: string) => {
    const resolved = path ?? localStorage.getItem(lastDiffPathKey(projectId));
    setDiffFile({ projectId, path: resolved });
  }, []);
  // Remembers every file the dialog is pointed at, however it got there, across close and reopen.
  useEffect(() => {
    if (diffFile?.path !== null && diffFile?.path !== undefined) {
      localStorage.setItem(lastDiffPathKey(diffFile.projectId), diffFile.path);
    }
  }, [diffFile]);
  const openActiveDiff = useCallback(
    (path: string) => {
      if (activeProjectId) {
        setDiffFile({ projectId: activeProjectId, path });
      }
    },
    [activeProjectId]
  );
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

        {/* The active project's repository. One pane for all projects: it holds no state a
            project would lose by being switched away from. */}
        {gitMounted && activeProject && (
          <>
            <div
              className={`git-pane${gitSliding ? " sliding" : ""}`}
              style={{ width: gitExpanded ? gitPanelsWidth : 0 }}
            >
              <GitPane
                project={activeProject}
                state={activeState}
                branch={activeBranch}
                treeHeight={branchTreeHeight}
                onTreeHeight={setBranchTreeHeight}
                onOpenDiff={openActiveDiff}
              />
            </div>
            {gitOpen && (
              <Sash
                orientation="vertical"
                size={gitPanelsWidth}
                min={MIN_PANE_WIDTH}
                minOther={MIN_CONTENT_WIDTH}
                onResize={setGitPanelsWidth}
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
              tabs={tabs[project.id] ?? NO_TABS}
              visible={project.id === activeProjectId}
              gitOpen={gitOpen}
              onToggleGit={toggleGit}
              // Only the bootstrap listing, which has no tab to point a pane at; once a tab is
              // what is starting, `startingTabIds` shows it.
              externalBusy={starting[project.id] === true && (marks[project.id]?.starting ?? NO_IDS).length === 0}
              onOpenDiff={openDiff}
              layout={layouts[project.id] ?? DEFAULT_LAYOUT}
              onActivateTab={activateTab}
              onSnapTab={snapTab}
              onFocusPane={focusPane}
              onPresetChange={setPreset}
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

      {/* Over everything, only ever one. Reloads only when HEAD or this file's status changed:
          a reload reads and colours the whole diff again, hundreds of milliseconds for a long
          file. */}
      {diffFile && diffProject && (
        <DiffDialog
          project={diffProject}
          path={diffFile.path}
          version={diffVersion(states[diffFile.projectId], diffFile.path ?? "")}
          state={states[diffFile.projectId] ?? EMPTY_REPOSITORY_STATE}
          onOpenDiff={openDiff}
          onClose={closeDiff}
        />
      )}

      {addOpen && <AddRepositoryDialog onAdded={projectAdded} onClose={closeAdd} />}

      {settingsOpen && <SettingsDialog activeProject={activeProject} onClose={closeSettings} />}
      {sbxSettingsProject && <SbxSettingsDialog project={sbxSettingsProject} onClose={closeSbxSettings} />}

      <Notices />
      <Dialogs />
    </div>
  );
}
