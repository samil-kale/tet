import * as path from "node:path";
import { AGENTS, agentInstalled, getAgent } from "../agents";

import type { AgentDefinition, AgentSessionInfo } from "../agents/agent";
import { errorMessage } from "../../shared/errors";
import type { ControlEvent, HookEvent } from "../../shared/ctl";
import type { ControlSide } from "../../shared/ctl-side";
import { hasSandbox } from "../agents/agent";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectCommand, ProjectRef } from "../../shared/types/project";
import type { ActionResult } from "../../shared/types/action";
import type { HandoverResult, TabDescriptor } from "../../shared/types/terminals";
import type { ResolvedRef } from "../store/resolved-ref";
import type { HostSetups } from "./host-setup";
import { dropsDir } from "../store/project-dirs";
import { readSbxSettings } from "../store/tet-json";
import type { SbxLocalStore } from "../sbx/sbx-local";
import type { SettingsStore } from "../store/settings";
import type { AgentRuntime } from "./agent-runtime";
import { ArchivedTabs } from "./archived-tabs";
import { PlaceResolver } from "./place-resolver";
import type { spawnAgentProcess, TerminalEnv } from "./pty";
import { SESSION_REMOVE_DELAY_MS } from "./terminal-session";
import { HostPlace, SandboxPlace } from "./tab-place";
import type { PlaceContext, TabPlace } from "./tab-place";
import { removeHandoverCopy, TabRuns, type RunCallbacks } from "./tab-runs";
import type { InitialFile } from "./tab-state";
import { applyTurnReport, bindReportedSession, notificationFor, type HookNotification, type NotificationKind } from "./turn-reports";
import {
  awaitsClaim,
  endTurnQuietly,
  sessionFieldsOf,
  settleWithoutProcess,
  titleUnsettled,
  toDescriptor,
  type TabState,
} from "./tab-state";
import { ReconcileScheduler } from "./reconcile-scheduler";
import { StartIndicators } from "./start-indicators";
import { PLATFORM } from "../util/host-platform";

// How far back `tet-ctl events-tail` can look.
const MAX_RECORDED_EVENTS = 200;
// Across managers, so a repository or worktree reopened in this run never reuses a closed tab's
// id — and token; after a stamp of the run, so a shell the window brings back under its id
// (`restore`) never meets a tab of this one.
const RUN_STAMP = Date.now().toString(36);
let newTabCounter = 0;

export interface SessionManagerCallbacks extends RunCallbacks {
  onTabs: (ref: ProjectRef, tabs: TabDescriptor[]) => void;
  /** The archived tabs of this repository or worktree, whole, on every change. */
  onArchived: (ref: ProjectRef, tabs: TabDescriptor[]) => void;
  /** Whether anything in this repository or worktree is still starting — drives the tab strip's
   *  bar. */
  onStartupProgress: (ref: ProjectRef, show: boolean) => void;
}

export interface HookOutcome {
  /** What the hook prints back into its agent (AgentTurns.hookReply). */
  stdout: string;
  /** None where the notification settings say so. */
  notification?: HookNotification;
}

/** A `tabs-list` entry: the window's descriptor plus what only the session manager knows. */
export interface InspectedTab extends TabDescriptor {
  /** The session this tab's hooks named, claimed or not. */
  reportedSessionId?: string;
  sandbox?: string;
  /** Opened from a sandbox, so it runs there or not at all. */
  sandboxOnly?: true;
}

/**
 * The terminal tabs of a project's repository or one of its worktrees, mirroring the
 * agents' persisted sessions: each session found at open becomes a tab. Closing a tab deletes its
 * session (`closeTabs`, `tet-ctl`); the window's close keeps it (`closeKeepingSessions`), and a
 * session kept archived (store/archive.ts) is an archived tab, with no process, until it is
 * reopened or deleted.
 */
export class TabSessionManager {
  private tabs: TabState[] = [];
  private readonly archived: ArchivedTabs;
  private readonly places: PlaceResolver;
  private readonly runtimes = new Map<AgentId, AgentRuntime>();
  /** Session ids whose removal is in flight — reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs gone from the UI whose persisted session must still be claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];
  /** See `events`. */
  private readonly recorded: ControlEvent[] = [];
  /** The processes behind the tabs. */
  private readonly runs: TabRuns;
  /** Closed; nothing still in flight may start anything back up. */
  private disposed = false;
  private readonly indicators = new StartIndicators(
    (show) => this.callbacks.onStartupProgress(this.at.ref, show),
    () => this.postTabs(),
  );
  /** The tabs on screen, as last reported (`setOnScreen`). */
  private onScreen: ReadonlySet<string> = new Set();
  /** Whether the window has brought back its tabs (`restore`), and what the start phase waits on
   *  for it (`bootstrap`); settled by `dispose` too, so a closed one stops waiting. */
  private restoredByWindow = false;
  private resolveWindowRestored: () => void = () => undefined;
  private readonly windowRestored = new Promise<void>((resolve) => {
    this.resolveWindowRestored = resolve;
  });

