import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectRefKey, projectRefsOf, EMPTY_REPOSITORY_STATE, isWorking, refName, worktreeBase } from "../shared/types";
import type { AgentInfo, ProjectRef, EnvRequest, Project, RepositoryState, TerminalDescriptor } from "../shared/types";
import { resolvedByKey, type ResolvedRef } from "./resolved-ref";
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
import type { RefHead, RefMarks } from "./sidebar/ProjectList";
import { activeAfterChange, activeAtStart, rememberActive } from "./sidebar/active-project";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { usePaneSize, usePaneToggle } from "./ui/layout-storage";
import { MIN_CONTENT_WIDTH, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, Sash } from "./ui/Sash";
import { TerminalsPane } from "./terminal/TerminalsPane";
import type { SideView } from "./terminal/Pane";
import { clearTerminal, disposeRefTerminals } from "./terminal/terminal-views";
import { PlusIcon } from "./ui/icons";
import { isWindowCovered, useWindowCovered } from "./ui/window-covered";
import { useAgents } from "./ui/use-agents";
import { forget, sameList, stableRecord } from "./identity";
import { matchesShortcut } from "./shortcuts";
import { defaultLayout, paneOf, tabsInFront } from "./terminal/pane-layout";
import { NO_TABS, useProjectLayouts } from "./terminal/use-project-layouts";
import { nextEditorTabId, type EditorTab, type OpenEditor, type PaneTab } from "./terminal/editor-tab";
import {
  canDiscardRefEdits,
  canDiscardEdits,
  disposeRefEditors,
  disposeEditor,
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
  resolvedRefs: Record<string, ResolvedRef>,
  tabs: Record<string, TerminalDescriptor[]>,
  agents: AgentInfo[]
): string {
  const resolved = request.ref && resolvedRefs[projectRefKey(request.ref)];
  const tab = resolved && tabs[resolved.key]?.find((entry) => entry.tabId === request.tabId);
  const agent = tab && (agents.find((entry) => entry.id === tab.agentId)?.displayName ?? tab.agentId);
  const who = agent ? (tab.title ? `${agent} (${tab.title})` : agent) : "An agent";
  return resolved ? `${who} in ${resolved.name}` : who;
}

/** Shared instance, so a pane's props stay identical for a project with none. */
const NO_IDS: string[] = [];

const DEFAULT_LAYOUT = defaultLayout();

