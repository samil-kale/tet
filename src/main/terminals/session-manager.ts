import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, getAgent } from "../agents";

import type { AgentDefinition, AgentPaths, AgentSessionInfo, SpawnPreparation } from "../agents/agent";
import { splitCommand } from "../../shared/command";
import { CONTROL_ENV } from "../../shared/control";
import type { ControlEvent, HookEvent } from "../../shared/control";
import type { HookOutcome, HookToast, InspectedTab } from "../control/control-server";
import { isSbxAgent } from "../../shared/types";
import type {
  AgentId,
  NoticeSeverity,
  Project,
  ProjectCommand,
  TerminalDescriptor,
  TerminalStatus
} from "../../shared/types";
import { countActivity, logSlow, markStartup } from "../event-loop-monitor";
import { readSbxConfig } from "../git/commands";
import { checkSbxReady, ensureRunning, prepareSbxRun, sandboxName } from "../sbx";
import type { SbxSecretStore } from "../sbx-secrets";
import type { SettingsStore } from "../settings";
import { agentDirFor } from "./agent-data";
import { isAgentInstalled, TerminalSession } from "./terminal-session";
import { sandboxSessionDir, toContainerPath } from "./hook-target";
import { reportApplies } from "./turn-order";
import { currentTheme } from "../theme";

const RECONCILE_DEBOUNCE_MS = 5000;
// A CLI can persist a generated title well after its output went idle.
const RECONCILE_RETRY_MS = 5000;
const RECONCILE_MAX_RETRIES = 3;
// Caps how far a continuously redrawing CLI pushes the debounce while session or title is unknown.
const RECONCILE_MAX_WAIT_MS = 10000;
// A watcher event is the change itself; only the few events per write need collapsing.
const WATCH_DEBOUNCE_MS = 300;
// Lets a killed CLI die first, so a final in-flight write can't resurrect the deleted transcript.
const SESSION_REMOVE_DELAY_MS = 500;
// How long after a fresh tab's Enter its close waits for the hook naming its session
// (reportBeforeQuit). Measured on win32, Codex on the host: 1.2–1.3 s.
const REPORT_WAIT_MS = 3000;
// How far back `tet-ctl events-tail` can look.
const MAX_RECORDED_EVENTS = 200;
// The size `tet-ctl tabs-start` gives a tab no window has fitted yet.
const CONTROL_START_SIZE = { cols: 120, rows: 30 };
// Readiness fires on the CLI's first full frame, a moment before the terminal looks settled.
const INDICATOR_LINGER_MS = 700;
// Across managers, so a project reopened in this run never reuses a closed tab's id — and token.
let newTabCounter = 0;
/**
 * A shell-only token, refused in a saved command (no shell runs it). Whole tokens only — `2>&1`
 * and `>>` match, an argument holding a `>` does not.
 */
const SHELL_OPERATOR = /^(?:&&|\|\||[|;&]|\d*>>?|\d*>&\d*|<)$/;

interface TabState extends TerminalDescriptor {
  /** The session this tab's hooks named (AgentDefinition.sessionIdOf), claimed as `sessionId`
   *  once listed. */
  reportedSessionId?: string;
  /** When the latest report naming a session was made (ControlRequest.at) — see bindReportedSession. */
  sessionReportAt?: number;
  /** When Enter last went into this tab while it had named no session — see reportBeforeQuit. */
  submittedAt?: number;
  /** Mirrors AgentSessionInfo.provisionalTitle. */
  provisionalTitle?: boolean;
  /** Mirrors AgentSessionInfo.sandbox. */
  sandbox?: string;
  /** Opened by `tet-ctl` from a sandbox: runs in the sandbox or not at all (resolveSbxRun), or the
   *  sandbox could switch sbx off in tet.json and open itself a tab on this machine. */
  sandboxOnly?: true;
  /** When the running turn was reported started — what a turn end is dated against. */
  busySince?: number;
  /**
   * When the latest applied turn signal was made (ControlRequest.at). Two hooks can race to the
   * channel (a question just before the turn ends); an older one is dropped (turn-order.ts).
   */
  signalAt?: number;
  /** A saved command's program, when not this agent's executable. */
  executable?: string;
  /** A saved command's arguments — its program's, or a shell's when it asked for one. */
  runArgs?: string[];
  /** The process's folder, when not the project root. */
  cwd?: string;
  /** A saved command's variables, outranking the machine's. */
  env?: Record<string, string>;
}

/** Per-agent state within one project. */
interface AgentRuntime {
  agent: AgentDefinition;
  executable: string;
  /** Startable here: the host executable, or the project's sandbox standing in (sbxOnly). */
  startable: boolean;
  /**
   * No host executable — startable only through the project's sandbox, with nothing to fall back
   * to. Decided with the project's config; whether the sandbox is *reachable* is resolveSbxRun's
   * question, per spawn.
   */
  sbxOnly: boolean;
  /** Resolves once the version check, spawn preparation and initial listing are done. */
  ready: Promise<void>;
  preparation?: SpawnPreparation;
  /** The theme `preparation` was written for — see themeChanged. */
  preparedTheme?: string;
  prepareFailed: boolean;
  /** One setup at a time: two tabs opened at once must not write it twice. */
  preparing?: Promise<boolean>;
  /** A rerun was asked for while `preparing` ran, which read the theme before it changed. */
  prepareAgain?: boolean;
  stopWatching?: () => void;
  reconciling?: Promise<void>;
  reconcileTimer?: ReturnType<typeof setTimeout>;
  reconcileRetriesLeft: number;
  /** The latest the debounced reconcile may be pushed to; unset once it fires. */
  reconcileDeadline?: number;
}

export interface SessionManagerCallbacks {
  onTabs: (projectId: string, tabs: TerminalDescriptor[]) => void;
  onOutput: (projectId: string, tabId: string, data: string) => void;
  onStatus: (projectId: string, tabId: string, status: TerminalStatus) => void;
  /** Whether anything in this project is still starting — drives the tab strip's bar. */
  onStartupProgress: (projectId: string, show: boolean) => void;
  onNotice: (severity: NoticeSeverity, message: string) => void;
}

/** This tab's hooks named a session it has not claimed: its first, or one it moved on to. */
function awaitsClaim(tab: TabState): boolean {
  return tab.reportedSessionId !== undefined && tab.reportedSessionId !== tab.sessionId;
}

/** No session claimed, no title, or only a stand-in the agent may still replace. */
function titleUnsettled(tab: TabState): boolean {
  return !tab.sessionId || awaitsClaim(tab) || !tab.title || tab.provisionalTitle === true;
}

/**
 * A turn started or ended. Either end clears `waitingAt` — a question stands within its turn.
 *
 * `keepQuestion`, for AgentDefinition.questionOutlivesTurn: the question stays **and the end
 * leaves no bubble beside it** — one moment, and the project row, with a button per condition,
 * would step through that tab twice. The question is the more urgent and actionable of the two.
 *
 * No agent reports an answered question, so a permission granted mid-turn keeps the mark until
 * the tab is looked at.
 */