  constructor(
    /** The repository or worktree its tabs run in. Its sandboxes take the project's SBX settings
     *  (sbx-local.ts), as it takes the project's tet.json (tet-json.ts's configRoot). */
    readonly at: ResolvedRef,
    private readonly dataRoot: string,
    private readonly settings: SettingsStore,
    private readonly sbxLocal: SbxLocalStore,
    private readonly hostSetups: HostSetups,
    terminalEnv: TerminalEnv,
    private readonly callbacks: SessionManagerCallbacks,
    /** What starts a tab's process (TabRuns); a test's stands in for the pty. */
    spawnProcess?: typeof spawnAgentProcess,
  ) {
    this.places = new PlaceResolver(at, settings, sbxLocal, {
      placeContext: (agent, executable) => this.placeContext(agent, executable),
      onNotice: (severity, message) => this.callbacks.onNotice(severity, message),
      sandboxChannel: () => ({ control: terminalEnv.control(), dataRoot }),
    });
    this.archived = new ArchivedTabs(dataRoot, at.ref, {
      agentOf: (tab) => this.runtimeFor(tab.agentId).agent,
      placeOf: (tab) => this.placeOf(tab),
      descriptorOf: (tab) => this.descriptorOf(tab),
      deletingSessionIds: this.deletingSessionIds,
      takeOffStrip: (tab) => this.takeOffStrip(tab),
      reopened: (tab) => {
        this.tabs.push(tab);
        this.postTabs();
      },
      onChanged: (tabs) => {
        if (!this.disposed) {
          this.callbacks.onArchived(this.at.ref, tabs);
        }
      },
      removeHandoverCopy,
    });
    this.runs = new TabRuns(
      at,
      settings,
      terminalEnv,
      callbacks,
      {
        tabOf: (tabId) => this.tabOf(tabId),
        onStrip: (tab) => this.tabs.includes(tab),
        runtimeFor: (agentId) => this.runtimeFor(agentId),
        canStart: (runtime) => this.canStart(runtime),
        placeOf: (tab) => this.placeOf(tab),
        resolvePlace: (tab, places) => this.places.resolvePlace(tab, places),
        postTabs: () => this.postTabs(),
        indicators: this.indicators,
      },
      spawnProcess,
    );
  }

  snapshot(): TabDescriptor[] {
    return this.tabs.map((tab) => this.descriptorOf(tab));
  }

  private descriptorOf(tab: TabState): TabDescriptor {
    return toDescriptor(tab, this.indicators.has(tab.tabId), this.placeOf(tab).sandbox !== undefined);
  }

  /** `snapshot` plus what the window never gets, for `tet-ctl tabs-list`. */
  inspect(): InspectedTab[] {
    return this.tabs.map((tab) => ({
      ...this.descriptorOf(tab),
      reportedSessionId: tab.reportedSessionId,
      sandbox: tab.sandbox,
      sandboxOnly: tab.sandboxOnly,
    }));
  }

  /** What `events-tail` answers: the latest hook reports, claims and closes, oldest first. */
  events(): ControlEvent[] {
    return [...this.recorded];
  }

  private record(event: Omit<ControlEvent, "at">): void {
    this.recorded.push({ at: Date.now(), ...event });
    this.recorded.splice(0, this.recorded.length - MAX_RECORDED_EVENTS);
  }

  private postTabs(): void {
    // A late post would revive a closed repository or worktree in the renderer.
    if (this.disposed) {
      return;
    }
    this.callbacks.onTabs(this.at.ref, this.snapshot());
  }

  /** The archived tabs in the archive's own order (ArchivedTabs.snapshot). */
  archivedSnapshot(): TabDescriptor[] {
    return this.archived.snapshot();
  }

  /** What onStartupProgress last said — a bootstrap at app start runs before the window exists. */
  isStarting(): boolean {
    return this.indicators.any();
  }

  /**
   * Restores one tab per persisted session of every installed agent; the start phase lasts until
   * the window has brought back its own tabs too (`restore`), and only then is a first agent tab
   * opened where there is none.
   */
  async bootstrap(): Promise<void> {
    this.indicators.acquire();
    try {
      await Promise.all(AGENTS.map((agent) => this.runtimeFor(agent.id).ready));
      await this.windowRestored;
      this.openFirstAgentTab();
      this.pruneArchive();
    } finally {
      this.indicators.release();
    }
  }