/** `worktreesSupported`: git creates them (Requirements.worktrees). */
export function App({ worktreesSupported }: { worktreesSupported: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  /** The list after an await: the control channel can add a project meanwhile. */
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  /** Each project's repository and the worktrees TET made, by the key every
   *  record below is kept under (`projectRefKey`). Identity-stable where unchanged. */
  const refsHeld = useRef<Record<string, ResolvedRef>>({});
  const resolvedRefs = useMemo(() => resolvedByKey(refsHeld, projects), [projects]);
  /** For callbacks that only need it on a click: see `tabsRef`. */
  const resolvedRefsRef = useRef(resolvedRefs);
  resolvedRefsRef.current = resolvedRefs;
  /** The repository or worktree in front, by key. */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** For callbacks the project list gets, read on a click: see `tabsRef`. */
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  useEffect(() => rememberActive(activeKey), [activeKey]);
  /** Each repository's or worktree's repository state; everything below is by `projectRefKey` too,
   *  but `sandboxed`. */
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /** Every repository's and worktree's tabs: the project list needs all of them at once. */
  const [tabs, setTabs] = useState<Record<string, TerminalDescriptor[]>>({});
  /**
   * For callbacks that read it only on a click: depending on `tabs` would remake them, and every
   * pane's props, on every push.
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /**
   * Renderer-only, see `editor-tab.ts`; a repository or worktree with none has no entry. Untouched
   * tabs keep their instance across updates: `stripTabs` compares items.
   */
  const [editorTabs, setEditorTabs] = useState<Record<string, EditorTab[]>>({});
  const editorTabsRef = useRef(editorTabs);
  editorTabsRef.current = editorTabs;
  /**
   * Each repository's or worktree's tab strip: its terminals, then its editor tabs. The layout
   * reconciles against it, panes draw it, next/previous step through it; marks and `seen` stay on
   * `tabs` (the editor has no turns). Identity: `tabs`' own list without a file open, else the
   * previous list while unchanged.
   */
  const stripTabsRef = useRef<Record<string, PaneTab[]>>({});
  const stripTabs = useMemo(() => {
    const next: Record<string, PaneTab[]> = { ...tabs };
    for (const [key, editors] of Object.entries(editorTabs)) {
      next[key] = sameList(stripTabsRef.current[key], [...(tabs[key] ?? []), ...editors], NO_TABS);
    }
    stripTabsRef.current = next;
    return next;
  }, [tabs, editorTabs]);
  /**
   * Repositories and worktrees with something starting (bootstrap listing, a CLI booting). Read by
   * the progress bar and the layout persistence.
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
  const { activeEditors, forgetProjectRef: forgetEditorSync } = useEditorSync(editorTabs, layouts, states);
  /** The branch commands' gate, and the git pane's and project list's ways in (run-action.ts). */
  const { activeBranch, projectListBusy, runIn } = useBranchActions(activeKey);
  // Pane defaults and limits; both side-pane views share the two below.
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
   * pane size. One view at a time, as VS Code's Explorer and Source Control.
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
   * repository or worktree: no pane is drawn then, and nothing would end the transition.
   */
  const [sideSliding, setSideSliding] = useState(false);
  const stopSliding = useCallback(() => setSideSliding(false), []);
  const slidePane = useCallback((open: boolean) => {
    setSidePaneOpen(open);
    if (activeKeyRef.current !== null) {
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
   * Each tet.json's `sbx.enabled`, by project id — a worktree runs as its project does. Replaced
   * only where it changed (the memoized list re-renders otherwise). Any writer of that file
   * (dialog, agent, editor, repository or worktree) arrives as `commands:changed`.
   */
  const [sandboxed, setSandboxed] = useState<Record<string, boolean>>({});
  /** Projects whose flag was read on arrival — not `sandboxed`, which holds no entry for "off".
   *  Forgotten with the project, so one added again is read again. */
  const sandboxedRead = useRef(new Set<string>());

  useEffect(() => {
    const unsubscribers = [
      window.tet.repository.onState(({ ref, state }) =>
        setStates((current) => ({ ...current, [projectRefKey(ref)]: state }))
      ),
      window.tet.terminals.onTabs(({ ref, tabs: list }) =>
        setTabs((current) => ({ ...current, [projectRefKey(ref)]: list }))
      ),
      window.tet.terminals.onStatus(({ ref, tabId, status }) => {
        const key = projectRefKey(ref);
      // A saved command's restart kill writes a trailing "^C"; clearing once the respawn runs keeps
      // it off screen (main flushes the old output before the status, the new one's has not come).
        if (status === "running" && tabsRef.current[key]?.some((tab) => tab.tabId === tabId && tab.savedCommand)) {
          clearTerminal(ref, tabId);
        }
        setTabs((current) => {
          const list = current[key];
          return list
            ? { ...current, [key]: list.map((tab) => (tab.tabId === tabId ? { ...tab, status } : tab)) }
            : current;
        });
      }),
      window.tet.terminals.onStartupProgress(({ ref, show }) => {
        const key = projectRefKey(ref);
        setStarting((current) => (current[key] === show ? current : { ...current, [key]: show }));
      })
    ];

    void (async () => {
      const stored = await window.tet.projects.list();
      setProjects(stored);
      setActiveKey((current) => current ?? activeAtStart(stored));
      const fetched = await Promise.all(
        stored.flatMap(projectRefsOf).map(async (ref) => {
          const [state, list, isStarting] = await Promise.all([
            window.tet.repository.state(ref),
            window.tet.terminals.list(ref),
            window.tet.terminals.starting(ref)
          ]);
          return [projectRefKey(ref), state, list, isStarting] as const;
        })
      );
      // A repository or worktree closed meanwhile was forgotten already: merging its entries would
      // revive it.
      const open = new Set(projectsRef.current.flatMap(projectRefsOf).map(projectRefKey));
      const loaded = fetched.filter(([key]) => open.has(key));
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

  /** A repository's or worktree's key, as a row or the git pane selects it. */
  const select = useCallback((key: string) => setActiveKey(key), []);

  /** Drops everything held for a repository or worktree; the project list is the caller's. */
  const forgetProjectRef = useCallback((ref: ProjectRef) => {
    const key = projectRefKey(ref);
    setStates((current) => forget(current, key));
    setTabs((current) => forget(current, key));
    setStarting((current) => forget(current, key));
    setEditorTabs((current) => forget(current, key));
    forgetEditorSync(key);
    disposeRefEditors(ref);
    forgetLayout(key);
    busyCursor.current = forget(busyCursor.current, key);
    // The xterms live outside React; this is where a repository or worktree ends for good.
    disposeRefTerminals(ref);
  }, [forgetLayout, forgetEditorSync]);

  /** A project's sbx switch goes with the project, not with a repository or worktree of it. */
  const forgetSandboxed = useCallback((projectId: string) => {
    setSandboxed((current) => forget(current, projectId));
    sandboxedRead.current.delete(projectId);
  }, []);

  /** The project row's remove, once the row asked about its worktrees; the list follows through
   *  `projects:changed`. */
  const removeProject = useCallback(async (projectId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project || !(await canDiscardRefEdits(...projectRefsOf(project)))) {
      return;
    }
    const result = await window.tet.projects.remove(projectId);
    if (!result.ok) {
      notify("error", result.error ?? `Could not remove ${project.name}`);
    }
  }, []);

  // The one way the list changes, whoever asked — the dialog, a row's close, the git pane's
  // worktrees or the control channel (projects.ts): main announces, this follows. A project
  // opened where no agent is installed can only run sandboxed, so its sbx settings open at once,
  // locked (SbxSettingsDialog); not a worktree, which has none.
  useEffect(
    () =>
      window.tet.projects.onChanged(({ projects: list, added, removed, show }) => {
        setProjects(list);
        setActiveKey((current) => activeAfterChange(current, list, removed, show));
        for (const ref of removed ?? []) {
          forgetProjectRef(ref);
          if (ref.worktree === undefined) {
            forgetSandboxed(ref.projectId);
          }
        }
        const opened = added?.find((ref) => ref.worktree === undefined);
        const project = opened && list.find((entry) => entry.id === opened.projectId);
        if (project) {
          void window.tet.startup.anyAgentInstalled().then((installed) => {
            if (!installed) {
              setSbxSettingsProject(project);
            }
          });
        }
      }),
    [forgetProjectRef, forgetSandboxed]
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
   * Shows a tab opened from outside the terminals pane, bringing its repository or worktree to
   * front — a one-off write into the layout (`placeTab`: a saved command's goes where its line last
   * lay).
   */
  const showTab = useCallback(
    (key: string, tabId: string, command?: string) => {
      setActiveKey(key);
      placeTab(key, tabId, command);
    },
    [placeTab]
  );

  // A control-channel tab, shown like a saved command's: drawing it starts its process.
  useEffect(
    () => window.tet.terminals.onShow(({ ref, tabId }) => showTab(projectRefKey(ref), tabId)),
    [showTab]
  );

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

  const activeResolved = (activeKey ? resolvedRefs[activeKey] : undefined) ?? null;

  /**
   * The active repository's or worktree's tabs in front of the user (`tabsInFront`) — the one
   * definition marks, `seen` and toasts (`terminals.inFront`) go by. Identity-stable: it is
   * reported on change.
   */
  const inFrontRef = useRef<string[]>(NO_IDS);
  const inFront = useMemo(() => {
    const next = activeKey ? tabsInFront(layouts[activeKey] ?? DEFAULT_LAYOUT, focused, covered) : NO_IDS;
    inFrontRef.current = sameList(inFrontRef.current, next, NO_IDS);
    return inFrontRef.current;
  }, [focused, covered, activeKey, layouts]);

  // May include editor tabs, which match no tab in the main process.
  const activeRef = activeResolved?.ref ?? null;
  useEffect(() => {
    window.tet.terminals.inFront(activeRef, inFront);
  }, [activeRef, inFront]);

  /**
   * Finished or waiting sessions not in front of the user, oldest first — the tab strip's marks and
   * what the project row steps through. Tabs in front are left out: nothing there was out of sight.
   * Decided here, once: main holds the mark but cannot see the screen, and two views must not each
   * decide.
   */
  const markedTabs = useCallback(
    (key: string, field: "finishedAt" | "waitingAt"): TerminalDescriptor[] => {
      const onScreen = key === activeKey ? inFront : NO_IDS;
      return (tabs[key] ?? [])
        .filter((tab) => tab[field] !== undefined && !onScreen.includes(tab.tabId))
        .sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
    },
    [tabs, inFront, activeKey]
  );

  /**
   * Tabs the progress bar is about — runtime being prepared, CLI before its first frame. Tabs on
   * screen included: the bar is about the pane's own tabs.
   */
  const startingTabs = useCallback(
    (key: string): TerminalDescriptor[] => (tabs[key] ?? []).filter((tab) => tab.starting === true),
    [tabs]
  );

  /**
   * The above as tab ids plus `busy` (`RefMarks`), per repository or worktree, identity-stable
   * where unchanged: panes and the project list take them as props, and most pushes change nothing
   * here. `busy` includes the tab on screen (a spinner is about now) but not one waiting on a
   * question: that session is not working, and both marks would stand side by side.
   */
  const marksRef = useRef<Record<string, RefMarks>>({});
  const marks = useMemo(() => {
    const next: Record<string, RefMarks> = {};
    for (const key of Object.keys(tabs)) {
      const previous = marksRef.current[key];
      next[key] = {
        finished: sameList(previous?.finished, markedTabs(key, "finishedAt").map((tab) => tab.tabId), NO_IDS),
        waiting: sameList(previous?.waiting, markedTabs(key, "waitingAt").map((tab) => tab.tabId), NO_IDS),
        starting: sameList(previous?.starting, startingTabs(key).map((tab) => tab.tabId), NO_IDS),
        busy: (tabs[key] ?? []).some(isWorking)
      };
    }
    return stableRecord(marksRef, next);
  }, [tabs, markedTabs, startingTabs]);

  /**
   * A row's HEAD, first remote and dirty flag, by repository or worktree, identity-stable where
   * unchanged (`states` is fresh on every push, so every field is a value — the remote by what the
   * row shows of it). No git call of its own: `changes` comes with every refresh.
   */
  const headsRef = useRef<Record<string, RefHead>>({});
  const heads = useMemo(() => {
    const next: Record<string, RefHead> = {};
    for (const [key, state] of Object.entries(states)) {
      const base = state.worktrees.find((worktree) => worktree.current)?.base;
      const target = worktreeBase(state);
      next[key] = {
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
    (key: string) => {
      const working = (tabsRef.current[key] ?? []).filter(isWorking);
      if (working.length === 0) {
        return;
      }
      // -1 when the last shown tab stopped or is gone; the index wraps.
      const at = working.findIndex((tab) => tab.tabId === busyCursor.current[key]);
      const next = working[(at + 1) % working.length];
      busyCursor.current[key] = next.tabId;
      showTab(key, next.tabId);
    },
    [showTab]
  );

  /** The project row's marks: the oldest finished session first, and the longest-waiting question. */
  const [showFinished, showWaiting] = useMemo(() => {
    const showFirst = (mark: "finished" | "waiting") => (key: string) => {
      const next = marksRef.current[key]?.[mark][0];
      if (next) {
        showTab(key, next);
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
    if (!activeRef) {
      return;
    }
    for (const tab of tabs[projectRefKey(activeRef)] ?? []) {
      if (inFront.includes(tab.tabId) && tab.finishedAt !== undefined) {
        window.tet.terminals.seen(activeRef, tab.tabId);
      }
    }
  }, [activeRef, inFront, tabs]);

  /** A shell tab — a row's "terminal". */
  const openTerminal = useCallback(
    (ref: ProjectRef) => {
      void window.tet.terminals.create(ref, "shell").then((tab) => showTab(projectRefKey(ref), tab.tabId));
    },
    [showTab]
  );

  /**
   * Ctrl/Cmd+Shift+U, across all projects: the longest-waiting question, else the oldest finished
   * turn out of sight — so an unvisited project is not missed.
   */
  const showNeedsAttention = useCallback(() => {
    // Through `markedTabs`, so the "not on screen" rule stays in one place.
    const collect = (field: "waitingAt" | "finishedAt"): { key: string; tab: TerminalDescriptor }[] =>
      Object.keys(tabs)
        .flatMap((key) => markedTabs(key, field).map((tab) => ({ key, tab })))
        .sort((a, b) => (a.tab[field] ?? 0) - (b.tab[field] ?? 0));
    const next = collect("waitingAt")[0] ?? collect("finishedAt")[0];
    if (next) {
      showTab(next.key, next.tab.tabId);
    }
  }, [tabs, markedTabs, showTab]);

  /** Ctrl/Cmd+Shift+./, — within the focused pane. */
  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (!activeKey) {
        return;
      }
      const layout = layouts[activeKey] ?? DEFAULT_LAYOUT;
      const list = (stripTabs[activeKey] ?? []).filter((tab) => paneOf(layout, tab.tabId) === layout.focusedPane);
      if (list.length === 0) {
        return;
      }
      const at = list.findIndex((tab) => tab.tabId === layout.activeTab[layout.focusedPane]);
      const next = list[(at + direction + list.length) % list.length];
      activateTab(activeKey, next.tabId, layout.focusedPane);
    },
    [activeKey, stripTabs, layouts, activateTab]
  );

  /** Ctrl/Cmd+Shift+T. */
  const newShellTab = useCallback(() => {
    if (activeRef) {
      openTerminal(activeRef);
    }
  }, [activeRef, openTerminal]);

  /**
   * Refresh on window focus, for changes the watcher missed. Only the repository or worktree on
   * screen — each other would cost three git processes for a state nobody reads.
   */
  useEffect(() => {
    if (!activeRef) {
      return;
    }
    const onFocus = (): void => {
      void window.tet.repository.refresh(activeRef);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeRef]);

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

  const activeState = (activeKey ? states[activeKey] : undefined) ?? EMPTY_REPOSITORY_STATE;

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
   * A row's git mark: switches to the repository or worktree and slides git out; on the one shown,
   * the strip's toggle.
   */
  const showChanges = useCallback(
    (key: string) => {
      setActiveKey(key);
      if (key === activeKeyRef.current) {
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
   * repository or worktree the view names.
   */
  const openEditor = useCallback(
    (ref: ProjectRef, path: string, how: OpenEditor = {}) => {
      const key = projectRefKey(ref);
      const open = editorTabsRef.current[key]?.find((tab) => tab.path === path);
      const preview = how.keep ? undefined : previewEditorTab(ref);
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
        openEditorFile(ref, tabId, path, true, how);
        setEditorTabs((current) => ({
          ...current,
          [key]: (current[key] ?? []).map((tab) => (tab.tabId === tabId ? { ...tab, path } : tab))
        }));
      } else {
        tabId = nextEditorTabId();
        openEditorFile(ref, tabId, path, how.keep !== true, how);
        setEditorTabs((current) => ({ ...current, [key]: [...(current[key] ?? []), { tabId, ref, path }] }));
      }
      activateTab(key, tabId);
    },
    [activateTab]
  );
  // A file the control channel asked for, brought to front.
  useEffect(
    () =>
      window.tet.repository.onOpenEditor(({ ref, path, keep }) => {
        setActiveKey(projectRefKey(ref));
        openEditor(ref, path, { keep });
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
      if (activeRef) {
        openEditor(activeRef, path, { ...how, diff: true });
      }
    },
    [activeRef, openEditor]
  );
  /** Disposes the editors; the layout collapses a pane left empty. By `projectRefKey`. */
  const closeEditors = useCallback((key: string, tabIds: string[]) => {
    void canDiscardEdits(tabIds).then((discard) => {
      if (!discard) {
        return;
      }
      setEditorTabs((current) => {
        const rest = (current[key] ?? []).filter((tab) => !tabIds.includes(tab.tabId));
        return rest.length > 0 ? { ...current, [key]: rest } : forget(current, key);
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
            resolvedRefs={resolvedRefs}
            activeKey={activeKey}
            onSelect={select}
            onRemove={removeProject}
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
            runIn={runIn}
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
          <CommandList resolved={activeResolved} height={commandsHeight} onOpenTab={showTab} />
        </div>
        <Sash
          orientation="vertical"
          size={sidebarWidth}
          min={MIN_PANE_WIDTH}
          minOther={MIN_CONTENT_WIDTH}
          onResize={setSidebarWidth}
        />

        {/* One side pane for the repositories and worktrees, in the DOM at width 0 while in (so a
            slide has a box to transition). Both views stay mounted, hidden while not shown, so a switch keeps
            selection, filter, open folders and a running action's bar. */}
        {activeResolved && (
          <>
            <div
              className={`side-pane${sideSliding ? " sliding" : ""}`}
              style={{ width: sideView ? sidePaneWidth : 0 }}
              onTransitionEnd={stopSliding}
            >
              <FilesPane
                resolved={activeResolved}
                state={activeState}
                shown={sideView === "files"}
                openPath={editorTabs[activeResolved.key]?.find((tab) => tab.tabId === activeEditors[activeResolved.key])?.path ?? null}
                onOpenFile={openEditor}
                searchHeight={fileSearchHeight}
                onSearchHeight={setFileSearchHeight}
              />
              <GitPane
                resolved={activeResolved}
                state={activeState}
                shown={sideView === "git"}
                branch={activeBranch}
                treeHeight={branchTreeHeight}
                onTreeHeight={setBranchTreeHeight}
                onOpenDiff={openActiveDiff}
                onSelect={select}
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
          {/* Every repository's and worktree's terminals stay mounted, so switching keeps buffers
              and processes. */}
          {Object.values(resolvedRefs).map((resolved) => (
            <TerminalsPane
              key={resolved.key}
              resolved={resolved}
              tabs={stripTabs[resolved.key] ?? NO_TABS}
              visible={resolved.key === activeKey}
              sideView={sideView}
              onToggleSideView={toggleSideView}
              agents={agents}
              // Only the bootstrap listing, which has no tab; a starting tab shows via `startingTabIds`.
              externalBusy={starting[resolved.key] === true && (marks[resolved.key]?.starting ?? NO_IDS).length === 0}
              onOpenFile={openEditor}
              onCloseEditors={closeEditors}
              layout={layouts[resolved.key] ?? DEFAULT_LAYOUT}
              onActivateTab={activateTab}
              onSnapTab={snapTab}
              onFocusPane={focusPane}
              onOpenSettings={openSettings}
              finishedTabIds={marks[resolved.key]?.finished ?? NO_IDS}
              waitingTabIds={marks[resolved.key]?.waiting ?? NO_IDS}
              startingTabIds={marks[resolved.key]?.starting ?? NO_IDS}
            />
          ))}
          {!activeResolved && (
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

      {/* A worktree takes its project's Explorer view and never changes it (tet-json.ts's configRoot). */}
      {settingsOpen && (
        <SettingsDialog
          activeProject={activeRef?.worktree === undefined ? (projects.find((project) => project.id === activeRef?.projectId) ?? null) : null}
          onClose={closeSettings}
        />
      )}
      {sbxSettingsProject && <SbxSettingsDialog project={sbxSettingsProject} onClose={closeSbxSettings} />}
      {envRequest && (
        <EnvDialog
          key={envRequest.id}
          request={envRequest}
          requester={requesterOf(envRequest, resolvedRefs, tabs, agents)}
          onClose={closeEnvRequest}
        />
      )}

      <Notices />
      <Dialogs />
    </div>
  );
}
