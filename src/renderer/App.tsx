import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatest } from "./ui/use-latest";
import { EMPTY_REPOSITORY_STATE } from "../shared/types/git";
import { refKeyOf, projectRefsOf, worktreeName } from "../shared/types/project";
import type { EnvRequest } from "../shared/types/environment";
import type { Project, ProjectRef } from "../shared/types/project";
import { resolvedByRefKey, type ResolvedRef } from "./resolved-ref";
import { AddRepositoryDialog } from "./dialogs/AddRepositoryDialog";
import { EnvDialog } from "./dialogs/EnvDialog";
import { ArchiveList } from "./lanes/archive/ArchiveList";
import { useArchive } from "./lanes/archive/use-archive";
import { CommandList } from "./lanes/projects/CommandList";
import { useBranchActions } from "./git/run-action";
import { Dialogs } from "./ui/Dialog";
import { SbxSettingsDialog } from "./dialogs/SbxSettingsDialog";
import { FilesLane } from "./lanes/files/FilesLane";
import { GitLane } from "./lanes/git/GitLane";
import { Notices, notify, showProgress } from "./ui/Notices";
import { NoticesCenter } from "./ui/NoticesCenter";
import { ProjectList } from "./lanes/projects/ProjectList";
import { useSandboxedProjects } from "./lanes/projects/use-sandboxed-projects";
import { activeAfterChange, activeAtStart, rememberActive } from "./lanes/projects/active-ref";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { useStoredSize } from "./ui/layout-storage";
import { useLanes } from "./lanes/use-lanes";
import { LANES } from "../shared/types/settings";
import { MIN_CONTENT_WIDTH, MIN_AREA_HEIGHT, MIN_AREA_WIDTH, Sash } from "./ui/Sash";
import { TabArea } from "./tabs/TabArea";
import { disposeRefTerminals } from "./tabs/terminal-views";
import { NO_IDS } from "./tabs/tab-marks";
import { useTabMarks } from "./tabs/use-tab-marks";
import { useWorkingNotices } from "./tabs/use-working-notices";
import { PlusIcon } from "./ui/icons";
import { NavigationBar } from "./lanes/NavigationBar";
import { StatusBar } from "./ui/StatusBar";
import { isWindowCovered, useWindowCovered } from "./ui/window-covered";
import { useAgents } from "./ui/use-agents";
import { forget, sameList } from "./identity";
import { PLATFORM } from "./platform";
import { DEFAULT_LAYOUT, inOrder, paneOf, tabsOnScreen } from "./tabs/pane-layout";
import { NO_TABS } from "./tabs/layout-state";
import { useProjectLayouts } from "./tabs/use-project-layouts";
import { workingTreePathOf, type EditorTab } from "./editor/editor-tab";
import type { PaneTab } from "./tabs/pane-tab";
import { canDiscardRefEdits, disposeRefEditors } from "./editor/editor-views";
import { useEditorOpening } from "./tabs/use-editor-opening";
import { useTabRestore } from "./tabs/use-tab-restore";
import { useEditorSync } from "./tabs/use-editor-sync";
import { useRefHeads } from "./lanes/projects/use-ref-heads";
import { useWindowFocused } from "./ui/use-window-focused";
import { useWindowShortcuts } from "./ui/use-window-shortcuts";
import { useRefFeeds } from "./use-ref-feeds";