  /**
   * The window's restore (`use-tab-restore.ts`), once per repository or worktree: the plain shells
   * it had open when it last closed come back under their ids where free, so its saved layout finds
   * them, and the start phase may end (`bootstrap`). A reloaded window's second call brings nothing
   * back twice. A shell starts as any tab, at its first fit.
   */
  restore(shellIds: string[]): void {
    if (this.restoredByWindow) {
      return;
    }
    this.restoredByWindow = true;
    for (const tabId of shellIds) {
      this.addTab("shell", this.tabOf(tabId) ? {} : { tabId });
    }
    this.resolveWindowRestored();
  }

  /** Drops archive.json ids no agent recognizes anymore, once every agent with sessions was
   *  listed (bringUp): skipped where one wasn't (not installed, sbx not ready yet), so a session
   *  merely unreachable right now is never mistaken for one that is gone. */
  private pruneArchive(): void {
    if (this.disposed) {
      return;
    }
    const sessionAgents = AGENTS.filter((agent) => agent.sessions);
    if (!sessionAgents.every((agent) => this.runtimes.get(agent.id)?.startable)) {
      return;
    }
    const present = new Set(
      [...this.tabs, ...this.archived.all()].map((tab) => tab.sessionId).filter((id): id is string => id !== undefined),
    );
    this.archived.prune(present);
  }

  /**
   * A repository or worktree with no restored session opens one tab of the first installed agent
   * with sessions (never the shell). Nothing spawns until the first resize; unused, it persists
   * nothing.
   */
  private openFirstAgentTab(): void {
    // Before the window's restore, tabs may still come back.
    if (this.disposed || !this.restoredByWindow || this.tabs.length > 0) {
      return;
    }
    const agent = AGENTS.find((candidate) => candidate.sessions && this.canStart(this.runtimeFor(candidate.id)));
    if (agent) {
      this.createTab(agent.id);
    }
  }

  private runtimeFor(agentId: AgentId): AgentRuntime {
    const existing = this.runtimes.get(agentId);
    if (existing) {
      return existing;
    }
    const agent = getAgent(agentId);
    const executable = agent.executable();
    const context = this.placeContext(agent, executable);
    const runtime: AgentRuntime = {
      agent,
      executable,
      // An agent without a version check (the shell) is always there.
      startable: agent.install === undefined,
      sbxOnly: false,
      host: new HostPlace(context, () => this.hostSetups.preparation(agentId)),
      ...(hasSandbox(agent) && { sandbox: new SandboxPlace({ ...context, agent }) }),
      ready: Promise.resolve(),
    };
    if (agent.sessions) {
      runtime.reconciler = new ReconcileScheduler({
        reconcile: () => this.reconcile(runtime),
        titlesUnsettled: () => this.titlesUnsettled(runtime),
        working: () => this.tabs.some((tab) => tab.agentId === agentId && tab.inTurn),
        disposed: () => this.disposed,
      });
    }
    this.runtimes.set(agentId, runtime);
    runtime.ready = this.prepareRuntime(runtime);
    return runtime;
  }

  /**
   * One agent's sessions of this repository or worktree, from each of its places
   * (TabPlace.listSessions): the sandbox's tagged with it, so resolvePlace sends them back.
   */
  private async listSessions({ host, sandbox }: AgentRuntime): Promise<AgentSessionInfo[]> {
    // In parallel: the bootstrap listing, and every reconcile.
    const listed = await Promise.all([host, ...(sandbox ? [sandbox] : [])].map((place) => place.listSessions()));
    return listed.flat();
  }

  /** What a place of this agent's tabs is built from. */
  private placeContext(agent: AgentDefinition, executable: string): PlaceContext {
    return {
      at: this.at,
      dataRoot: this.dataRoot,
      agent,
      executable,
      onNotice: (severity, message) => this.callbacks.onNotice(severity, message),
    };
  }

  /**
   * Where a tab runs: where its latest start ran it, else where its session lives — so a session
   * is always operated on where it lives, the sandbox's mounted root or the host's repository.
   */
  private placeOf(tab: TabState): TabPlace {
    const { host, sandbox } = this.runtimeFor(tab.agentId);
    return tab.place ?? (tab.sandbox && sandbox ? sandbox : host);
  }

  private canStart(runtime: AgentRuntime): boolean {
    return runtime.startable && !this.hostSetups.failed(runtime.agent.id);
  }