function setTurn(tab: TabState, busy: boolean, at: number, keepQuestion = false): void {
  tab.busy = busy;
  tab.signalAt = at;
  if (busy) {
    tab.waitingAt = undefined;
    tab.busySince = at;
    return;
  }
  if (keepQuestion && tab.waitingAt !== undefined) {
    return;
  }
  tab.waitingAt = undefined;
  tab.finishedAt = at;
}

/** Whether a question left standing already said this turn's end — see setTurn. */
function endLeavesQuestion(tab: TabState, agent: AgentDefinition): boolean {
  return agent.questionOutlivesTurn === true && tab.waitingAt !== undefined;
}

/**
 * Whether terminal input can answer a standing question — see `write`. No agent reports an answer,
 * so this and either end of the turn (setTurn) are what clear the mark. Enter, a printable
 * character (Claude Code's permission prompt takes a digit without Enter) and an SGR mouse press
 * (`ESC [ < button ; x ; y M`). Not arrows, Tab, Shift+Tab, a bare Escape, motion (bit 32) or the
 * wheel (64+). Generous: a mark dropped early is on a tab being typed into, which hides it anyway.
 */
function answersQuestion(data: string): boolean {
  if (data.includes("\r") || data.includes("\n")) {
    return true;
  }
  // eslint-disable-next-line no-control-regex
  const mouse = /\x1b\[<(\d+);\d+;\d+M/.exec(data);
  if (mouse) {
    const button = Number(mouse[1]);
    return (button & 32) === 0 && button < 64;
  }
  // Arrows, function keys, a bare ESC.
  if (data.startsWith("\x1b")) {
    return false;
  }
  return /\S/.test(data);
}

/** `starting` comes from the caller's `tabIndicators`. */
function toDescriptor(tab: TabState, starting: boolean): TerminalDescriptor {
  const { tabId, projectId, agentId, title, updatedAt, createdAt, status, sessionId, finishedAt, busy, waitingAt, command } = tab;
  return {
    tabId,
    projectId,
    agentId,
    title,
    updatedAt,
    createdAt,
    status,
    finishedAt,
    busy,
    waitingAt,
    starting,
    sessionId,
    savedCommand: isSavedCommandTab(tab),
    command
  };
}

/** Either field is set only by `createCommandTab`. */
function isSavedCommandTab(tab: TabState): boolean {
  return tab.executable !== undefined || tab.runArgs !== undefined;
}

/** Resumes this tab's session, on the host or in its sandbox alike. */
function resumeArgsOf(tab: TabState, agent: AgentDefinition): string[] {
  return tab.sessionId && agent.sessions ? agent.sessions.resumeArgs(tab.sessionId) : [];
}

/**
 * One project's terminal tabs, mirroring the agents' persisted sessions: each session found at
 * open becomes a tab, and closing a tab deletes its session.
 */
export class ProjectSessionManager {
  private tabs: TabState[] = [];
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly runtimes = new Map<AgentId, AgentRuntime>();
  /** Tabs whose session is being constructed; a second resize must not start a second one. */
  private readonly starting = new Set<string>();
  /**
   * The last size each tab was fitted to, used by every spawn — a restart comes after the fit,
   * and no new fit follows.
   */
  private readonly lastSizes = new Map<string, { cols: number; rows: number }>();
  /** Session ids whose removal is in flight — reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs gone from the UI whose persisted session must still be claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];
  /** Per tab id, what ends a close's wait for the report naming its session (reportBeforeQuit). */
  private readonly reportWaiters = new Map<string, () => void>();
  /** See `events`. */
  private readonly recorded: ControlEvent[] = [];
  /** Closed; nothing still in flight may start anything back up. */
  private disposed = false;
  /** Said once per project — see resolveSbxRun's own-session-id fallback. */
  private sbxPreexistingSaid = false;
  /** How many things are still starting; the bar stays up while any is. */
  private indicators = 0;
  /**
   * Those per tab (`TerminalDescriptor.starting`). A count: a tab's setup and first frame overlap,
   * and a release for a closed tab must balance its acquire (`closeTabs` can put a tab back).
   */
  private readonly tabIndicators = new Map<string, number>();
  /** The tabs in front of the user, as last reported (`setInFront`). */
  private inFront: ReadonlySet<string> = new Set();

  constructor(
    private readonly project: Project,
    private readonly storageRoot: string,
    private readonly settings: SettingsStore,
    private readonly secrets: SbxSecretStore,
    private readonly callbacks: SessionManagerCallbacks
  ) {}

  private agentDirOf(agentId: AgentId): string {
    return agentDirFor(this.storageRoot, agentId, this.project.id);
  }

  /** See AgentDefinition.prepareSpawn. */
  private pathsFor(runtime: AgentRuntime): AgentPaths {
    const agentDir = this.agentDirOf(runtime.agent.id);
    fs.mkdirSync(agentDir, { recursive: true });
    return {
      agentDir,
      storageRoot: this.storageRoot,
      idleReminder: this.settings.get().notifications.idleReminder,
      theme: currentTheme(this.settings)
    };
  }

  snapshot(): TerminalDescriptor[] {
    return this.tabs.map((tab) => toDescriptor(tab, this.tabIndicators.has(tab.tabId)));
  }

  /** `snapshot` plus what the window never gets, for `tet-ctl tabs-list`. */
  inspect(): InspectedTab[] {
    return this.tabs.map((tab) => ({
      ...toDescriptor(tab, this.tabIndicators.has(tab.tabId)),
      reportedSessionId: tab.reportedSessionId,
      sandbox: tab.sandbox
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

  /** `tet-ctl tabs-start`: starts a tab no window has fitted, at the last fit's size if any. False
   *  for a tab not waiting for its first start. */
  start(tabId: string): boolean {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab || tab.status !== "ready" || this.sessions.has(tabId)) {
      return false;
    }
    const size = this.lastSizes.get(tabId) ?? CONTROL_START_SIZE;
    this.handleResize(tabId, size.cols, size.rows);
    return true;
  }

  /** `restartTab` for `tet-ctl tabs-restart`, which may come before any window fitted the tab. */
  restart(tabId: string): boolean {
    if (!this.lastSizes.has(tabId)) {
      this.lastSizes.set(tabId, CONTROL_START_SIZE);
    }
    return this.restartTab(tabId);
  }

  private postTabs(): void {
    // A late post would revive a closed project in the renderer.
    if (this.disposed) {
      return;
    }
    this.callbacks.onTabs(this.project.id, this.snapshot());
  }

  /** What onStartupProgress last said — a bootstrap at app start runs before the window exists. */
  isStarting(): boolean {
    return this.indicators > 0;
  }

  /**
   * With `tabId` that tab's pane shows the bar; without (bootstrap) it falls to pane "a". Every
   * acquire needs one release with the same `tabId`.
   */
  private acquireIndicator(tabId?: string): void {
    this.indicators += 1;
    if (this.indicators === 1) {
      this.callbacks.onStartupProgress(this.project.id, true);
    }
    if (tabId !== undefined) {
      const count = this.tabIndicators.get(tabId) ?? 0;
      this.tabIndicators.set(tabId, count + 1);
      if (count === 0) {
        this.postTabs();
      }
    }
  }

  private releaseIndicator(tabId?: string): void {
    // `dispose` already zeroed the counts.
    if (this.disposed) {
      return;
    }
    this.indicators -= 1;
    if (this.indicators === 0) {
      this.callbacks.onStartupProgress(this.project.id, false);
    }
    if (tabId !== undefined) {
      const count = this.tabIndicators.get(tabId) ?? 0;
      if (count <= 1) {
        this.tabIndicators.delete(tabId);
        this.postTabs();
      } else {
        this.tabIndicators.set(tabId, count - 1);
      }
    }
  }

  /** Restores one tab per persisted session of every installed agent. */
  async bootstrap(): Promise<void> {
    this.acquireIndicator();
    try {
      await Promise.all(AGENTS.map((agent) => this.runtimeFor(agent.id).ready));
      this.openFirstAgentTab();
    } finally {
      this.releaseIndicator();
    }
  }

  /**
   * A project with no restored session opens one tab of the first installed agent with sessions
   * (never the shell). Nothing spawns until the first resize; unused, it persists nothing.
   */
  private openFirstAgentTab(): void {
    if (this.disposed || this.tabs.length > 0) {
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
    const runtime: AgentRuntime = {
      agent,
      executable: agent.executable(),
      // An agent without a version check (the shell) is always there.
      startable: agent.versionArgs === undefined,
      sbxOnly: false,
      ready: Promise.resolve(),
      prepareFailed: false,
      reconcileRetriesLeft: 0
    };
    this.runtimes.set(agentId, runtime);
    runtime.ready = this.prepareRuntime(runtime);
    return runtime;
  }

  /**
   * One agent's sessions of this repository: the host's, and the sandbox's through its mount
   * (SessionProvider.sandbox), tagged with the sandbox so resolveSbxRun sends them back. The
   * sandbox is listed whatever the switch: its sessions stay resumable there, for one readdir.
   */
  private async listSessions(runtime: AgentRuntime): Promise<AgentSessionInfo[]> {
    const { agent, executable } = runtime;
    if (!agent.sessions) {
      return [];
    }
    const onHost = agent.sessions.list(executable, this.project.path);
    const sandbox = agent.sessions.sandbox;
    if (!sandbox || !isSbxAgent(agent.id)) {
      return onHost;
    }
    // In parallel: the bootstrap listing, and what `logSlow` times on every reconcile.
    const [host, inSandbox] = await Promise.all([
      onHost,
      sandbox.list(executable, this.sandboxSessionRoot(agent.id), toContainerPath(this.project.path))
    ]);
    const name = sandboxName(this.project.id, agent.id);
    return [...host, ...inSandbox.map((info) => ({ ...info, sandbox: name }))];
  }

  private sandboxSessionRoot(agentId: AgentId): string {
    return sandboxSessionDir(this.agentDirOf(agentId));
  }

  private canStart(runtime: AgentRuntime): boolean {
    return runtime.startable && !runtime.prepareFailed;
  }

  private async prepareRuntime(runtime: AgentRuntime): Promise<void> {
    const { agent, executable } = runtime;
    const cwd = this.project.path;

    if (agent.versionArgs) {
      runtime.startable = await isAgentInstalled(executable, agent.versionArgs, cwd);
      // Not here, but the project's sandbox has the CLI. Only the config is read — checkSbxReady
      // talks to Docker and stays on the spawn (resolveSbxRun).
      if (!runtime.startable && isSbxAgent(agent.id) && (await readSbxConfig(cwd)).enabled) {
        runtime.startable = true;
        runtime.sbxOnly = true;
      }
    }
    if (!runtime.startable || !agent.sessions) {
      return;
    }
    // Not in bringUp: sbxConfigChanged runs that mid-session, which is no startup phase.
    await markStartup(`list ${agent.id}`, () => this.bringUp(runtime));
  }

  /** A startable agent's setup, its existing sessions as tabs, and the watch keeping them current. */
  private async bringUp(runtime: AgentRuntime): Promise<void> {
    const { agent } = runtime;
    // Before the listing, which may need it (opencode's records directory).
    if (!(await this.prepare(runtime))) {
      return;
    }

    const infos = await this.listSessions(runtime);
    // Closed while listing: the watcher started below would outlive `dispose`.
    if (this.disposed) {
      return;
    }
    // Runs again for an agent startable later (sbxConfigChanged): skip sessions already on screen,
    // reported but unclaimed, or still being deleted (as in doReconcile). A tab's id too: a restored
    // tab keeps its session's id after moving on to another (`/clear`), and ids must stay unique.
    const known = new Set([
      ...this.tabs.flatMap((tab) => [tab.tabId, tab.sessionId, tab.reportedSessionId]),
      ...this.deletingSessionIds
    ]);
    const fresh = infos.filter((candidate) => !known.has(candidate.id));
    for (const info of fresh) {
      this.tabs.push({
        tabId: info.id,
        projectId: this.project.id,
        agentId: agent.id,
        sessionId: info.id,
        title: info.title,
        updatedAt: info.updatedAt,
        createdAt: info.createdAt,
        provisionalTitle: info.provisionalTitle,
        sandbox: info.sandbox,
        status: "ready"
      });
    }
    if (fresh.length > 0) {
      this.postTabs();
    }
    // After the listing, so its first event can't race the bootstrap.
    this.startWatching(runtime);
  }

  /**
   * tet.json was written, by anyone (repository.ts's COMMANDS_FILE). Picked up now, not at the next
   * start: `addProject` opens the project before the dialog switching sandboxing on shows, and a
   * machine with no agent would sit at an empty project. Only unstartable runtimes are acted on.
   */
  async sbxConfigChanged(): Promise<void> {
    const sbxRuntimes = [...this.runtimes.values()].filter((runtime) => isSbxAgent(runtime.agent.id));
    if (this.disposed || sbxRuntimes.length === 0) {
      return;
    }
    // During bootstrap, a running version check's "not startable" is not "no executable here".
    await Promise.all(sbxRuntimes.map((runtime) => runtime.ready));
    const { enabled } = await readSbxConfig(this.project.path);
    if (this.disposed) {
      return;
    }
    const candidates = sbxRuntimes.filter((runtime) => runtime.sbxOnly || !runtime.startable);
    const brought: Promise<void>[] = [];
    for (const runtime of candidates) {
      if (enabled && !runtime.startable) {
        runtime.startable = true;
        runtime.sbxOnly = true;
        // So a tab awaiting `ready` joins this instead of starting on an unprepared runtime.
        runtime.ready = this.bringUp(runtime);
        brought.push(runtime.ready);
      } else if (!enabled && runtime.sbxOnly) {
        // Open tabs keep their session (a spawn gets resolveSbxRun's notice); new tabs show missing.
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
    // A tab opened while its agent was missing spawned nothing (`markInstalled`), and neither a fit
    // nor Restart starts a `missing` one: its session goes, and the start runs as on a first fit.
    const startable = new Set(candidates.filter((runtime) => this.canStart(runtime)).map((runtime) => runtime.agent.id));
    for (const tab of this.tabs.filter((candidate) => candidate.status === "missing" && startable.has(candidate.agentId))) {
      this.sessions.delete(tab.tabId);
      tab.status = "ready";
      this.callbacks.onStatus(this.project.id, tab.tabId, "ready");
      if (this.lastSizes.has(tab.tabId)) {
        this.startTab(tab);
      }
    }
    // Only when something became startable; otherwise a tab the user closed stays closed.
    this.openFirstAgentTab();
  }

  /**
   * Re-prepares every agent set up for another theme (AgentPaths.theme — Codex's win32 launcher
   * carries the colors). The old setup stands until replaced, so a tab spawned meanwhile gets one.
   */
  themeChanged(): void {
    const { id } = currentTheme(this.settings);
    for (const runtime of this.runtimes.values()) {
      // A setup underway counts too: it read the theme before the change.
      if ((runtime.preparation || runtime.preparing) && runtime.preparedTheme !== id) {
        void this.prepare(runtime, true);
      }
    }
  }

  /** The agent's setup, one at a time, once unless `again`. False: failed, never start the agent.
   *  `again` during a setup reruns it once that one is done. */
  private prepare(runtime: AgentRuntime, again = false): Promise<boolean> {
    if (runtime.preparing) {
      runtime.prepareAgain ||= again;
      return runtime.preparing;
    }
    runtime.preparing = this.doPrepare(runtime, again).finally(() => {
      runtime.preparing = undefined;
      if (runtime.prepareAgain) {
        runtime.prepareAgain = false;
        void this.prepare(runtime, true);
      }
    });
    return runtime.preparing;
  }

  private async doPrepare(runtime: AgentRuntime, again: boolean): Promise<boolean> {
    const { agent, executable } = runtime;
    if (this.disposed) {
      return false;
    }
    if (!agent.prepareSpawn || (runtime.preparation && !again)) {
      return !runtime.prepareFailed;
    }
    try {
      const paths = this.pathsFor(runtime);
      const preparation = await markStartup(`prepare ${agent.id}`, () =>
        agent.prepareSpawn!(executable, this.project.path, paths)
      );
      // Closed meanwhile: nothing may spawn from here on.
      if (this.disposed) {
        return false;
      }
      runtime.preparation = preparation;
      runtime.preparedTheme = paths.theme.id;
      // Nothing else clears an earlier failure.
      runtime.prepareFailed = false;
      return true;
    } catch (error) {
      console.error("[tet] spawn preparation failed:", error);
      this.callbacks.onNotice("error", `${agent.displayName} could not be started: ${String(error)}`);
      // A rerun keeps the earlier setup, which still starts the agent (themeChanged).
      runtime.prepareFailed = runtime.preparation === undefined;
      return false;
    }
  }

  private startWatching(runtime: AgentRuntime): void {
    if (runtime.stopWatching) {
      return;
    }
    runtime.stopWatching = runtime.agent.sessions?.watch?.(runtime.executable, this.project.path, () =>
      this.scheduleReconcile(runtime, WATCH_DEBOUNCE_MS)
    );
  }

  /** Whether the project still has this tab: main drops output it batched for one that closed
   *  before the batch was flushed (main.ts's flushOutput). */
  hasTab(tabId: string): boolean {
    return this.tabs.some((tab) => tab.tabId === tabId);
  }

  createTab(agentId: AgentId, sandboxOnly = false): TerminalDescriptor {
    return this.addTab(agentId, sandboxOnly ? { sandboxOnly } : {});
  }

  /**
   * A tab whose process *is* a saved command, started directly without a shell (`resolveCommand`)
   * unless it asked for one.
   */
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined {
    const shared = {
      title: command.name ?? command.command,
      command: command.command,
      // `resolve`, not `join`, so an absolute folder is left alone.
      cwd: command.cwd ? path.resolve(this.project.path, command.cwd) : undefined,
      env: command.env
    };
    if (command.shell) {
      const runArgs = getAgent("shell").runArgs?.(command.command);
      return runArgs ? this.addTab("shell", { ...shared, runArgs }) : undefined;
    }
    const [executable, ...runArgs] = splitCommand(command.command);
    if (!executable) {
      return undefined;
    }
    // Shell syntax would reach the program as arguments — `rm x && y` deletes "&&" and "y".
    const operator = [executable, ...runArgs].find((token) => SHELL_OPERATOR.test(token));
    if (operator) {
      this.callbacks.onNotice(
        "error",
        `"${command.command}" cannot run: ${operator} is shell syntax, and a saved command is ` +
          `started without one. Split it into two commands, or add "shell": true to it in tet.json.`
      );
      return undefined;
    }
    return this.addTab("shell", { ...shared, executable, runArgs });
  }

  private addTab(agentId: AgentId, extra: Partial<TabState>): TerminalDescriptor {
    const runtime = this.runtimeFor(agentId);
    newTabCounter += 1;
    const tab: TabState = {
      tabId: `new-${newTabCounter}`,
      projectId: this.project.id,
      agentId,
      title: "",
      status: this.canStart(runtime) ? "ready" : "missing",
      ...extra
    };
    this.tabs.push(tab);

    this.postTabs();
    // Starting begins with the first fit.
    return toDescriptor(tab, false);
  }

  handleResize(tabId: string, cols: number, rows: number): void {
    this.lastSizes.set(tabId, { cols, rows });
    const existing = this.sessions.get(tabId);
    if (existing) {
      existing.ensureStarted(cols, rows);
      return;
    }
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    // A failed start (`error`) waits for Restart, which reads the size kept above; retried here,
    // every resize would rerun the whole setup, sbx's checks and notice included.
    if (!tab || tab.status === "error") {
      return;
    }
    this.startTab(tab);
  }

  /**
   * A tab's first spawn: setup, sandbox, then the process at `lastSizes`, which `handleResize` and
   * `restartTab` set first.
   */
  private startTab(tab: TabState): void {
    const tabId = tab.tabId;
    // Already underway; the spawn reads the newest `lastSizes`.
    if (this.starting.has(tabId)) {
      return;
    }
    this.starting.add(tabId);
    // Released after `startSession` acquires the next one, or the bar flickers.
    this.acquireIndicator(tabId);
    const runtime = this.runtimeFor(tab.agentId);
    // A reported, unclaimed session (a fresh tab restarted right after its first prompt) is claimed
    // first so the start resumes it; otherwise the new process's report would replace it for good.
    // Before resolveSbxRun, which reads the `sandbox` the claim sets.
    const claimed = awaitsClaim(tab) ? runtime.ready.then(() => this.reconcile(runtime)) : Promise.resolve();
    void claimed
      .then(() => Promise.all([runtime.ready, this.resolveSbxRun(tab)]))
      .then(([, sbxArgs]) => {
        const dims = this.lastSizes.get(tabId);
        if (!dims || !this.tabs.includes(tab) || this.sessions.has(tabId)) {
          // Closed while the setup ran.
          return;
        }
        // Left in `error` so Restart retries: a `ready` tab gets no second fit for an unchanged
        // size (`sent` in terminal-views.ts). resolveSbxRun has said why.
        if (sbxArgs === "stranded") {
          tab.status = "error";
          this.callbacks.onStatus(this.project.id, tabId, "error");
          return;
        }
        this.startSession(tab, sbxArgs).ensureStarted(dims.cols, dims.rows);
      })
      .catch((error: unknown) => {
        this.callbacks.onNotice("error", `${getAgent(tab.agentId).displayName} could not be started: ${String(error)}`);
        // Spawned nothing; `error` offers Restart, as above.
        if (this.tabs.includes(tab) && !this.sessions.has(tabId)) {
          tab.status = "error";
          this.callbacks.onStatus(this.project.id, tabId, "error");
        }
      })
      .finally(() => {
        // A leftover entry would make every later resize return as "still starting".
        this.starting.delete(tabId);
        this.releaseIndicator(tabId);
      });
  }

  /**
   * The `sbx run` arguments if this tab runs in the project's sandbox; tet.json is read fresh per
   * spawn. Only plain tabs of sbx agents (isSbxAgent), never a saved command's.
   *
   * A session runs where it lives: a host session fails to resume in a sandbox ("No conversation
   * found with session ID: …", measured). A tab with no `sessionId` yet is sandboxed.
   *
   * Sbx not ready starts nothing and says so, leaving `error` for Restart: a sandboxing project
   * never runs an agent on this machine behind the user's back (past an organization's policy).
   * Nor is `enabled: false` written back: `sbx ls` fails the same way while the daemon restarts.
   * And never `sbx run` regardless: it prints its interactive sign-in and policy setup (measured).
   *
   * Null runs the tab on this machine; "stranded" runs it nowhere, its notice already said.
   */
  private async resolveSbxRun(tab: TabState): Promise<string[] | null | "stranded"> {
    if (tab.executable || !isSbxAgent(tab.agentId)) {
      return null;
    }
    const config = await readSbxConfig(this.project.path);
    if (!config.enabled) {
      // A notice only for a tab that cannot run on this machine.
      return this.sbxStranded(tab, "sandboxing is switched off for the project") ? "stranded" : null;
    }
    const sandbox = sandboxName(this.project.id, tab.agentId);
    // Started before it is known whether it may be used, since it is the slowest step and the
    // readiness check answers nothing it depends on (why that is safe: ensureRunning). Not for a
    // tab about to run on this machine, which would start a sandbox nobody asked for.
    const warm = tab.sessionId && !tab.sandbox ? undefined : ensureRunning(sandbox);
    const ready = await checkSbxReady(this.project.path, this.project.id);
    if ("notReady" in ready) {
      if (!this.sbxStranded(tab, ready.notReady)) {
        this.callbacks.onNotice(
          "warning",
          `SBX is not available for ${this.project.name}: ${ready.notReady}. The tab does not start on this machine instead; the tab menu's Restart tries again once that has changed.`
        );
      }
      return "stranded";
    }
    const runtime = this.runtimeFor(tab.agentId);
    const { agent } = runtime;
    if (tab.sessionId && !tab.sandbox) {
      if (tab.sandboxOnly) {
        this.sbxStranded(tab, "its session was found on this machine");
        return "stranded";
      }
      // A host session resumes only on the host, gone for an sbx-only agent. Not `sbxStranded`,
      // whose "Restart tries again" could never come true here.
      if (runtime.sbxOnly) {
        this.callbacks.onNotice(
          "warning",
          `${agent.displayName} is not installed on this machine any more, and a session made here cannot be resumed in ${this.project.name}'s SBX sandbox. A new tab runs in the sandbox; this one cannot.`
        );
        return "stranded";
      }
      if (!this.sbxPreexistingSaid) {
        this.sbxPreexistingSaid = true;
        this.callbacks.onNotice(
          "info",
          `${agent.displayName} tabs from before SBX was enabled for ${this.project.name} keep running on this machine; only new tabs run in its sandbox.`
        );
      }
      return null;
    }
    const paths = this.pathsFor(runtime);
    const hooks = agent.prepareSandboxSpawn?.(this.project.path, paths, sandbox) ?? { args: [] };
    const sessionRoot = this.sandboxSessionRoot(tab.agentId);
    const { args, missing, missingSecrets } = await prepareSbxRun({
      agentId: tab.agentId,
      projectId: this.project.id,
      projectPath: this.project.path,
      config,
      sandboxes: ready.sandboxes,
      warm,
      paths,
      agentArgs: [...hooks.args, ...resumeArgsOf(tab, agent), ...(tab.runArgs ?? [])],
      env: [...(agent.sandboxEnv ?? []), ...Object.entries(hooks.env ?? {}).map(([key, value]) => `${key}=${value}`)],
      sessionMounts: (agent.sessions?.sandbox?.mounts ?? []).map((mount) => ({
        host: path.join(sessionRoot, mount.sub),
        target: mount.target,
        file: mount.file
      })),
      secretValues: this.secrets.values(this.project.id),
      onData: (data) => this.reportOutput(tab, data)
    });
    if (missing.length > 0) {
      this.callbacks.onNotice(
        "warning",
        `${agent.displayName} in ${this.project.name} starts without ${missing.length === 1 ? "an allowed path that does not exist" : "allowed paths that do not exist"} on this machine: ${missing.join(", ")}`
      );
    }
    if (missingSecrets.length > 0) {
      this.callbacks.onNotice(
        "warning",
        `${agent.displayName} in ${this.project.name} starts without ${missingSecrets.length === 1 ? "a secret that has no value" : "secrets that have no value"} on this machine: ${missingSecrets.join(", ")}. Enter ${missingSecrets.length === 1 ? "it" : "them"} in the project's SBX Settings.`
      );
    }
    return args;
  }

  /**
   * The notice for a tab that cannot run on this machine — its session lives in the sandbox, or
   * the agent is sbx-only (AgentRuntime.sbxOnly). Returns whether it applied, so the caller skips
   * its own. Per tab, not per project: it is about the tab just opened.
   */
  private sbxStranded(tab: TabState, reason: string): boolean {
    const { agent, sbxOnly } = this.runtimeFor(tab.agentId);
    if (!tab.sandbox && !sbxOnly && !tab.sandboxOnly) {
      return false;
    }
    const what = tab.sandbox
      ? `This ${agent.displayName} session lives in ${this.project.name}'s SBX sandbox and cannot run on this machine`
      : tab.sandboxOnly
        ? `This ${agent.displayName} tab was opened from ${this.project.name}'s SBX sandbox and cannot run on this machine`
        : `${agent.displayName} is not installed on this machine and only runs in ${this.project.name}'s SBX sandbox`;
    this.callbacks.onNotice(
      "warning",
      `${what}: ${reason}. The tab menu's Restart tries again once that has changed.`
    );
    return true;
  }

  /**
   * A closed tab's session keeps printing while it quits (closeTabs lists the tab as gone first);
   * that output reaches nobody, or it would be recorded again after keepOutputs dropped it.
   */
  private reportOutput(tab: TabState, data: string): void {
    if (this.tabs.includes(tab)) {
      this.callbacks.onOutput(this.project.id, tab.tabId, data);
    }
  }

  private startSession(tab: TabState, sbxArgs: string[] | null): TerminalSession {
    const runtime = this.runtimeFor(tab.agentId);
    const { agent, executable, preparation } = runtime;
    const tabId = tab.tabId;

    // Fresh per session, counting from zero.
    let isSessionReady = agent.createIsSessionReady?.();
    if (isSessionReady) {
      this.acquireIndicator(tabId);
    }
    const hideIndicator = (): void => {
      if (!isSessionReady) {
        return;
      }
      // Cleared before the delay, so a second call can't queue a second release.
      isSessionReady = undefined;
      setTimeout(() => this.releaseIndicator(tabId), INDICATOR_LINGER_MS);
    };

    // The preparation's host-only executable/args/env apply to neither a saved command nor a
    // sandboxed tab, whose `sbxArgs` is the full `sbx run` line, resumeArgs included.
    const args = tab.executable
      ? (tab.runArgs ?? [])
      : (sbxArgs ?? [...(preparation?.args ?? []), ...resumeArgsOf(tab, agent), ...(tab.runArgs ?? [])]);

    const session = new TerminalSession(
      sbxArgs ? "sbx" : (tab.executable ?? preparation?.executable ?? executable),
      tab.cwd ?? this.project.path,
      sbxArgs ? undefined : preparation?.env,
      {
        onOutput: (data) => {
          this.reportOutput(tab, data);
          if (isSessionReady?.(data)) {
            hideIndicator();
          }
          // A CLI persists or updates its session shortly after producing output.
          this.scheduleReconcile(runtime);
        },
        onStatusChange: (status) => {
          tab.status = status;
          this.callbacks.onStatus(this.project.id, tabId, status);
          if (status === "stopped" || status === "error" || status === "missing") {
            this.scheduleReconcile(runtime);
            // A CLI killed mid-turn never reports its end.
            if (tab.busy || tab.waitingAt !== undefined) {
              tab.busy = false;
              tab.waitingAt = undefined;
              this.postTabs();
            }
            // The CLI may exit before looking ready, and `markInstalled`'s "missing" spawns nothing.
            hideIndicator();
          }
        }
      },
      agent.quitPresses ?? 0,
      args,
      tab.env,
      // What `tet-ctl` in this tab reports as its caller — see src/shared/control.ts.
      {
        env: { [CONTROL_ENV.projectId]: this.project.id, [CONTROL_ENV.tabId]: tabId },
        sandboxed: sbxArgs !== null
      }
    );

    this.sessions.set(tabId, session);
    session.markInstalled(this.canStart(runtime));
    return session;
  }

  write(tabId: string, data: string): void {
    // The only "answered" signal: typing into the asking tab. Cleared before forwarding.
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (tab?.waitingAt !== undefined && answersQuestion(data)) {
      tab.waitingAt = undefined;
      this.postTabs();
    }
    if (tab && !tab.sessionId && tab.reportedSessionId === undefined && data.includes("\r")) {
      tab.submittedAt = Date.now();
    }
    this.sessions.get(tabId)?.write(data);
  }

  /**
   * See AgentDefinition.resolveUrlPrefix. Undefined when it can't be answered, which the renderer
   * caches as "don't ask again".
   */
  async resolveUrlPrefix(tabId: string, prefix: string): Promise<string | undefined> {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab?.sessionId) {
      return undefined;
    }
    const { agent, executable } = this.runtimeFor(tab.agentId);
    if (!agent.resolveUrlPrefix) {
      return undefined;
    }
    try {
      return await agent.resolveUrlPrefix(executable, this.project.path, tab.sessionId, prefix);
    } catch {
      return undefined;
    }
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
      if (getAgent(tab.agentId).sessions && (!tab.sessionId || awaitsClaim(tab)) && this.sessions.has(tab.tabId)) {
        this.detachedTabs.push(tab);
      }
    }
    // All stops start before any is awaited: each takes a grace period (TerminalSession.stop).
    const stops = new Map(
      tabs.map((tab) => {
        const session = this.sessions.get(tab.tabId);
        return [tab.tabId, this.reportBeforeQuit(tab).then(() => session?.stop())] as const;
      })
    );
    for (const tab of tabs) {
      await this.destroyTab(tab, indices.get(tab.tabId) ?? this.tabs.length, stops.get(tab.tabId));
    }
  }

  /**
   * For a tab closed right after its first prompt, resolves once it named its session (bounded).
   * Codex takes the quitting Ctrl+C as an abort of a still-running `UserPromptSubmit` hook
   * (measured), and its hooks are the only reports naming the session, which would then come back
   * as a tab of its own.
   */
  private reportBeforeQuit(tab: TabState): Promise<void> {
    const waited = tab.submittedAt === undefined ? 0 : Date.now() - tab.submittedAt;
    if (tab.sessionId || tab.reportedSessionId !== undefined || tab.submittedAt === undefined || waited >= REPORT_WAIT_MS) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.reportWaiters.delete(tab.tabId);
        resolve();
      };
      const timer = setTimeout(done, REPORT_WAIT_MS - waited);
      this.reportWaiters.set(tab.tabId, done);
    });
  }

  /**
   * Deletes a removed tab's persisted session; `index` puts the tab back if that fails. `stopped`
   * is the stop closeTabs started.
   */
  private async destroyTab(tab: TabState, index: number, stopped: Promise<void> | undefined): Promise<void> {
    const session = this.sessions.get(tab.tabId);
    this.lastSizes.delete(tab.tabId);
    const runtime = this.runtimeFor(tab.agentId);
    const { agent, executable } = runtime;
    const detached = this.detachedTabs.includes(tab);
    try {
      if (session) {
        // Delete only once the process is gone. Still listed while reportBeforeQuit holds the quit,
        // so a dispose meanwhile stops it.
        await stopped;
        this.sessions.delete(tab.tabId);
      }
      if (!agent.sessions) {
        return;
      }
      if (detached && awaitsClaim(tab)) {
        // A reconcile underway listed before the session was named; then run one that sees it.
        await runtime.reconciling;
        await this.reconcile(runtime);
      }
    } finally {
      if (detached) {
        this.detachedTabs.splice(this.detachedTabs.indexOf(tab), 1);
      }
    }
    const sessionId = tab.sessionId;
    if (!sessionId) {
      return;
    }
    this.deletingSessionIds.add(sessionId);
    try {
      if (session) {
        await new Promise((resolve) => setTimeout(resolve, SESSION_REMOVE_DELAY_MS));
      }
      const sandbox = tab.sandbox ? agent.sessions.sandbox : undefined;
      if (sandbox) {
        await sandbox.remove(executable, this.sandboxSessionRoot(agent.id), toContainerPath(this.project.path), sessionId);
      } else {
        await agent.sessions.remove(executable, this.project.path, sessionId);
      }
    } catch (error) {
      this.callbacks.onNotice("error", `Could not delete ${agent.displayName} session: ${String(error)}`);
      tab.status = "ready";
      this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
      this.postTabs();
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  /** Without a sessionId nothing is renamed, and the renderer's optimistic label reverts. */
  async renameTab(tabId: string, title: string): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) {
      return;
    }
    const { agent, executable } = this.runtimeFor(tab.agentId);
    if (!tab.sessionId || !agent.sessions) {
      this.postTabs();
      return;
    }
    const previousTitle = tab.title;
    try {
      const sandbox = tab.sandbox ? agent.sessions.sandbox : undefined;
      if (sandbox) {
        await sandbox.rename(executable, this.sandboxSessionRoot(agent.id), toContainerPath(this.project.path), tab.sessionId, title);
      } else {
        await agent.sessions.rename(executable, this.project.path, tab.sessionId, title);
      }
      tab.title = title.trim();
      // A name the user picked is final.
      tab.provisionalTitle = false;
    } catch (error) {
      this.callbacks.onNotice("error", `Could not rename ${agent.displayName} session: ${String(error)}`);
      tab.title = previousTitle;
    }
    this.postTabs();
  }

  /**
   * A saved command respawns in place (`TerminalSession.restart`). An agent tab with no process
   * (`stopped`, or `error` incl. a start that gave up) takes the whole start path: mounts do not
   * survive a sandbox stop, so checks, sandbox and mounts are redone and the session resumed. A tab
   * not fitted yet waits for its first fit. False where there was nothing to restart.
   */
  restartTab(tabId: string): boolean {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) {
      return false;
    }
    if (isSavedCommandTab(tab)) {
      const session = this.sessions.get(tabId);
      session?.restart();
      return session !== undefined;
    }
    if (!this.lastSizes.has(tabId) || (tab.status !== "stopped" && tab.status !== "error")) {
      return false;
    }
    // `startTab` gives up on a tab that already has a session.
    this.sessions.delete(tabId);
    // The status stays until the new process reports, so a start giving up again offers Restart.
    this.startTab(tab);
    return true;
  }

  /**
   * A tab's hook report — the only way turns reach tet ("Both ends of a turn" in AGENTS.md).
   * Addressed by tab (`TET_TAB_ID` in the hook's environment, passed into a sandbox by
   * prepareSbxRun), so no turn is reported for a session no tab has claimed.
   *
   * Answers the agent's stdout and the toast, composed here so settings are read at the event, not
   * baked in at setup. Showing a mark is the renderer's call; no toast for a tab in front
   * (`setInFront`).
   */
  hookEvent(tabId: string, event: HookEvent, payload: string, reportedAt: number | undefined): HookOutcome {
    const tab = this.disposed ? undefined : this.tabs.find((candidate) => candidate.tabId === tabId);
    // A tab closed right after its first prompt still needs its session named, to delete it.
    const bound = tab ?? this.detachedTabs.find((candidate) => candidate.tabId === tabId);
    const sessionId = bound ? getAgent(bound.agentId).sessionIdOf?.(payload) : undefined;
    this.record({ tabId, kind: "hook", event, reportedAt, sessionId });
    // When the hook *fired*, not arrived: two hooks of a turn race (~100 ms each out of a sandbox,
    // events ms apart), and arrival order leaves a tab finished and working. One tab, one clock.
    const at = typeof reportedAt === "number" && Number.isFinite(reportedAt) && reportedAt > 0 ? reportedAt : Date.now();
    if (bound && sessionId) {
      this.bindReportedSession(bound, sessionId, at);
    }
    if (!tab) {
      return {};
    }
    // A stale report gets no mark and no toast, which would contradict the marks — "Finished" over
    // a tab working again (turn-order.ts).
    const fresh = reportApplies(tab.signalAt, at);
    switch (event) {
      case "session-start":
        // Only names the session (above). Codex fires it with the first prompt (measured), whose
        // turn prompt-submit marks.
        return {};
      case "prompt-submit":
        if (fresh) {
          setTurn(tab, true, at);
          this.postTabs();
        }
        // No context for the model: TET's system prompt went in once per session (system-prompt.ts).
        return {};
      case "stop": {
        const agent = getAgent(tab.agentId);
        // Only the agent's payload knows whether the turn is really over.
        if (agent.holdsTurnEnd?.(payload)) {
          return {};
        }
        if (!fresh) {
          return {};
        }
        // Read before setTurn, which may clear it.
        const asked = endLeavesQuestion(tab, agent);
        setTurn(tab, false, at, asked);
        this.postTabs();
        // The question already toasted this moment (see setTurn).
        return asked ? {} : { toast: this.toast(tab, "finished") };
      }
      case "permission":
      case "question":
        if (!fresh) {
          return {};
        }
        // Not through setTurn: the turn is still open, `busy` is untouched.
        tab.waitingAt = at;
        tab.signalAt = at;
        this.postTabs();
        return { toast: this.toast(tab, event) };
      case "idle":
        // About a turn already ended — nothing to mark. Its hook exists only while the switch is on
        // (AgentPaths.idleReminder), rather than a process per idle prompt answered with nothing.
        return fresh ? { toast: this.toast(tab, "idle") } : {};
    }
  }

  /**
   * Records the session a report names, for a tab with none or one that moved on (`/clear`, `/new`,
   * `/resume`; measured for Claude Code's `/clear`). Whatever the turn marks' age (`signalAt`), but
   * ordered against the reports naming sessions (turn-order.ts): a late hook of the session left
   * behind would take it back. Reconcile claims it once listed; the session left behind becomes its
   * own tab next start.
   */
  private bindReportedSession(tab: TabState, reported: string, at: number): void {
    if (!reportApplies(tab.sessionReportAt, at)) {
      return;
    }
    tab.sessionReportAt = at;
    if (reported === tab.reportedSessionId) {
      return;
    }
    tab.reportedSessionId = reported;
    this.reportWaiters.get(tab.tabId)?.();
    if (awaitsClaim(tab)) {
      this.scheduleReconcile(this.runtimeFor(tab.agentId));
    }
  }

  /** Settings read now, so a switch applies to the next turn of every open project. */
  private toast(tab: TabState, kind: "finished" | "permission" | "question" | "idle"): HookToast | undefined {
    // As with the marks: a tab in front was never out of sight.
    if (this.inFront.has(tab.tabId)) {
      return undefined;
    }
    const { notifications } = this.settings.get();
    const wanted =
      kind === "finished" ? notifications.finished : kind === "idle" ? notifications.idleReminder : notifications.needsYou;
    if (!wanted) {
      return undefined;
    }
    const name = getAgent(tab.agentId).displayName;
    // The tab's title too, or two tabs of one agent would toast identically.
    const repository = path.basename(this.project.path);
    const where = tab.title ? `${repository} — ${tab.title}` : repository;
    switch (kind) {
      case "finished":
        return { title: `${name}: Finished`, body: `Finished in ${where}` };
      case "permission":
        return { title: `${name}: Action needed`, body: `Waiting for input in ${where}` };
      case "question":
        return { title: `${name}: Question`, body: `Waiting for your answer in ${where}` };
      case "idle":
        return { title: `${name}: Still waiting`, body: `No response yet in ${where}` };
    }
  }

  /**
   * A tab in front has its finished turn seen. A question stays: it ends with an answer (`write`)
   * or the turn (setTurn).
   */
  markSeen(tabId: string): void {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab || tab.finishedAt === undefined) {
      return;
    }
    tab.finishedAt = undefined;
    this.postTabs();
  }

  /** Tabs on screen in a focused, uncovered window, as only the renderer knows — no toast there. */
  setInFront(tabIds: readonly string[]): void {
    this.inFront = new Set(tabIds);
  }

  private scheduleReconcile(runtime: AgentRuntime, delayMs = RECONCILE_DEBOUNCE_MS): void {
    // Runs on every output chunk.
    if (!runtime.agent.sessions) {
      return;
    }
    runtime.reconcileRetriesLeft = RECONCILE_MAX_RETRIES;
    // Only an unsettled label caps the debounce; otherwise listings stay out of a turn. Not
    // `tabsOf`, which allocates per output chunk.
    if (
      runtime.reconcileDeadline === undefined &&
      this.tabs.some((tab) => tab.agentId === runtime.agent.id && titleUnsettled(tab))
    ) {
      runtime.reconcileDeadline = Date.now() + RECONCILE_MAX_WAIT_MS;
    }
    this.armReconcileTimer(runtime, delayMs);
  }

  private armReconcileTimer(runtime: AgentRuntime, delayMs: number): void {
    // The retry re-arms after every run; a reconcile in flight at close must not re-arm.
    if (this.disposed) {
      return;
    }
    clearTimeout(runtime.reconcileTimer);
    const cappedDelay =
      runtime.reconcileDeadline === undefined
        ? delayMs
        : Math.min(delayMs, Math.max(0, runtime.reconcileDeadline - Date.now()));
    runtime.reconcileTimer = setTimeout(() => {
      runtime.reconcileDeadline = undefined;
      void this.reconcile(runtime).then(() => {
        if (runtime.reconcileRetriesLeft > 0) {
          runtime.reconcileRetriesLeft -= 1;
          this.armReconcileTimer(runtime, RECONCILE_RETRY_MS);
        }
      });
    }, cappedDelay);
  }

  private tabsOf(runtime: AgentRuntime): TabState[] {
    return this.tabs.filter((tab) => tab.agentId === runtime.agent.id);
  }

  /** Re-lists one agent's sessions to claim reported sessions and refresh known tabs. */
  private reconcile(runtime: AgentRuntime): Promise<void> {
    // Serialized: a call while one is in flight joins it.
    runtime.reconciling ??= this.doReconcile(runtime).finally(() => {
      runtime.reconciling = undefined;
    });
    return runtime.reconciling;
  }

  private async doReconcile(runtime: AgentRuntime): Promise<void> {
    countActivity("reconcile");
    const { agent } = runtime;
    if (this.disposed || !agent.sessions || !this.canStart(runtime)) {
      return;
    }
    // Wall time; for local transcript files a slow listing is the per-line JSON.parse.
    const listStart = performance.now();
    const infos = await this.listSessions(runtime);
    logSlow("reconcile", performance.now() - listStart);
    const ownTabs = this.tabsOf(runtime);
    const claimed = new Set([
      ...ownTabs.map((tab) => tab.sessionId).filter((id) => id !== undefined),
      ...this.deletingSessionIds
    ]);
    let changed = false;

    // Each tab takes the session its hooks named (bindReportedSession), once listed.
    const pendingTabs = [...ownTabs, ...this.detachedTabs.filter((tab) => tab.agentId === agent.id)].filter(awaitsClaim);
    for (const tab of pendingTabs) {
      const match = infos.find((info) => info.id === tab.reportedSessionId && !claimed.has(info.id));
      if (!match) {
        continue;
      }
      claimed.add(match.id);
      this.record({ tabId: tab.tabId, kind: "claimed", sessionId: match.id });
      tab.sessionId = match.id;
      tab.title = match.title;
      tab.updatedAt = match.updatedAt;
      tab.createdAt = match.createdAt;
      tab.provisionalTitle = match.provisionalTitle;
      tab.sandbox = match.sandbox;
      // A detached tab is gone from the UI; claiming its id is all that's needed.
      changed ||= this.tabs.includes(tab);
    }

    for (const tab of ownTabs) {
      if (!tab.sessionId) {
        continue;
      }
      const info = infos.find((candidate) => candidate.id === tab.sessionId);
      if (!info) {
        continue;
      }
      // Even with an unchanged label: a name equal to the stand-in still ends polling.
      tab.provisionalTitle = info.provisionalTitle;
      // No Stop hook fires for a turn the user cut short; the transcript has the end. Only a
      // later end than the turn's start counts, and it leaves no mark — the user was in that tab.
      if (tab.busy && info.turnEndedAt !== undefined && info.turnEndedAt > (tab.busySince ?? 0)) {
        tab.busy = false;
        // A question can only stand within a turn, as in setTurn.
        tab.waitingAt = undefined;
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
    // See armReconcileTimer.
    this.disposed = true;
    // A start still underway spawns only if its tab is still known.
    this.tabs = [];
    this.starting.clear();
    this.lastSizes.clear();
    this.tabIndicators.clear();
    this.indicators = 0;
    for (const runtime of this.runtimes.values()) {
      clearTimeout(runtime.reconcileTimer);
      runtime.stopWatching?.();
      runtime.stopWatching = undefined;
    }
    // All at once: each may take a grace period (TerminalSession.stop), and quit waits on this.
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    this.sessions.clear();
    for (const runtime of this.runtimes.values()) {
      runtime.preparation = undefined;
    }
  }
}

/** The open projects' session managers. */
export class SessionManagerRegistry {
  private readonly managers = new Map<string, ProjectSessionManager>();

  /** The renderer's last report, sent only on change — for a project opened after it. */
  private inFront: { projectId: string | null; tabIds: readonly string[] } = { projectId: null, tabIds: [] };

  constructor(
    private readonly storageRoot: string,
    private readonly settings: SettingsStore,
    private readonly secrets: SbxSecretStore,
    private readonly callbacks: SessionManagerCallbacks
  ) {}

  open(project: Project): ProjectSessionManager {
    const existing = this.managers.get(project.id);
    if (existing) {
      return existing;
    }
    const manager = new ProjectSessionManager(project, this.storageRoot, this.settings, this.secrets, this.callbacks);
    manager.setInFront(project.id === this.inFront.projectId ? this.inFront.tabIds : []);
    this.managers.set(project.id, manager);
    manager.bootstrap().catch((error: unknown) => {
      this.callbacks.onNotice("error", `${project.name} could not be opened: ${String(error)}`);
    });
    return manager;
  }

  get(projectId: string): ProjectSessionManager | undefined {
    return this.managers.get(projectId);
  }


  /** The tabs in front belong to one project at most. */
  setInFront(projectId: string | null, tabIds: readonly string[]): void {
    this.inFront = { projectId, tabIds };
    for (const [id, manager] of this.managers) {
      manager.setInFront(id === projectId ? tabIds : []);
    }
  }

  /** See ProjectSessionManager.themeChanged. */
  themeChanged(): void {
    for (const manager of this.managers.values()) {
      manager.themeChanged();
    }
  }

  async close(projectId: string): Promise<void> {
    const manager = this.managers.get(projectId);
    // Dropped before the wait, so a project removed and reopened at once never has two.
    this.managers.delete(projectId);
    await manager?.dispose();
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.dispose()));
    this.managers.clear();
  }
}