/** `worktreesSupported`: git creates them (Requirements.worktrees). */
export function App({ worktreesSupported }: { worktreesSupported: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  /** The list after an await: the control channel can add a project meanwhile. */
  const projectsRef = useLatest(projects);
  /** Each project's repository and the worktrees TET made, by the `refKey` every
   *  record below is kept under. Identity-stable where unchanged. */
  const refsHeld = useRef<Record<string, ResolvedRef>>({});
  const resolvedRefs = useMemo(() => resolvedByRefKey(refsHeld, projects), [projects]);
  /** The active repository or worktree, by `refKey`. */
  const [activeRefKey, setActiveRefKey] = useState<string | null>(null);
  /** For callbacks the project list gets, read on a click: depending on `activeRefKey` would remake
   *  them, and every row's props, on every switch. */
  const activeRefKeyRef = useLatest(activeRefKey);
  useEffect(() => rememberActive(activeRefKey), [activeRefKey]);
  const loadedProjects = useCallback((stored: Project[]) => {
    setProjects(stored);
    setActiveRefKey((current) => current ?? activeAtStart(stored));
  }, []);
  /** Each repository's or worktree's git state, tabs and starting flag (use-ref-feeds.ts);
   *  everything below is by `refKey` too, but `sandboxed`. */
  const { states, tabs, starting, forgetRef: forgetFeeds } = useRefFeeds(projectsRef, loadedProjects);
  /**
   * Renderer-only, see `editor-tab.ts`; a repository or worktree with none has no entry. Untouched
   * tabs keep their instance across updates: `stripTabs` compares items.
   */
  const [editorTabs, setEditorTabs] = useState<Record<string, EditorTab[]>>({});
  const editorTabsRef = useLatest(editorTabs);
  /** The tab strip lists terminals and editors; unchanged items retain their identity for panes. */
  const stripTabsRef = useRef<Record<string, PaneTab[]>>({});
  const stripTabs = useMemo(() => {
    const next: Record<string, PaneTab[]> = { ...tabs };
    for (const [refKey, editors] of Object.entries(editorTabs)) {
      next[refKey] = sameList(stripTabsRef.current[refKey], [...(tabs[refKey] ?? []), ...editors], NO_TABS);
    }
    stripTabsRef.current = next;
    return next;
  }, [tabs, editorTabs]);
  /** The editor tabs and plain shells a restart brings back (use-tab-restore.ts). */
  const forgetRestore = useTabRestore(resolvedRefs, states, tabs, editorTabs, setEditorTabs);
  /**
   * Split state lives here, not in `TabArea`: shortcuts and marks/seen need what is on screen
   * across every pane — one tab per pane (`visibleTabIds`). A pane asks for a selection change
   * through `onActivateTab`. See "Split view" in AGENTS.md.
   */
  const { layouts, activateTab, snapTab, dropOnStrip, focusPane, placeTab, forgetLayout } = useProjectLayouts(stripTabs, starting);
  /** The editors kept in step with the tabs, the layout and the states (use-editor-sync.ts). */
  const { activeEditors, forgetProjectRef: forgetEditorSync } = useEditorSync(editorTabs, layouts, states);
  /** The branch commands' gate, and the git lane's and project list's ways in (run-action.ts). */
  const { activeBranch, projectListBusy, runIn } = useBranchActions(activeRefKey);
  // Section defaults and limits.
  const [branchTreeHeight, setBranchTreeHeight] = useStoredSize("branch-tree", 260, MIN_AREA_HEIGHT);
  const [fileSearchHeight, setFileSearchHeight] = useStoredSize("file-search", 260, MIN_AREA_HEIGHT);
  // 40% of the window it first opens in.
  const [commandsHeight, setCommandsHeight] = useStoredSize("commands", Math.round(window.innerHeight * 0.4), MIN_AREA_HEIGHT);
  /** The one lane shown, its width and slide (use-lanes.ts). */
  const {
    shownLane,
    width: laneWidth,
    setWidth: setLaneWidth,
    slidingLanes,
    stopSliding,
    toggleLane,
    showChanges,
  } = useLanes(activeRefKeyRef, setActiveRefKey);
  const [addOpen, setAddOpen] = useState(false);
  /** Window-wide, not per project. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sbxSettingsProject, setSbxSettingsProject] = useState<Project | null>(null);
  /** What an agent asked for with `tet-ctl env-request`; main sends one at a time. */
  const [envRequest, setEnvRequest] = useState<EnvRequest | null>(null);
  /** Each project's SBX enabled state (use-sandboxed-projects.ts). */
  const { sandboxed, forgetSandboxed } = useSandboxedProjects(projects);

  // Before onNotice, whose subscription tells main the window listens.
  useEffect(() => window.tet.onNoticeProgress(showProgress), []);
  useEffect(
    () => window.tet.onNotice(({ severity, message, toast, target, mark }) => notify(severity, message, { toast, target, mark })),
    [],
  );

  /** Makes a repository or worktree active, by its `refKey`, as a row or the git lane picks it. */
  const activateRef: (refKey: string) => void = setActiveRefKey;

  /** The project row's remove, once the row asked about its worktrees; the list follows through
   *  `projects:changed`. */
  const removeProject = useCallback(
    async (projectId: string) => {
      const project = projectsRef.current.find((entry) => entry.id === projectId);
      if (!project || !(await canDiscardRefEdits(...projectRefsOf(project)))) {
        return;
      }
      const result = await window.tet.projects.remove(projectId);
      if (!result.ok) {
        notify("error", result.error ?? `Could not remove ${project.name}`);
      }
    },
    [projectsRef],
  );

  const reorderProjects = useCallback((ordered: Project[]) => {
    setProjects(ordered);
    void window.tet.projects.reorder(ordered.map((project) => project.id));
  }, []);

  /**
   * Shows a tab opened from outside the tab area, making its repository or worktree
   * active — a one-off write into the layout (`placeTab`: a saved command's goes where its line last
   * lay).
   */
  const showTab = useCallback(
    (refKey: string, tabId: string, command?: string) => {
      setActiveRefKey(refKey);
      placeTab(refKey, tabId, command);
    },
    [placeTab],
  );

  // A ctl-channel tab, shown like a saved command's: drawing it starts its process.
  useEffect(() => window.tet.tabs.onShow(({ ref, tabId }) => showTab(refKeyOf(ref), tabId)), [showTab]);
  const showNoticeTab = useCallback((ref: ProjectRef, tabId: string) => showTab(refKeyOf(ref), tabId), [showTab]);

  const focused = useWindowFocused();
  const covered = useWindowCovered();

  const activeResolved = (activeRefKey ? resolvedRefs[activeRefKey] : undefined) ?? null;

  /**
   * The active repository's or worktree's tabs on screen (`tabsOnScreen`) — the one
   * definition marks, `seen` and notifications (`terminals.reportOnScreen`) go by. Identity-stable: it is
   * reported on change.
   */
  const onScreenTabIdsRef = useRef<string[]>(NO_IDS);
  const onScreenTabIds = useMemo(() => {
    const next = activeRefKey ? tabsOnScreen(layouts[activeRefKey] ?? DEFAULT_LAYOUT, focused, covered) : NO_IDS;
    onScreenTabIdsRef.current = sameList(onScreenTabIdsRef.current, next, NO_IDS);
    return onScreenTabIdsRef.current;
  }, [focused, covered, activeRefKey, layouts]);

  // May include editor tabs, which match no tab in the main process.
  const activeRef = activeResolved?.ref ?? null;
  useEffect(() => {
    window.tet.tabs.reportOnScreen(activeRef, onScreenTabIds);
  }, [activeRef, onScreenTabIds]);

  /** Finished, waiting, starting and working tabs, and the ways to them (use-tab-marks.ts). */
  const {
    marks,
    showWorking,
    showFinished,
    showWaiting,
    jumpToWaiting,
    forgetProjectRef: forgetMarks,
  } = useTabMarks(tabs, activeRefKey, activeRef, onScreenTabIds, showTab);
  useWorkingNotices(tabs, resolvedRefs);

  /** Drops everything held for a repository or worktree; the project list is the caller's. */
  const forgetProjectRef = useCallback(
    (ref: ProjectRef) => {
      const refKey = refKeyOf(ref);
      forgetRestore(refKey);
      forgetFeeds(refKey);
      setEditorTabs((current) => forget(current, refKey));
      forgetEditorSync(refKey);
      disposeRefEditors(ref);
      forgetLayout(refKey);
      forgetMarks(refKey);
      // The xterms live outside React; this is where a repository or worktree ends for good.
      disposeRefTerminals(ref);
    },
    [forgetRestore, forgetFeeds, forgetLayout, forgetEditorSync, forgetMarks],
  );

  // The one way the list changes, whoever asked — the dialog, a row's close, the git lane's
  // worktrees or the control channel (projects.ts): main announces, this follows. A project
  // opened where no agent is installed can only run sandboxed, so its SBX Settings open at once,
  // locked (SbxSettingsDialog); not a worktree, which has none.
  useEffect(
    () =>
      window.tet.projects.onChanged(({ projects: list, added, removed, show }) => {
        setProjects(list);
        setActiveRefKey((current) => activeAfterChange(current, list, removed, show));
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
    [forgetProjectRef, forgetSandboxed],
  );

  /** The project rows' HEAD, remote and dirty flag (use-ref-heads.ts). */
  const heads = useRefHeads(states);

  /** The status bar's project, branch, change count and archived tab count: the active
   *  repository's or worktree's. */
  const activeProject = activeResolved ? projects.find((project) => project.id === activeResolved.ref.projectId) : undefined;
  const activeBranchName = activeResolved
    ? activeResolved.worktree
      ? worktreeName(activeResolved.worktree)
      : heads[activeResolved.refKey]?.head
    : undefined;
  const activeChangesCount = activeResolved ? (states[activeResolved.refKey]?.changes.length ?? 0) : 0;
  const archivedTabs = useArchive(activeResolved);

  /** A shell tab, for a project row's "New shell tab" entry. */
  const openShellTab = useCallback(
    (ref: ProjectRef) => {
      void window.tet.tabs.create(ref, "shell").then((tab) => showTab(refKeyOf(ref), tab.tabId));
    },
    [showTab],
  );

  /** Ctrl/Cmd+Shift+./, — within the focused pane. */
  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (!activeRefKey) {
        return;
      }
      const layout = layouts[activeRefKey] ?? DEFAULT_LAYOUT;
      const list = inOrder(
        layout.order,
        (stripTabs[activeRefKey] ?? []).filter((tab) => paneOf(layout, tab.tabId) === layout.focusedPane),
      );
      if (list.length === 0) {
        return;
      }
      const at = list.findIndex((tab) => tab.tabId === layout.activeTab[layout.focusedPane]);
      const next = list[(at + direction + list.length) % list.length];
      activateTab(activeRefKey, next.tabId, layout.focusedPane);
    },
    [activeRefKey, stripTabs, layouts, activateTab],
  );

  /** Ctrl/Cmd+Shift+T. */
  const newShellTab = useCallback(() => {
    if (activeRef) {
      openShellTab(activeRef);
    }
  }, [activeRef, openShellTab]);

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

  useWindowShortcuts({
    // Never over another dialog: Escape closes the last one opened (use-escape.ts), which has to be
    // the one on top — an agent's environment dialog, drawn last, can already be up.
    settings: () => !isWindowCovered() && setSettingsOpen(true),
    toggleProjects: () => toggleLane("projects"),
    toggleGit: () => toggleLane("git"),
    toggleFiles: () => toggleLane("files"),
    toggleArchive: () => toggleLane("archive"),
    jumpToWaiting,
    nextTab: () => cycleTab(1),
    previousTab: () => cycleTab(-1),
    newShellTab,
  });

  const activeState = (activeRefKey ? states[activeRefKey] : undefined) ?? EMPTY_REPOSITORY_STATE;
  /** Git, files and archive need an active repository or worktree; without one, projects stands
   *  in for whichever lane was shown. */
  const effectiveLane = activeResolved ? shownLane : shownLane ? "projects" : null;

  // Stable handles, so memoized views re-render only for what they show.
  const openAdd = useCallback(() => setAddOpen(true), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSbxSettings = useCallback(
    (projectId: string) => setSbxSettingsProject(projects.find((candidate) => candidate.id === projectId) ?? null),
    [projects],
  );
  const closeSbxSettings = useCallback(() => setSbxSettingsProject(null), []);
  /** Opening and closing editor tabs (use-editor-opening.ts). */
  const { openEditor, openActiveDiff, closeEditors } = useEditorOpening(editorTabsRef, setEditorTabs, activateTab, activateRef, activeRef);
  useEffect(() => {
    const offRequest = window.tet.env.onRequest(setEnvRequest);
    const offWithdrawn = window.tet.env.onWithdrawn((id) => setEnvRequest((current) => (current?.id === id ? null : current)));
    return () => {
      offRequest();
      offWithdrawn();
    };
  }, []);
  const closeEnvRequest = useCallback(() => setEnvRequest(null), []);
  const agents = useAgents();
  return (
    <div className="app">
      {/* The drag region and the window controls' space. */}
      <div className={PLATFORM.centersTitle ? "titlebar titlebar-centered" : "titlebar"}>
        <img className="titlebar-icon" src="icon.png" alt="" />
        <span className="titlebar-name">TET</span>
      </div>

      <div className="body">
        <NavigationBar shownLane={shownLane} onToggleLane={toggleLane} onOpenSettings={openSettings} />
        {/* Every lane, in a fixed order, each in the DOM at width 0 while not shown (so a slide
            has a box to transition) and mounted throughout, so hiding one keeps selection, filter,
            open folders and a running action's bar. */}
        {LANES.map((lane) => {
          const shown = lane === effectiveLane;
          return (
            <Fragment key={lane}>
              <div
                className={["lane", slidingLanes.has(lane) && "sliding"].filter(Boolean).join(" ")}
                style={{ width: shown ? laneWidth : 0 }}
                // Its own width's alone: a child's transition (a sash's hover) bubbles here too.
                onTransitionEnd={(event) => {
                  if (event.target === event.currentTarget && event.propertyName === "width") {
                    stopSliding(lane);
                  }
                }}
              >
                {lane === "projects" && (
                  <div className={`lane-content${shown ? "" : " hidden"}`}>
                    <ProjectList
                      projects={projects}
                      resolvedRefs={resolvedRefs}
                      activeRefKey={activeRefKey}
                      onActivateRef={activateRef}
                      onRemove={removeProject}
                      onReorder={reorderProjects}
                      onAdd={openAdd}
                      heads={heads}
                      marks={marks}
                      sandboxed={sandboxed}
                      onShowChanges={showChanges}
                      onOpenShellTab={openShellTab}
                      onShowWorking={showWorking}
                      onShowFinished={showFinished}
                      onShowWaiting={showWaiting}
                      onSbxSettings={openSbxSettings}
                      runIn={runIn}
                      busy={projectListBusy}
                      worktreesSupported={worktreesSupported}
                    />
                    <Sash
                      orientation="horizontal"
                      size={commandsHeight}
                      min={MIN_AREA_HEIGHT}
                      minOther={MIN_AREA_HEIGHT}
                      reverse
                      onResize={setCommandsHeight}
                    />
                    <CommandList resolved={activeResolved} height={commandsHeight} onOpenTab={showTab} />
                  </div>
                )}
                {lane === "files" && activeResolved && (
                  <FilesLane
                    resolved={activeResolved}
                    shown={shown}
                    openPath={workingTreePathOf(editorTabs[activeResolved.refKey], activeEditors[activeResolved.refKey])}
                    onOpenFile={openEditor}
                    searchHeight={fileSearchHeight}
                    onSearchHeight={setFileSearchHeight}
                  />
                )}
                {lane === "archive" && activeResolved && (
                  // Keyed by repository or worktree: each has its own archived tabs.
                  <ArchiveList key={activeResolved.refKey} resolved={activeResolved} shown={shown} onOpenTab={showTab} />
                )}
                {lane === "git" && activeResolved && (
                  <GitLane
                    resolved={activeResolved}
                    state={activeState}
                    shown={shown}
                    branch={activeBranch}
                    treeHeight={branchTreeHeight}
                    onTreeHeight={setBranchTreeHeight}
                    onOpenDiff={openActiveDiff}
                    onActivateRef={activateRef}
                  />
                )}
              </div>
              {shown && (
                <Sash orientation="vertical" size={laneWidth} min={MIN_AREA_WIDTH} minOther={MIN_CONTENT_WIDTH} onResize={setLaneWidth} />
              )}
            </Fragment>
          );
        })}

        <main className="content">
          {/* Every repository's and worktree's terminals stay mounted, so switching keeps buffers
              and processes. */}
          {Object.values(resolvedRefs).map((resolved) => (
            <TabArea
              key={resolved.refKey}
              resolved={resolved}
              tabs={stripTabs[resolved.refKey] ?? NO_TABS}
              visible={resolved.refKey === activeRefKey}
              agents={agents}
              // Only the bootstrap listing, which has no tab; a starting tab shows via `startingTabIds`.
              externalBusy={(starting[resolved.refKey] ?? false) && (marks[resolved.refKey]?.starting ?? NO_IDS).length === 0}
              onCloseEditors={closeEditors}
              layout={layouts[resolved.refKey] ?? DEFAULT_LAYOUT}
              onActivateTab={activateTab}
              onSnapTab={snapTab}
              onDropOnStrip={dropOnStrip}
              onFocusPane={focusPane}
              finishedTabIds={marks[resolved.refKey]?.finished ?? NO_IDS}
              waitingTabIds={marks[resolved.refKey]?.waiting ?? NO_IDS}
              startingTabIds={marks[resolved.refKey]?.starting ?? NO_IDS}
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

      <StatusBar
        project={activeProject}
        branch={activeBranchName}
        changesCount={activeChangesCount}
        archivedCount={archivedTabs.length}
        onSelectLane={toggleLane}
      />

      {addOpen && <AddRepositoryDialog onClose={closeAdd} />}

      {settingsOpen && <SettingsDialog onClose={closeSettings} />}
      {sbxSettingsProject && <SbxSettingsDialog project={sbxSettingsProject} onClose={closeSbxSettings} />}
      {envRequest && <EnvDialog key={envRequest.id} request={envRequest} onClose={closeEnvRequest} />}

      <Notices />
      <NoticesCenter onShowTab={showNoticeTab} />
      <Dialogs />
    </div>
  );
}
