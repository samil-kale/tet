import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMPTY_REPOSITORY_STATE } from "../shared/types";
import type { GitActionResult, Project, RepositoryState, TerminalDescriptor } from "../shared/types";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { CommandList } from "./components/CommandList";
import type { BranchActions } from "./components/BranchTree";
import { DiffDialog } from "./components/DiffDialog";
import { Dialogs } from "./components/Dialog";
import { GitPane } from "./components/GitPane";
import { Notices, notify } from "./components/Notices";
import { ProjectList } from "./components/ProjectList";
import type { ProjectHead, ProjectMarks } from "./components/ProjectList";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  MIN_CONTENT_WIDTH,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  Sash,
  usePaneSize,
  usePaneToggle
} from "./components/Sash";
import { TerminalsPane } from "./components/TerminalsPane";
import { clearTerminal, disposeProjectTerminals } from "./terminal-views";
import { PlusIcon } from "./components/icons";
import { sameList } from "./identity";
import { matchesShortcut } from "./shortcuts";
import {
  applyPreset,
  defaultLayout,
  loadLayout,
  normalizeLayout,
  paneOf,
  saveLayout,
  serializeLayout,
  visibleTabIds
} from "./pane-layout";
import type { PaneId, ProjectLayout, SplitPreset } from "./pane-layout";

/** A little over `.git-pane.sliding`'s 0.15s, so the class outlives the transition. */
const GIT_SLIDE_MS = 180;

/**
 * A copy of one of the per-project records without that project in it. Nothing pushes anything
 * for a closed project, so what was mirrored of it has to be dropped by hand — and a folder
 * opened again gets the same id, which would otherwise show its own stale tabs for a frame,
 * marks and all.
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

/**
 * Where the diff dialog's last-opened file is kept per project, under the same `tet.layout.`
 * namespace `Sash.tsx` and `pane-layout.ts` use for everything else describing the window rather
 * than the repository — which file "Browse files" reopens is exactly that kind of thing.
 */
function lastDiffPathKey(projectId: string): string {
  return `tet.layout.diff.${projectId}.lastPath`;
}

/** The tabs of a project that has none — one instance, so the pane's props stay identical. */
const NO_TABS: TerminalDescriptor[] = [];
const NO_IDS: string[] = [];
/** A project that has never had a layout of its own — same reason as the two above. */
const DEFAULT_LAYOUT = defaultLayout();

/**
 * A project's layout as every writer of `layouts` starts from: what is held already, else what
 * the last run left on disk. Loaded at first sight rather than up front, because there is no
 * moment that is reliably "before" — a project's tabs can arrive from the main process before
 * the project list itself has, and a layout written for them then would have overwritten a
 * later restore. Reading `localStorage` inside a state updater is fine for the same reason it
 * would be fine at module level: it is synchronous and gives the same answer every time.
 */
