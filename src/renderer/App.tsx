import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatest } from "./ui/use-latest";
import { EMPTY_REPOSITORY_STATE } from "../shared/types/git";
import { projectRefKey, projectRefsOf } from "../shared/types/project";
import type { AgentInfo } from "../shared/types/agents";
import type { EnvRequest } from "../shared/types/environment";
import type { Project, ProjectRef } from "../shared/types/project";
import type { TerminalDescriptor } from "../shared/types/terminals";
import { resolvedByKey, type ResolvedRef } from "./resolved-ref";
import { AddRepositoryDialog } from "./dialogs/AddRepositoryDialog";
import { EnvDialog } from "./dialogs/EnvDialog";
import { CommandList } from "./sidebar/CommandList";
import { useBranchActions } from "./git/run-action";
import { Dialogs } from "./ui/Dialog";
import { SbxSettingsDialog } from "./dialogs/SbxSettingsDialog";
import { FilesPane } from "./files/FilesPane";
import { GitPane } from "./git/GitPane";
import { Notices, notify, showProgress } from "./ui/Notices";
import { ProjectList } from "./sidebar/ProjectList";
import { useSandboxedProjects } from "./sidebar/use-sandboxed-projects";
import { activeAfterChange, activeAtStart, rememberActive } from "./sidebar/active-project";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { usePaneSize } from "./ui/layout-storage";
import { useSidePane } from "./ui/use-side-pane";
import { MIN_CONTENT_WIDTH, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, Sash } from "./ui/Sash";
import { TerminalsPane } from "./tabs/TerminalsPane";
import { disposeRefTerminals } from "./tabs/terminal-views";
import { NO_IDS, useSessionMarks } from "./tabs/use-session-marks";
import { PlusIcon } from "./ui/icons";
import { isWindowCovered, useWindowCovered } from "./ui/window-covered";
import { agentName, useAgents } from "./ui/use-agents";
import { forget, sameList } from "./identity";
import { defaultLayout, paneOf, tabsInFront } from "./tabs/pane-layout";
import { NO_TABS, useProjectLayouts } from "./tabs/use-project-layouts";
import type { EditorTab, PaneTab } from "./editor/editor-tab";
import { canDiscardRefEdits, disposeRefEditors } from "./editor/editor-views";
import { useEditorOpening } from "./tabs/use-editor-opening";
import { useEditorSync } from "./tabs/use-editor-sync";
import { useRefHeads } from "./sidebar/use-ref-heads";
import { useWindowFocused } from "./ui/use-window-focused";
import { useWindowShortcuts } from "./ui/use-window-shortcuts";
import { useRefFeeds } from "./use-ref-feeds";

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
  const agent = tab && agentName(agents, tab.agentId);
  const who = agent ? (tab.title ? `${agent} (${tab.title})` : agent) : "An agent";
  return resolved ? `${who} in ${resolved.name}` : who;
}

const DEFAULT_LAYOUT = defaultLayout();