  private async prepareRuntime(runtime: AgentRuntime): Promise<void> {
    const { agent } = runtime;
    const cwd = this.at.path;

    if (agent.install) {
      runtime.startable = await agentInstalled(agent, cwd);
      // Not here, but the project's sandbox has the CLI. Only the settings are read — checkSbxReady
      // talks to Docker and stays on the spawn (resolvePlace).
      if (!runtime.startable && runtime.sandbox && (await readSbxSettings(cwd)).enabled) {
        this.markSbxOnly(runtime);
      }
    }
    if (!runtime.startable || !agent.sessions) {
      return;
    }
    await this.bringUp(runtime);
  }

  /** No host executable, but the repository's or worktree's sandbox stands in. */
  private markSbxOnly(runtime: AgentRuntime): void {
    runtime.startable = true;
    runtime.sbxOnly = true;
  }

  /** A startable agent's setup, its existing sessions as tabs, and the watch keeping them current. */
  private async bringUp(runtime: AgentRuntime): Promise<void> {
    const { agent } = runtime;
    // A failed setup lists nothing: none of its sessions could start. Closed meanwhile: nothing
    // may spawn from here on.
    if (!(await this.hostSetups.prepare(agent)) || this.disposed) {
      return;
    }

    const infos = await this.listSessions(runtime);
    // Closed while listing: the watcher started below would outlive `dispose`.
    if (this.disposed) {
      return;
    }
    // Runs again for an agent startable later (sbxSettingsChanged): skip sessions already on screen,
    // reported but unclaimed, or still being deleted (as in reconcile). A tab's id too: a restored
    // tab keeps its session's id after moving on to another (`/clear`), and ids must stay unique.
    const known = new Set([
      ...[...this.tabs, ...this.archived.all()].flatMap((tab) => [tab.tabId, tab.sessionId, tab.reportedSessionId]),
      ...this.deletingSessionIds,
    ]);
    const fresh = infos.filter((candidate) => !known.has(candidate.id));
    const archived = this.archived.storedIds();
    const asTab = (info: AgentSessionInfo): TabState => ({ tabId: info.id, agentId: agent.id, ...sessionFieldsOf(info), status: "ready" });
    const opened = fresh.filter((info) => !archived.has(info.id)).map(asTab);
    const kept = fresh.filter((info) => archived.has(info.id)).map(asTab);
    if (opened.length > 0) {
      this.tabs.push(...opened);
      // Every agent brings its sessions up on its own: oldest first overall, a tab not listed yet last.
      this.tabs.sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity));
      this.postTabs();
    }
    this.archived.add(kept);
    // After the listing, so its first event can't race the bootstrap.
    this.startWatching(runtime);
  }

  /**
   * tet.json was written, by anyone (tet-json.ts's PROJECT_FILE). Picked up now, not at the next
   * start: `addProject` opens the project before the dialog enabling SBX shows, and a
   * machine with no agent would sit at an empty project. Only unstartable runtimes are acted on.
   * `enabled` is whether the file enables SBX, read once for every repository and worktree (main.ts).
   */
  async sbxSettingsChanged(enabled: boolean): Promise<void> {
    const sbxRuntimes = [...this.runtimes.values()].filter((runtime) => runtime.sandbox !== undefined);
    if (this.disposed || sbxRuntimes.length === 0) {
      return;
    }
    // During bootstrap, a running version check's "not startable" is not "no executable here".
    await Promise.all(sbxRuntimes.map((runtime) => runtime.ready));
    if (this.disposed) {
      return;
    }
    const candidates = sbxRuntimes.filter((runtime) => runtime.sbxOnly || !runtime.startable);
    const brought: Promise<void>[] = [];
    for (const runtime of candidates) {
      if (enabled && !runtime.startable) {
        this.markSbxOnly(runtime);
        // So a tab awaiting `ready` joins this instead of starting on an unprepared runtime.
        runtime.ready = this.bringUp(runtime);
        brought.push(runtime.ready);
      } else if (!enabled && runtime.sbxOnly) {
        // Open tabs keep their session (a spawn gets resolvePlace's notice); new tabs show missing.
        runtime.startable = false;
        runtime.sbxOnly = false;
      }
    }
    if (brought.length === 0) {
      return;
    }
    await Promise.all(brought);
    if (this.disposed) {
      return;
    }
    const startable = new Set(candidates.filter((runtime) => this.canStart(runtime)).map((runtime) => runtime.agent.id));
    for (const tab of this.tabs.filter((candidate) => candidate.status === "missing" && startable.has(candidate.agentId))) {
      this.runs.startMissing(tab);
    }
    // Only when something became startable; otherwise a tab the user closed stays closed.
    this.openFirstAgentTab();
  }

  private startWatching(runtime: AgentRuntime): void {
    if (runtime.stopWatching) {
      return;
    }
    runtime.stopWatching = runtime.host.watchSessions(() => runtime.reconciler?.watched());
  }

  /** Whether the repository or worktree still has this tab: main drops output it batched for one
   *  that closed before the batch was flushed (AppWindow.flushOutput). */
  hasTab(tabId: string): boolean {
    return this.tabs.some((tab) => tab.tabId === tabId);
  }

  /** `prompt` only for an agent with a `terminal`; the caller checks. */
  createTab(agentId: AgentId, sandboxOnly = false, prompt?: string): TabDescriptor {
    return this.addTab(agentId, { ...(sandboxOnly && { sandboxOnly }), ...(prompt !== undefined && { initialPrompt: prompt }) });
  }

  /** A new tab of `agentId` starting on `file`, for an agent with a `terminal`; the caller checks. */
  createTabOnFile(agentId: AgentId, file: InitialFile, sandboxOnly = false): TabDescriptor {
    return this.addTab(agentId, { initialFile: file, ...(sandboxOnly && { sandboxOnly }) });
  }

  /**
   * A tab of `agentId` taking over this tab's session: the session's files as the agent keeps them,
   * and a prompt to read them (prompts.ts). This tab stays as it is. Answers what went wrong
   * rather than notifying it, as renameTab does: `tabs-hand-over` fails with it, the window notifies.
   */
  async handOver(tabId: string, agentId: AgentId, sandboxOnly = false): Promise<HandoverResult> {
    const tab = this.tabOf(tabId);
    if (!tab) {
      return { ok: false, error: "The tab is closed" };
    }
    const { agent } = this.runtimeFor(tab.agentId);
    if (!tab.sessionId || !agent.sessions) {
      return { ok: false, error: `This ${agent.displayName} tab has no session yet` };
    }
    const target = getAgent(agentId);
    if (agentId === tab.agentId || !target.terminal) {
      return { ok: false, error: `${target.displayName} cannot take over a ${agent.displayName} session` };
    }
    const sessionId = tab.sessionId;
    const actions = this.placeOf(tab).sessionActions();
    const files = (await actions?.files(sessionId)) ?? [];
    if (files.length === 0) {
      return { ok: false, error: `The ${agent.displayName} session's files were not found` };
    }
    const handover = { from: tab.agentId, sessionId, files, within: actions?.root };
    return { ok: true, tab: this.addTab(agentId, { handover, ...(sandboxOnly && { sandboxOnly }) }) };
  }

  /** Where this tab's pasted or dropped content without a path is written (TabPlace.dropsDir); a
   *  closed tab's in the project's host folder. */
  dropsDir(tabId: string): string {
    const tab = this.tabOf(tabId);
    return tab ? this.placeOf(tab).dropsDir() : dropsDir(this.dataRoot, this.at.ref.projectId);
  }

  /** Paths of this machine where the tab sees them (TabPlace.handPaths). A closed tab sees
   *  nothing. */
  async seenPaths(tabId: string, hostPaths: string[]): Promise<string[]> {
    const tab = this.tabOf(tabId);
    return tab ? this.placeOf(tab).handPaths(hostPaths) : [];
  }

  /** Dropped or pasted paths of this machine as the words the tab types: where it sees them
   *  (seenPaths), quoted for its input (AgentDefinition.quotePath). A closed tab types nothing. */
  async handPaths(tabId: string, hostPaths: string[]): Promise<string[]> {
    const tab = this.tabOf(tabId);
    if (!tab) {
      return [];
    }
    const { agent } = this.runtimeFor(tab.agentId);
    return (await this.placeOf(tab).handPaths(hostPaths)).map((handed) => agent.quotePath(handed));
  }

  /** A tab whose process is the platform's shell running a saved command's line. */
  createCommandTab(command: ProjectCommand): TabDescriptor {
    return this.addTab("shell", {
      title: command.name ?? command.command,
      command: command.command,
      // `resolve`, not `join`, so an absolute folder is left alone.
      cwd: command.cwd ? path.resolve(this.at.path, command.cwd) : undefined,
      env: command.env,
      runArgs: PLATFORM.shellCommandArgs(command.command),
    });
  }

  private addTab(agentId: AgentId, extra: Partial<TabState>): TabDescriptor {
    const runtime = this.runtimeFor(agentId);
    newTabCounter += 1;
    const tab: TabState = {
      tabId: `new-${RUN_STAMP}-${newTabCounter}`,
      agentId,
      title: "",
      status: this.canStart(runtime) ? "ready" : "missing",
      ...extra,
    };
    this.tabs.push(tab);

    this.postTabs();
    // Starting begins with the first fit.
    return this.descriptorOf(tab);
  }

  /**
   * Deletes the tabs' sessions. All leave the UI at once; teardown runs one tab at a time, so
   * listing and removal never overlap.
   */
  async closeTabs(tabIds: string[]): Promise<void> {
    const doomed = new Set(tabIds);
    const tabs = this.tabs.filter((tab) => doomed.has(tab.tabId));
    if (tabs.length === 0) {
      return;
    }
    const indices = new Map(tabs.map((tab) => [tab.tabId, this.tabs.indexOf(tab)]));
    for (const tab of tabs) {
      this.record({ tabId: tab.tabId, kind: "closed", sessionId: tab.sessionId });
    }
    this.tabs = this.tabs.filter((tab) => !doomed.has(tab.tabId));
    this.postTabs();

    // A fresh tab (or one whose session was just replaced, bindReportedSession) may have persisted
    // a session: detachedTabs lets a hook name it and reconcile claim it for deletion. Joined
    // before any stop — a tab closed right after its prompt reports during the stop's grace period.
    for (const tab of tabs) {
      if (getAgent(tab.agentId).sessions && (!tab.sessionId || awaitsClaim(tab)) && this.runs.hasSession(tab.tabId)) {
        this.detachedTabs.push(tab);
      }
    }
    // All stops start before any is awaited: each takes a grace period (TerminalSession.stop).
    const ends = new Map(tabs.map((tab) => [tab.tabId, this.runs.end(tab)] as const));
    for (const tab of tabs) {
      await this.destroyTab(tab, indices.get(tab.tabId) ?? this.tabs.length, ends.get(tab.tabId));
    }
  }

  /**
   * Deletes a removed tab's persisted session; `index` puts the tab back if that fails. `ended`
   * is its process's end closeTabs started (TabRuns.end), none where it had none.
   */
  private async destroyTab(tab: TabState, index: number, ended: Promise<void> | undefined): Promise<void> {
    const runtime = this.runtimeFor(tab.agentId);
    const { agent } = runtime;
    const detached = this.detachedTabs.includes(tab);
    try {
      // Delete only once the process is gone.
      await ended;
      if (!agent.sessions) {
        return;
      }
      if (detached && awaitsClaim(tab)) {
        // A reconcile underway listed before the session was named; then run one that sees it.
        await runtime.reconciler?.inFlight;
        await runtime.reconciler?.run();
      }
    } finally {
      if (detached) {
        this.detachedTabs.splice(this.detachedTabs.indexOf(tab), 1);
      }
      if (tab.handoverDir !== undefined) {
        removeHandoverCopy(tab.handoverDir);
      }
    }
    const sessionId = tab.sessionId;
    if (!sessionId) {
      return;
    }
    this.deletingSessionIds.add(sessionId);
    try {
      if (ended) {
        await new Promise((resolve) => setTimeout(resolve, SESSION_REMOVE_DELAY_MS));
      }
      await this.placeOf(tab).sessionActions()?.remove(sessionId);
    } catch (error) {
      this.callbacks.onNotice("error", `Could not delete ${agent.displayName} session: ${errorMessage(error)}`);
      settleWithoutProcess(tab);
      this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
      this.postTabs();
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  /**
   * Without a sessionId nothing is renamed, and the renderer's optimistic label reverts. Answers
   * what the agent refused rather than notifying it: the window's question is still up and shows
   * it under the field the name was typed in, and `tabs-rename` fails instead of reporting a
   * rename that did not happen.
   */
  async renameTab(tabId: string, title: string): Promise<ActionResult> {
    const tab = this.tabOf(tabId);
    if (!tab) {
      return { ok: true };
    }
    const { agent } = this.runtimeFor(tab.agentId);
    if (!tab.sessionId || !agent.sessions) {
      this.postTabs();
      return { ok: true };
    }
    try {
      await this.placeOf(tab).sessionActions()?.rename(tab.sessionId, title);
      tab.title = title.trim();
      // A name the user picked is final.
      tab.provisionalTitle = false;
    } catch (error) {
      this.postTabs();
      return { ok: false, error: `Could not rename ${agent.displayName} session: ${errorMessage(error)}` };
    }
    this.postTabs();
    return { ok: true };
  }

  /**
   * The window's close: a tab with a session is kept archived, its session with it
   * (ArchivedTabs.keep); any other closes as `closeTabs` closes it. One whose session cannot be kept
   * stays, said in a notice.
   */
  async closeKeepingSessions(tabIds: string[]): Promise<void> {
    const others: string[] = [];
    for (const tabId of tabIds) {
      const tab = this.tabOf(tabId);
      if (tab?.sessionId === undefined) {
        others.push(tabId);
        continue;
      }
      const kept = this.archived.keep(tab, tab.sessionId);
      if (!kept.ok) {
        this.callbacks.onNotice("error", kept.error);
      }
    }
    await this.closeTabs(others);
  }

  /** ArchiveTarget.takeOffStrip: the tab leaves the strip as closed, its process stopping. */
  private takeOffStrip(tab: TabState): Promise<void> | undefined {
    this.record({ tabId: tab.tabId, kind: "closed", sessionId: tab.sessionId });
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    this.postTabs();
    return this.runs.end(tab);
  }

  /** TabRuns.start. */
  start(tabId: string): boolean {
    return this.runs.start(tabId);
  }

  /** TabRuns.restart. */
  restart(tabId: string): boolean {
    return this.runs.restart(tabId);
  }

  /** TabRuns.restartTab. */
  restartTab(tabId: string, running = false): boolean {
    return this.runs.restartTab(tabId, running);
  }

  /** TabRuns.handleResize. */
  handleResize(tabId: string, cols: number, rows: number): void {
    this.runs.handleResize(tabId, cols, rows);
  }

  /** TabRuns.write. */
  write(tabId: string, data: string): void {
    this.runs.write(tabId, data);
  }

  /** TabRuns.openInTerminal. */
  openInTerminal(tabId: string): Promise<void> {
    return this.runs.openInTerminal(tabId);
  }

  /** ArchivedTabs.reopen. */
  reopenArchived(tabId: string): Promise<ActionResult> {
    return this.archived.reopen(tabId);
  }

  /** ArchivedTabs.reorder. */
  reorderArchived(tabIds: string[]): ActionResult {
    return this.archived.reorder(tabIds);
  }

  /** ArchivedTabs.rename. */
  renameArchived(tabId: string, title: string): Promise<ActionResult> {
    return this.archived.rename(tabId, title);
  }

  /** ArchivedTabs.delete. */
  deleteArchived(tabId: string): Promise<ActionResult> {
    return this.archived.delete(tabId);
  }

  /**
   * A tab's hook report: how turns reach TET ("Turns and tab marks" in AGENTS.md); only a turn the
   * user cut short is ended otherwise (reconcile, AgentSessionInfo.turnEndedAt). Addressed by tab
   * (`TET_TAB_ID` in the hook's environment, passed into a sandbox by prepareSbxRun), so no turn is
   * reported for a session no tab has claimed.
   *
   * Answers the agent's stdout and the notification, composed here so settings are read at the event,
   * not baked in at setup. Showing a mark is the renderer's call; no notification for a tab on screen
   * (`setOnScreen`).
   */
  hookEvent(tabId: string, event: HookEvent, payload: string, reportedAt: number | undefined, side: ControlSide): HookOutcome {
    const listed = this.tabOf(tabId);
    // Closed: the hook still gets its reply, but changes nothing.
    const tab = this.disposed ? undefined : listed;
    // A tab closed right after its first prompt still needs its session named, to delete it.
    const bound = tab ?? this.detachedTabs.find((candidate) => candidate.tabId === tabId);
    const replying = listed ?? bound;
    // The agent's own contract for what its hook prints (AgentTurns.hookReply).
    const stdout = (replying && getAgent(replying.agentId).turns?.hookReply?.(event, side)) ?? "";
    return { ...this.applyHook(tabId, tab, bound, event, payload, reportedAt), stdout };
  }

  /** hookEvent's state change and notification: `tab` is marked, `bound` (it, or a detached one)
   *  named its session. */
  private applyHook(
    tabId: string,
    tab: TabState | undefined,
    bound: TabState | undefined,
    event: HookEvent,
    payload: string,
    reportedAt: number | undefined,
  ): Omit<HookOutcome, "stdout"> {
    const sessionId = bound ? getAgent(bound.agentId).turns?.sessionIdOf(payload) : undefined;
    this.record({ tabId, kind: "hook", event, reportedAt, sessionId });
    // When the hook *fired*, not arrived: two hooks of a turn race, and arrival order leaves a tab
    // finished and working. One tab, one clock.
    const at = typeof reportedAt === "number" && Number.isFinite(reportedAt) && reportedAt > 0 ? reportedAt : Date.now();
    if (bound && sessionId && bindReportedSession(bound, sessionId, at)) {
      this.runs.sessionNamed(bound.tabId);
      if (awaitsClaim(bound)) {
        this.runtimeFor(bound.agentId).reconciler?.schedule();
      }
    }
    if (!tab) {
      return {};
    }
    const { changed, notify } = applyTurnReport(tab, event, payload, at);
    if (changed) {
      this.postTabs();
    }
    return notify ? { notification: this.notification(tab, notify) } : {};
  }

  /** No notification for a tab on screen, as with the marks: it was never out of sight. */
  private notification(tab: TabState, kind: NotificationKind): HookNotification | undefined {
    if (this.onScreen.has(tab.tabId)) {
      return undefined;
    }
    return notificationFor(tab, kind, this.at.name(), this.settings.get().notifications);
  }

  /**
   * A tab on screen has its finished turn seen. A question stays: it ends with an answer (`write`,
   * `answered`) or the turn (setTurn).
   */
  markSeen(tabId: string): void {
    const tab = this.tabOf(tabId);
    if (tab?.finishedAt === undefined) {
      return;
    }
    tab.finishedAt = undefined;
    this.postTabs();
  }

  /** Tabs on screen in a focused, uncovered window, as only the renderer knows — no notification there. */
  setOnScreen(tabIds: readonly string[]): void {
    this.onScreen = new Set(tabIds);
  }

  /** Whether a tab of the agent still waits for its session or title. */
  private titlesUnsettled(runtime: AgentRuntime): boolean {
    return this.tabs.some((tab) => tab.agentId === runtime.agent.id && titleUnsettled(tab));
  }

  private tabOf(tabId: string): TabState | undefined {
    return this.tabs.find((candidate) => candidate.tabId === tabId);
  }

  /** Re-lists one agent's sessions to claim reported sessions and refresh known tabs; run through
   *  its ReconcileScheduler only. */
  private async reconcile(runtime: AgentRuntime): Promise<void> {
    const { agent } = runtime;
    if (this.disposed || !agent.sessions || !this.canStart(runtime)) {
      return;
    }
    const infos = await this.listSessions(runtime);
    const ownTabs = this.tabs.filter((tab) => tab.agentId === agent.id);
    const claimed = new Set([...ownTabs.map((tab) => tab.sessionId).filter((id) => id !== undefined), ...this.deletingSessionIds]);
    let changed = false;

    // Each tab takes the session its hooks named (bindReportedSession), once listed, and only from
    // the store where it runs: a sandbox could list a host tab's session id in its own.
    const pendingTabs = [...ownTabs, ...this.detachedTabs.filter((tab) => tab.agentId === agent.id)].filter(awaitsClaim);
    for (const tab of pendingTabs) {
      const store = this.placeOf(tab).sandbox;
      const match = infos.find((info) => info.id === tab.reportedSessionId && info.sandbox === store && !claimed.has(info.id));
      if (!match) {
        continue;
      }
      claimed.add(match.id);
      this.record({ tabId: tab.tabId, kind: "claimed", sessionId: match.id });
      Object.assign(tab, sessionFieldsOf(match));
      // A detached tab is gone from the UI; claiming its id is all that's needed.
      changed ||= this.tabs.includes(tab);
    }

    for (const tab of ownTabs) {
      if (!tab.sessionId) {
        continue;
      }
      const info = infos.find((candidate) => candidate.id === tab.sessionId && candidate.sandbox === tab.sandbox);
      if (!info) {
        continue;
      }
      // Even with an unchanged label: a name equal to the stand-in still ends polling.
      tab.provisionalTitle = info.provisionalTitle;
      // A turn the user cut short that no hook reported (pi's extension reports its own,
      // AgentTurns.stopCutShort): only the session record has the end. Only a later end than the
      // turn's start counts, and it leaves no mark — the user was in that tab.
      if (tab.inTurn && info.turnEndedAt !== undefined && info.turnEndedAt > (tab.turnStartedAt ?? 0)) {
        endTurnQuietly(tab);
        changed = true;
      }
      if (info.title !== tab.title || info.updatedAt !== tab.updatedAt) {
        tab.title = info.title;
        tab.updatedAt = info.updatedAt;
        changed = true;
      }
    }

    if (changed) {
      this.postTabs();
    }
  }

  async dispose(): Promise<void> {
    // See ReconcileTarget.disposed.
    this.disposed = true;
    this.resolveWindowRestored();
    // A start still underway spawns only if its tab is still known.
    this.tabs = [];
    this.archived.dispose();
    const stopped = this.runs.dispose();
    this.indicators.dispose();
    for (const runtime of this.runtimes.values()) {
      runtime.reconciler?.dispose();
      runtime.stopWatching?.();
      runtime.stopWatching = undefined;
    }
    await stopped;
  }
}