function layoutOf(layouts: Record<string, ProjectLayout>, projectId: string): ProjectLayout {
  return layouts[projectId] ?? loadLayout(projectId);
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /**
   * Every project's terminal tabs, held here rather than in each pane for the same reason the
   * repository states above are: the project list needs all of them at once. What it takes
   * from them is `finishedAt` — the sessions that finished while nobody was looking.
   */
  const [tabs, setTabs] = useState<Record<string, TerminalDescriptor[]>>({});
  /**
   * The same, for the two layout callbacks below that only *read* it, on a click: depending on
   * `tabs` would remake them — and through them every pane's props — on every push from any
   * project, which is what the memo on the panes is there to prevent.
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /**
   * Each project's split state: its preset, which pane is focused, which pane every open tab
   * belongs to, and each pane's own active tab. Held here rather than in `TerminalsPane` because
   * the shortcuts below and the marks/seen logic need to know what is on screen across every
   * pane, not only within one project's own view — see "Split view" in CLAUDE.md.
   */
  const [layouts, setLayouts] = useState<Record<string, ProjectLayout>>({});
  /** The tab list `layouts` was last normalized against, per project — see `normalizeLayout`. */
  const previousTabsRef = useRef<Record<string, TerminalDescriptor[]>>({});
  /**
   * Which projects still have something starting up — a session listing at bootstrap, a CLI
   * booting — as the main process reports it. Two readers: the active project's progress bar,
   * and the layout persistence below, which must not write a project's layout before its
   * bootstrap has listed every agent's sessions (see `settledProjects`).
   */
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  /**
   * The projects with a branch command in flight — a checkout can take seconds on a large
   * repository, and deleting on a remote goes to the network. Per project, not one slot for the
   * window: a fetch finishing in project A must not free B's tree while B's own still runs.
   */
  const [branchActions, setBranchActions] = useState<ReadonlySet<string>>(() => new Set());
  /** The same, read synchronously: a second double-click can land before a re-render does. */
  const branchActionsRef = useRef(new Set<string>());
  // Defaults and limits of the draggable panes. The one git pane shares the two below,
  // so they are held here rather than in each of them.
  const [sidebarWidth, setSidebarWidth] = usePaneSize("sidebar", 240, MIN_PANE_WIDTH);
  const [gitPanelsWidth, setGitPanelsWidth] = usePaneSize("git-panels", 300, MIN_PANE_WIDTH);
  const [branchTreeHeight, setBranchTreeHeight] = usePaneSize("branch-tree", 260, MIN_PANE_HEIGHT);
  // 40% of the window it first opens in.
  const [commandsHeight, setCommandsHeight] = usePaneSize(
    "commands",
    Math.round(window.innerHeight * 0.4),
    MIN_PANE_HEIGHT
  );
  /**
   * Whether the git pane is out. Closed until it is asked for, and remembered like a pane
   * size, since it is one.
   */
  const [gitOpen, setGitOpen] = usePaneToggle("git-pane", false);
  /**
   * Drives the slide: `gitMounted` keeps the pane in the DOM through the closing transition,
   * `gitExpanded` is what the width transition animates. Opening flips `gitExpanded` only once
   * the browser has painted the freshly mounted, still-0-width frame — a single
   * `requestAnimationFrame` fires before that paint as often as after it, which made opening
   * jump straight to full width; two nested ones wait it out reliably. Closing reverses that
   * and unmounts once the transition has had time to finish.
   */
  const [gitMounted, setGitMounted] = useState(gitOpen);
  const [gitExpanded, setGitExpanded] = useState(gitOpen);
  /**
   * Whether that slide is running right now, which is what `.git-pane.sliding` transitions
   * on. The transition may not stay on the pane: the sash sets the very same width, and an
   * animated one lags the pointer by its whole duration.
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
  /** The diff dialog over everything, if any — `path` null once it's open with nothing chosen. */
  const [diffFile, setDiffFile] = useState<{ projectId: string; path: string | null } | null>(null);
  /** Whether the add-repository dialog (clone, add, create) is up. */
  const [addOpen, setAddOpen] = useState(false);
  /** Whether the settings are up; they belong to the window, not to a project. */
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const unsubscribers = [
      window.tet.repository.onState(({ projectId, state }) =>
        setStates((current) => ({ ...current, [projectId]: state }))
      ),
      window.tet.terminals.onTabs(({ projectId, tabs: list }) =>
        setTabs((current) => ({ ...current, [projectId]: list }))
      ),
      // A status arrives on its own rather than as a whole list, so it is patched into the one
      // tab it names instead of replacing the project's.
      window.tet.terminals.onStatus(({ projectId, tabId, status }) => {
        // A saved command's restart kills the running process before respawning it, and the kill
        // itself writes a trailing "^C" — clearing here, once the respawned process is actually
        // running, is what keeps that off screen: the old process's last output has already
        // arrived by the time this fires, and the new one's hasn't yet.
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
      // All three were pushed while this was in flight if the project bootstrapped before the
      // window existed, and what was pushed is newer than what was just fetched.
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

  /**
   * Keeps every project's split layout honest against its tab list — a tab closed elsewhere
   * drops out of whichever pane held it, a pane left with none of its own goes to null, a tab
   * never assigned a pane settles into whichever was focused when it was first seen. See
   * `normalizeLayout` for why `previousTabsRef` is what tells "closed" apart from "not created
   * yet".
   *
   * A layout effect, not a passive one: a project's first tabs are also its layout's first
   * sight (`layoutOf` loads it here), and a passive effect would let the frame before it paint
   * with `DEFAULT_LAYOUT` — a single pane, for a project restored into a split. Cheap to run
   * before paint: most pushes change no layout, and a layout that did not change is the same
   * object, which React does not re-render for.
   */
  useLayoutEffect(() => {
    // Read and advanced here, outside the updater: an updater may run later than it is queued,
    // and must not carry a side effect of its own.
    const previousTabs = previousTabsRef.current;
    previousTabsRef.current = tabs;
    setLayouts((current) => {
      let next: Record<string, ProjectLayout> | undefined;
      for (const projectId of Object.keys(tabs)) {
        const layout = normalizeLayout(
          layoutOf(current, projectId),
          tabs[projectId] ?? NO_TABS,
          previousTabs[projectId] ?? NO_TABS
        );
        if (layout !== current[projectId]) {
          next ??= { ...current };
          next[projectId] = layout;
        }
      }
      return next ?? current;
    });
  }, [tabs]);

  /**
   * Persists every project's layout whenever what would be written changes — a tab activated,
   * a pane focused, a preset switched, `normalizeLayout` above reconciling one against its tabs,
   * or a tab gaining the session it is persisted under. On `tabs` too, not `layouts` alone: what
   * goes to disk is keyed by session id (see `serializeLayout`), so a push that only added one to
   * a tab, or brought a restored tab in late, changes the output without touching the layout.
   * Compared as the string it would write, since a push during a turn changes `tabs` many times
   * a minute for a spinner and nothing else.
   */
  const savedLayoutsRef = useRef<Record<string, string>>({});
  /**
   * Projects whose bootstrap has been seen to finish, at least once. A project's tabs arrive
   * agent by agent while it bootstraps, and what goes to disk is trimmed to the tabs that exist
   * (`serializeLayout`) — written during that window, it would drop the pane of every session
   * whose listing hadn't come yet, and quitting before it did would make that permanent. So
   * nothing is written for a project until it has once reported not starting; from then on it
   * is, whatever the indicator says later — a CLI booting is not a listing in flight.
   */
  const settledProjects = useRef(new Set<string>());
  useEffect(() => {
    for (const [projectId, isStarting] of Object.entries(starting)) {
      if (!isStarting) {
        settledProjects.current.add(projectId);
      }
    }
  }, [starting]);
  useEffect(() => {
    for (const [projectId, layout] of Object.entries(layouts)) {
      if (!settledProjects.current.has(projectId)) {
        continue;
      }
      const serialized = serializeLayout(layout, tabs[projectId] ?? NO_TABS);
      if (savedLayoutsRef.current[projectId] !== serialized) {
        savedLayoutsRef.current[projectId] = serialized;
        saveLayout(projectId, serialized);
      }
    }
  }, [layouts, tabs, starting]);

  /** What the add-repository dialog ends in, whichever of its tabs produced the project. */
  const projectAdded = useCallback((project: Project) => {
    setProjects((current) => (current.some((entry) => entry.id === project.id) ? current : [...current, project]));
    setActiveProjectId(project.id);
  }, []);

  /** Everything held for a project, let go of — the project list itself is the caller's. */
  const forgetProject = useCallback((projectId: string) => {
    setStates((current) => forget(current, projectId));
    setTabs((current) => forget(current, projectId));
    setLayouts((current) => forget(current, projectId));
    setStarting((current) => forget(current, projectId));
    delete previousTabsRef.current[projectId];
    delete savedLayoutsRef.current[projectId];
    settledProjects.current.delete(projectId);
    busyCursor.current = forget(busyCursor.current, projectId);
    // The xterm instances live outside React and outlive the pane that mounted them, so
    // this is where they are let go of — the one moment a project ends for good.
    disposeProjectTerminals(projectId);
  }, []);

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

  // The control channel opened or closed a project (tet-ctl, from a terminal): the same two
  // paths as the dialog's add and the row's close, with the list handed over instead of asked.
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

  const reorderProjects = useCallback((ordered: Project[]) => {
    setProjects(ordered);
    void window.tet.projects.reorder(ordered.map((project) => project.id));
  }, []);

  /**
   * Runs one branch command per project at a time: clicking a second branch mid-switch would
   * stack two `git switch` on one repository. The branch tree says so with its cursor, this
   * enforces it. Per project, since two repositories working at once is no conflict.
   */
  const runBranchAction = useCallback(
    async (projectId: string, label: string, action: () => Promise<GitActionResult>) => {
      if (branchActionsRef.current.has(projectId)) {
        return;
      }
      // Which project is working, not just that one is: the bar shows the active project, and
      // that may not be the one still busy when the user moves on.
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
   * A tab becomes the active one of a pane — a click on it, a drag or a context menu moving it
   * into another pane, or a tab just created. `paneId` pins it to a specific pane (what every one
   * of those already knows); left out, it resolves through `paneOf` instead, for a tab shown from
   * outside any pane's own view (a project row's mark, a saved command, `showTab` below) that
   * belongs wherever it already lives, or the focused pane if it has never been shown before.
   * Written blindly, whether or not the tab has arrived in `tabs` yet — `normalizeLayout` is what
   * leaves a pending one alone instead of treating it as closed.
   *
   * Moving a pane's own active tab elsewhere would otherwise leave that pane's `activeTab` naming
   * a tab it no longer has — nothing selected there until the user clicks something themselves.
   * The pane that loses it falls back to whichever tab sat right before it in its own order (the
   * one before wins over VS Code's "closed tab" rule of nearest-right-else-left, since here the
   * tab has not closed, just left; before is the one glance back to where it a moment ago sat next
   * to), or the first of what is left if it was that pane's own first tab, or nothing once the
   * pane is left with no tabs of its own at all.
   */
  const activateTab = useCallback(
    (projectId: string, tabId: string, paneId?: PaneId) => {
      setLayouts((current) => {
        const layout = layoutOf(current, projectId);
        const source = paneOf(layout, tabId);
        const target = paneId ?? source;
        let activeTab = layout.activeTab;
        if (target !== source && layout.activeTab[source] === tabId) {
          const sourceTabs = (tabsRef.current[projectId] ?? []).filter(
            (tab) => (layout.tabPane[tab.tabId] ?? layout.focusedPane) === source
          );
          const index = sourceTabs.findIndex((tab) => tab.tabId === tabId);
          const remaining = sourceTabs.filter((tab) => tab.tabId !== tabId);
          activeTab = { ...activeTab, [source]: remaining.length > 0 ? remaining[Math.max(index - 1, 0)].tabId : null };
        }
        return {
          ...current,
          [projectId]: {
            ...layout,
            focusedPane: target,
            tabPane: layout.tabPane[tabId] === target ? layout.tabPane : { ...layout.tabPane, [tabId]: target },
            activeTab: { ...activeTab, [target]: tabId }
          }
        };
      });
    },
    []
  );

  /** A pane taking focus without its active tab changing — clicking its terminal, not a tab. */
  const focusPane = useCallback((projectId: string, paneId: PaneId) => {
    setLayouts((current) => {
      const layout = layoutOf(current, projectId);
      return layout.focusedPane === paneId ? current : { ...current, [projectId]: { ...layout, focusedPane: paneId } };
    });
  }, []);

  /** The layout dropdown: switches a project's preset, redistributing panes that no longer exist. */
  const setPreset = useCallback(
    (projectId: string, preset: SplitPreset) => {
      setLayouts((current) => ({
        ...current,
        [projectId]: applyPreset(layoutOf(current, projectId), preset, tabsRef.current[projectId] ?? [])
      }));
    },
    []
  );

  /** Shows a tab something outside its own pane opened: its project, then the tab itself. */
  const showTab = useCallback(
    (projectId: string, tabId: string) => {
      setActiveProjectId(projectId);
      activateTab(projectId, tabId);
    },
    [activateTab]
  );

  // A tab the control channel opened (tet-ctl, from a terminal) — shown the way a saved
  // command's is, since drawing it is what starts its process.
  useEffect(() => window.tet.terminals.onShow(({ projectId, tabId }) => showTab(projectId, tabId)), [showTab]);

  /**
   * A project's sessions that finished a turn nobody has looked at since, oldest first — the
   * mark in the tab strip, and what the project row's own mark opens one of at a time.
   *
   * The one thing it leaves out is the tab in front of the user: a session that finishes while
   * its terminal is on screen was never out of sight. Decided here rather than in the main
   * process, which holds the mark but cannot know what is on screen — and here rather than in
   * each of the two views, which would then have to agree with each other about it.
   *
   * The same rule, for the same reason, gives the sessions that stopped mid-turn on a question
   * (`waitingAt`) — a question asked in the tab in front of the user was never asked out of
   * sight — so one function answers both, and both views take it from here rather than working
   * it out twice.
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
   * A project's sessions whose own tab is what the progress bar is currently about — an agent's
   * runtime being prepared, or its CLI not yet past its first real frame. Unlike the two marks
   * above, the tab in front of the user is not excluded: which pane shows the bar does not care
   * whether that pane is on screen, only which of its own tabs is the reason.
   */
  const startingTabs = useCallback(
    (projectId: string): TerminalDescriptor[] => (tabs[projectId] ?? []).filter((tab) => tab.starting === true),
    [tabs]
  );

  /**
   * All three of the above as tab ids, plus whether a session is working (see `ProjectMarks`),
   * once per render for every project, and by identity only where the answer changed — the
   * record as a whole too: a pane and the project list take these as props, and a fresh array or
   * record for an unchanged answer would re-render every memoized view on every push from any
   * project. That is most pushes: a spinner's tick changes `tabs` and nothing here.
   *
   * `busy` does not leave out the tab in front of the user, unlike the two marks: a spinner says
   * what is happening now, and it says it wherever the tab is — the reason to look at it is that
   * the answer is not there yet. A tab stopped on a question is excluded even though `busy` is
   * still true underneath — the turn is technically open, but the session is waiting on the
   * user, not working, and the two marks would otherwise stand side by side on the very same
   * session with nothing to tell them apart from.
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
   * What the project row says about the repository — its HEAD and first remote — by identity
   * only where that changed: `states` is a fresh record on every push from any repository, and
   * a changed file is not something the row shows.
   */
  const headsRef = useRef<Record<string, ProjectHead>>({});
  const heads = useMemo(() => {
    const next: Record<string, ProjectHead> = {};
    let changed = Object.keys(headsRef.current).length !== Object.keys(states).length;
    for (const [projectId, state] of Object.entries(states)) {
      const previous = headsRef.current[projectId];
      const remote = state.remotes[0];
      next[projectId] =
        previous &&
        previous.head === state.head &&
        previous.remote?.name === remote?.name &&
        previous.remote?.url === remote?.url
          ? previous
          : { head: state.head, remote };
      changed ||= next[projectId] !== previous;
    }
    if (!changed) {
      return headsRef.current;
    }
    headsRef.current = next;
    return next;
  }, [states]);

  /**
   * The project row's spinner: the sessions that are working, one press at a time. Where the
   * mark beside it works through its list by emptying it — a session seen stops being marked —
   * watching a session does not stop it working, so this has to remember where it left off. A
   * ref rather than state: it changes what the *next* press does, and nothing on screen.
   *
   * These three read `tabsRef`/`marksRef` rather than depending on `tabs`: they run on a click,
   * and a dependency would remake them — and through them the project list — on every push.
   */
  const busyCursor = useRef<Record<string, string>>({});
  const showBusy = useCallback(
    (projectId: string) => {
      const working = (tabsRef.current[projectId] ?? []).filter((tab) => tab.busy && tab.waitingAt === undefined);
      if (working.length === 0) {
        return;
      }
      // Where the last press landed, or -1 when that tab has since stopped or gone — either way
      // the next index is the one to show, and it wraps.
      const at = working.findIndex((tab) => tab.tabId === busyCursor.current[projectId]);
      const next = working[(at + 1) % working.length];
      busyCursor.current[projectId] = next.tabId;
      showTab(projectId, next.tabId);
    },
    [showTab]
  );

  /** The project row's mark: the session that finished first, then the next one the time after. */
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
   * Every tab in front of the user — one per pane — has been seen, so the mark on each goes. The
   * main process holds the mark but never learns what is on screen, which is why this is the
   * renderer's half. Only the bubble: a standing question is hidden while on screen (`markedTabs`)
   * but not cleared by being looked at, so reporting it here would be an IPC per push for nothing.
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
   * Ctrl/Cmd+Shift+U: across every project, whichever session has been waiting on a question the
   * longest — or, if none is, whichever finished out of sight first. The same "oldest first" rule
   * `showWaiting`/`showFinished` apply to one project's row, just not stopped at one project: the
   * key exists precisely so a project nobody has clicked into is not missed.
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

  /** Ctrl/Cmd+Shift+./, — the focused pane's own tabs, one over from where it is now. */
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

  /** Ctrl/Cmd+Shift+T — a shell tab in the project on screen, the same as its row's own button. */
  const newShellTab = useCallback(() => {
    if (activeProjectId) {
      openTerminal(activeProjectId);
    }
  }, [activeProjectId, openTerminal]);

  /**
   * Coming back to the window is when a change the watcher missed would show, so that is when
   * the repository is read again — GitHub Desktop refreshes on focus for the same reason. Only
   * the project on screen: refreshing every open one would spend three git processes each for
   * a state nobody is reading.
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
   * The window's own shortcuts, on `document` in the capture phase so they win the race against
   * xterm's own listener (attached to its own textarea, further down the tree) rather than
   * arriving as input to whichever terminal has focus — see "The keyboard belongs to the
   * terminal" in CLAUDE.md for why every one of `matchesShortcut`'s combinations is safe to take.
   */
  // The actions in a ref: `showNeedsAttention` and `cycleTab` are remade on every tab push,
  // and the listener is registered once rather than swapped many times a minute for a spinner.
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
  /** The project whose file the diff dialog is showing — gone, the dialog goes with it. */
  const diffProject = diffFile ? projects.find((project) => project.id === diffFile.projectId) : undefined;
  const activeState = (activeProjectId ? states[activeProjectId] : undefined) ?? EMPTY_REPOSITORY_STATE;

  // Stable handles for what the views below take, so a memoized view re-renders for a change in
  // what it shows and not for a fresh arrow function.
  const closeProjectSync = useCallback((projectId: string) => void closeProject(projectId), [closeProject]);
  const openAdd = useCallback(() => setAddOpen(true), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeDiff = useCallback(() => setDiffFile(null), []);
  const toggleGit = useCallback(() => setGitOpen(!gitOpen), [gitOpen, setGitOpen]);
  /** No explicit path — "Browse files" itself — reopens whatever this project last showed. */
  const openDiff = useCallback((projectId: string, path?: string) => {
    const resolved = path ?? localStorage.getItem(lastDiffPathKey(projectId));
    setDiffFile({ projectId, path: resolved });
  }, []);
  // Remembers every file the dialog is pointed at, however it got there (browse, a changed-file
  // click, the FILES tree) — not just calls to `openDiff` above — so the choice survives the
  // dialog being closed and reopened.
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
      {/* The app name; the bar itself is the drag region and the space the window controls
          overlay needs. */}
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
            onOpenTerminal={openTerminal}
            onShowBusy={showBusy}
            onShowFinished={showFinished}
            onShowWaiting={showWaiting}
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

        {/* The repository of the active project, between the navigation and its terminals.
            One pane for all of them, unlike the terminals: it holds no state a project would
            lose by being switched away from. */}
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
          {/* Every project's terminals stay mounted so switching project keeps their buffers
              and running processes untouched. */}
          {projects.map((project) => (
            <TerminalsPane
              key={project.id}
              project={project}
              tabs={tabs[project.id] ?? NO_TABS}
              visible={project.id === activeProjectId}
              gitOpen={gitOpen}
              onToggleGit={toggleGit}
              gitDirty={(states[project.id]?.changes.length ?? 0) > 0}
              // The git pane, the diff dialog and a discard/stash now all carry their own bar —
              // this one is left with only the reason that has no tab of its own to point a pane
              // at yet: the session listing at bootstrap, before any tab exists. Once a tab is
              // what is starting, `startingTabIds` below is where that shows instead.
              externalBusy={starting[project.id] === true && (marks[project.id]?.starting ?? NO_IDS).length === 0}
              onOpenDiff={openDiff}
              layout={layouts[project.id] ?? DEFAULT_LAYOUT}
              onActivateTab={activateTab}
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

      {/* Over everything, and only ever one: a diff is looked at and then left again. It
          reloads when what it shows can have changed — HEAD, or this file's own status — and
          not with every other file an agent touches: a reload reads the diff again and colours
          all of it again, hundreds of milliseconds on the renderer for a long file. */}
      {diffFile && diffProject && (
        <DiffDialog
          project={diffProject}
          path={diffFile.path}
          version={diffVersion(states[diffFile.projectId], diffFile.path ?? "")}
          changes={(states[diffFile.projectId] ?? EMPTY_REPOSITORY_STATE).changes}
          onOpenDiff={openDiff}
          onClose={closeDiff}
        />
      )}

      {addOpen && <AddRepositoryDialog onAdded={projectAdded} onClose={closeAdd} />}

      {settingsOpen && <SettingsDialog activeProject={activeProject} onClose={closeSettings} />}

      <Notices />
      <Dialogs />
    </div>
  );
}