/** `worktreesSupported`: git creates them (Requirements.worktrees). */
export function App({ worktreesSupported }: { worktreesSupported: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  /** The list after an await: the control channel can add a project meanwhile. */
  const projectsRef = useLatest(projects);
  /** Each project's repository and the worktrees TET made, by the key every
   *  record below is kept under (`projectRefKey`). Identity-stable where unchanged. */
  const refsHeld = useRef<Record<string, ResolvedRef>>({});
  const resolvedRefs = useMemo(() => resolvedByKey(refsHeld, projects), [projects]);
  /** The repository or worktree in front, by key. */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** For callbacks the project list gets, read on a click: depending on `activeKey` would remake
   *  them, and every row's props, on every switch. */
  const activeKeyRef = useLatest(activeKey);
  useEffect(() => rememberActive(activeKey), [activeKey]);
  const loadedProjects = useCallback((stored: Project[]) => {
    setProjects(stored);
    setActiveKey((current) => current ?? activeAtStart(stored));
  }, []);
  /** Each repository's or worktree's git state, tabs and starting flag (use-ref-feeds.ts);
   *  everything below is by `projectRefKey` too, but `sandboxed`. */
  const { states, tabs, starting, forgetRef: forgetFeeds } = useRefFeeds(projectsRef, loadedProjects);
  /**
   * Renderer-only, see `editor-tab.ts`; a repository or worktree with none has no entry. Untouched
   * tabs keep their instance across updates: `stripTabs` compares items.
   */
  const [editorTabs, setEditorTabs] = useState<Record<string, EditorTab[]>>({});
  const editorTabsRef = useLatest(editorTabs);
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
  // Pane defaults and limits; both side-pane views share its width ("git-panels").
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
  /** The side pane's view and slide (use-side-pane.ts). */
  const { sideView, sideSliding, stopSliding, toggleSideView, showChanges } = useSidePane(activeKeyRef, setActiveKey);
  const [addOpen, setAddOpen] = useState(false);
  /** Window-wide, not per project. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sbxSettingsProject, setSbxSettingsProject] = useState<Project | null>(null);
  /** What an agent asked for with `tet-ctl env-request`; main sends one at a time. */
  const [envRequest, setEnvRequest] = useState<EnvRequest | null>(null);
  /** Each project's sbx switch (use-sandboxed-projects.ts). */
  const { sandboxed, forgetSandboxed } = useSandboxedProjects(projects);

  // Before onNotice, whose subscription tells main the window listens.
  useEffect(() => window.tet.onNoticeProgress(showProgress), []);
  useEffect(
    () => window.tet.onNotice(({ severity, message }) => notify(severity, message)),
    []
  );

  /** A repository's or worktree's key, as a row or the git pane selects it. */
  const select = useCallback((key: string) => setActiveKey(key), []);

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
  }, [projectsRef]);

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

  const focused = useWindowFocused();
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

  /** Finished, waiting, starting and busy tabs, and the ways to them (use-session-marks.ts). */
  const { marks, showBusy, showFinished, showWaiting, showNeedsAttention, forgetProjectRef: forgetMarks } =
    useSessionMarks(tabs, activeKey, activeRef, inFront, showTab);

  /** Drops everything held for a repository or worktree; the project list is the caller's. */
  const forgetProjectRef = useCallback((ref: ProjectRef) => {
    const key = projectRefKey(ref);
    forgetFeeds(key);
    setEditorTabs((current) => forget(current, key));
    forgetEditorSync(key);
    disposeRefEditors(ref);
    forgetLayout(key);
    forgetMarks(key);
    // The xterms live outside React; this is where a repository or worktree ends for good.
    disposeRefTerminals(ref);
  }, [forgetFeeds, forgetLayout, forgetEditorSync, forgetMarks]);

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

  /** The project rows' HEAD, remote and dirty flag (use-ref-heads.ts). */
  const heads = useRefHeads(states);

  /** A shell tab — a row's "terminal". */
  const openTerminal = useCallback(
    (ref: ProjectRef) => {
      void window.tet.terminals.create(ref, "shell").then((tab) => showTab(projectRefKey(ref), tab.tabId));
    },
    [showTab]
  );

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

  useWindowShortcuts({
    // Never over another dialog: Escape closes the last one opened (use-escape.ts), which has to be
    // the one on top — an agent's environment dialog, drawn last, can already be up.
    settings: () => !isWindowCovered() && setSettingsOpen(true),
    toggleGit: () => toggleSideView("git"),
    toggleFiles: () => toggleSideView("files"),
    needsAttention: showNeedsAttention,
    nextTab: () => cycleTab(1),
    previousTab: () => cycleTab(-1),
    newShellTab
  });

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
  /** Opening and closing editor tabs (use-editor-opening.ts). */
  const { openEditor, openActiveDiff, closeEditors } = useEditorOpening(
    editorTabsRef,
    setEditorTabs,
    activateTab,
    select,
    activeRef
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
