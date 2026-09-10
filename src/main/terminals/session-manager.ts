import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, getAgent } from "../agents";

import type { AgentDefinition, AgentPaths, AgentSessionInfo, SpawnPreparation } from "../agents/agent";
import { splitCommand } from "../../shared/command";
import { CONTROL_ENV } from "../../shared/control";
import type { HookEvent } from "../../shared/control";
import type { HookOutcome, HookToast } from "../control/control-server";
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
import { checkSbxReady, prepareSbxRun, sandboxName } from "../sbx";
import type { SettingsStore } from "../settings";
import { ShellContext } from "./shell-context";
import { isAgentInstalled, TerminalSession } from "./terminal-session";
import { sandboxSessionDir, toContainerPath } from "./hook-target";
import { reportApplies } from "./turn-order";
import { currentTheme } from "../theme";

const RECONCILE_DEBOUNCE_MS = 5000;
// A CLI can persist a generated title well after its output went idle: retry a few times.
const RECONCILE_RETRY_MS = 5000;
const RECONCILE_MAX_RETRIES = 3;
// A busy CLI redraws continuously and would push the debounce out for the whole turn; caps
// how far output can push it while a tab's session or title is still unknown.
const RECONCILE_MAX_WAIT_MS = 10000;
// A watcher event is the change itself; only the handful of events per write need collapsing.
const WATCH_DEBOUNCE_MS = 300;
// A killed CLI gets a moment to die before its transcript is removed, so a final in-flight
// write can't resurrect the deleted file.
const SESSION_REMOVE_DELAY_MS = 500;
// Readiness fires on the CLI's first full frame, a moment before the terminal looks settled.
const INDICATOR_LINGER_MS = 700;
/**
 * A token that only means anything to a shell; a saved command is started without one, so it is
 * refused with a message. Whole tokens only — `2>&1` and `>>` match, an argument holding a `>`
 * does not.
 */
const SHELL_OPERATOR = /^(?:&&|\|\||[|;&]|\d*>>?|\d*>&\d*|<)$/;

interface TabState extends TerminalDescriptor {
  /** When this tab's pty was spawned — used to claim newly persisted sessions. */
  spawnedAt?: number;
  /** Mirrors AgentSessionInfo.provisionalTitle for this tab's session. */
  provisionalTitle?: boolean;
  /** Mirrors AgentSessionInfo.sandbox: the sbx sandbox this tab's session lives in, if any. */
  sandbox?: string;
  /** When the running turn was reported as started — what a turn end is dated against. */
  busySince?: number;
  /**
   * When the latest turn signal applied here arrived. Two of an agent's hooks can be in flight
   * at once (a question raised moments before the turn ends), and each is a process of its own
   * racing the other to the channel; anything older than the last applied signal is dropped.
   */
  signalAt?: number;
  /** The program a saved command runs, when that is not this agent's own executable. */
  executable?: string;
  /** A saved command's arguments — its own program's, or a shell's when it asked for one. */
  runArgs?: string[];
  /** Where its process runs, when that is not the project root — a command's own folder. */
  cwd?: string;
  /** A saved command's own environment variables, which outrank the machine's. */
  env?: Record<string, string>;
}

/** Per-agent state within one project: its executable, its setup, its reconcile loop. */
interface AgentRuntime {
  agent: AgentDefinition;
  executable: string;
  /** Whether this agent can be started here at all — the host executable, or the project's own
   *  sandbox standing in for it (see sbxOnly). Not "is it installed": an sbx-only agent is
   *  startable with nothing on this machine. */
  startable: boolean;
  /**
   * No host executable: this agent is startable only because the project sends it into its sbx
   * sandbox, so there is nothing to fall back to when the sandbox cannot be reached. Decided once
   * here, with the project's config; whether the sandbox is *reachable* stays resolveSbxRun's
   * question, asked per spawn.
   */
  sbxOnly: boolean;
  /** Resolves once the agent's version check, spawn preparation and initial listing are done. */
  ready: Promise<void>;
  preparation?: SpawnPreparation;
  prepareFailed: boolean;
  /** One setup at a time: two tabs opened at once must not write the same setup twice. */
  preparing?: Promise<boolean>;
  stopWatching?: () => void;
  reconciling?: Promise<void>;
  reconcileTimer?: ReturnType<typeof setTimeout>;
  reconcileRetriesLeft: number;
  /** Latest point in time the debounced reconcile may be pushed to; unset once it fires. */
  reconcileDeadline?: number;
}

export interface SessionManagerCallbacks {
  onTabs: (projectId: string, tabs: TerminalDescriptor[]) => void;
  onOutput: (projectId: string, tabId: string, data: string) => void;
  onStatus: (projectId: string, tabId: string, status: TerminalStatus) => void;
  /** Whether anything in this project is still starting up — drives the tab strip's bar. */
  onStartupProgress: (projectId: string, show: boolean) => void;
  /** Surfaces a failure the user should see (a session that could not be renamed or deleted). */
  onNotice: (severity: NoticeSeverity, message: string) => void;
}

/** Nothing about this tab's label is settled yet: no session claimed, no title, or only a
 * stand-in the agent may still replace with a name of its own. */
function titleUnsettled(tab: TabState): boolean {
  return !tab.sessionId || !tab.title || tab.provisionalTitle === true;
}

/**
 * A turn started or ended: the spinner follows, and an end leaves the mark that outlives it.
 * Either end clears `waitingAt` — a question stands open within its turn, and a new turn is a
 * new question — unless the agent's questions outlive their turn (`keepQuestion`, see
 * AgentDefinition.questionOutlivesTurn). No agent reports that a question was answered, so a
 * permission granted mid-turn leaves the mark until the tab is looked at.
 */
function setTurn(tab: TabState, busy: boolean, at: number, keepQuestion = false): void {
  tab.busy = busy;
  if (!keepQuestion) {
    tab.waitingAt = undefined;
  }
  tab.signalAt = at;
  if (busy) {
    tab.busySince = at;
  } else {
    tab.finishedAt = at;
  }
}

/**
 * Whether one chunk of terminal input can be the answer to a standing question — see `write`.
 * Enter, any printable character (Claude Code's permission prompt takes the option's digit with
 * no Enter) and a mouse click (an SGR press sequence, `ESC [ < button ; x ; y M`, since the TUIs
 * turn mouse tracking on). Left out: arrow keys, Tab, Shift+Tab, a bare Escape, mouse motion
 * (bit 32 in the button code) and the wheel (64 and up). Generous otherwise: a mark dropped a
 * keystroke early is on a tab the user is typing into, which hides it regardless.
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
  // Escape sequences (arrows, function keys, a bare ESC) all start with ESC and are not answers.
  if (data.startsWith("\x1b")) {
    return false;
  }
  return /\S/.test(data);
}

/** `starting` is not the tab's own: it is read off `tabIndicators` by the caller — see there. */
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

/** Either field is set only for a tab created by `createCommandTab`. */
function isSavedCommandTab(tab: TabState): boolean {
  return tab.executable !== undefined || tab.runArgs !== undefined;
}

/**
 * One project's terminal tabs. Tabs mirror the agents' persisted sessions: every session
 * found when the project opens becomes a tab, and closing a tab deletes its session.
 */
export class ProjectSessionManager {
  private tabs: TabState[] = [];
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly runtimes = new Map<AgentId, AgentRuntime>();
  /** Tabs whose session is being constructed; a second resize must not start a second one. */
  private readonly starting = new Set<string>();
  /**
   * The last size the renderer fitted each tab to, and the size every spawn uses. A restart
   * happens later than the fit, and none follows it — the element is already laid out.
   */
  private readonly lastSizes = new Map<string, { cols: number; rows: number }>();
  /** Session ids whose removal is still in flight — reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs already removed from the UI that still need their persisted session claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];
  private newTabCounter = 0;
  /** The project was closed; nothing that was still in flight may start anything back up. */
  private disposed = false;
  /** Said once per project, not once per tab — see resolveSbxRun's own-session-id fallback. */
  private sbxPreexistingSaid = false;
  /** How many things in this project are still starting; the bar stays up while any is. */
  private indicators = 0;
  /**
   * How many of those belong to which tab (`TerminalDescriptor.starting`). A count, not a flag:
   * a tab's setup and its CLI's first frame overlap, and a release for a closed tab must still
   * balance its acquire — `closeTabs` can put a tab back after a failed delete.
   */
  private readonly tabIndicators = new Map<string, number>();

  private readonly shellContext: ShellContext;

  constructor(
    private readonly project: Project,
    private readonly storageRoot: string,
    private readonly settings: SettingsStore,
    private readonly callbacks: SessionManagerCallbacks
  ) {
    this.shellContext = new ShellContext(path.join(storageRoot, "projects", project.id), project.name);
  }

  /** This agent's own scratch directory for this repository — see AgentPaths.agentDir. */
  private agentDirOf(agentId: AgentId): string {
    return path.join(this.storageRoot, "agents", agentId, this.project.id);
  }

  /** Where one agent may set itself up for this repository — see AgentDefinition.prepareSpawn. */
  private pathsFor(runtime: AgentRuntime): AgentPaths {
    const agentDir = this.agentDirOf(runtime.agent.id);
    fs.mkdirSync(agentDir, { recursive: true });
    return {
      agentDir,
      contextFile: this.shellContext.contextFile,
      contextReadPaths: [this.shellContext.logFile],
      storageRoot: this.storageRoot,
      idleReminder: this.settings.get().notifications.idleReminder,
      theme: currentTheme(this.settings)
    };
  }

  snapshot(): TerminalDescriptor[] {
    return this.tabs.map((tab) => toDescriptor(tab, this.tabIndicators.has(tab.tabId)));
  }

  private postTabs(): void {
    // Not after the project is gone: a late post would revive the project in the renderer.
    if (this.disposed) {
      return;
    }
    this.callbacks.onTabs(this.project.id, this.snapshot());
  }

  /**
   * The current value of what onStartupProgress reports: a bootstrap at app start runs before
   * the window exists, so its "show" never reaches a renderer.
   */
  isStarting(): boolean {
    return this.indicators > 0;
  }

  /**
   * `tabId` lets the pane that tab lives in show the bar itself; `bootstrap` has none and is a
   * project-wide reason pane "a" falls back to. Every acquire needs one release with the same
   * `tabId`.
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
    // Covers the version checks and session listings, which take long enough to show.
    this.acquireIndicator();
    try {
      await Promise.all(AGENTS.map((agent) => this.runtimeFor(agent.id).ready));
      this.openFirstAgentTab();
    } finally {
      this.releaseIndicator();
    }
  }

  /**
   * A project that restored no session opens with one agent tab: the first installed agent in
   * registration order that has sessions (so never the shell). Nothing is spawned — the pane's
   * first resize starts the CLI, and a never-used tab persists nothing, so this runs again next
   * start.
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
   * Every session of this repository for one agent: the host's, and the sandbox's through its
   * mount (SessionProvider.sandbox), the latter named after the sandbox so resolveSbxRun can
   * send them back there. The sandbox side is listed regardless of the project's switch: a
   * session that ran there stays resumable there, and an empty directory costs one readdir.
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
    // In parallel: this is the bootstrap listing and what `logSlow` times on every reconcile.
    const [host, inSandbox] = await Promise.all([
      onHost,
      sandbox.list(executable, this.sandboxSessionRoot(agent.id), toContainerPath(this.project.path))
    ]);
    const name = sandboxName(this.project.id, agent.id);
    return [...host, ...inSandbox.map((info) => ({ ...info, sandbox: name }))];
  }

  /** Where this agent's sandboxed sessions land on the host — the mounted directory. */
  private sandboxSessionRoot(agentId: AgentId): string {
    return sandboxSessionDir(this.agentDirOf(agentId));
  }

  /** Both conditions for running the agent at all: it can be started, and its setup succeeded. */
  private canStart(runtime: AgentRuntime): boolean {
    return runtime.startable && !runtime.prepareFailed;
  }

  private async prepareRuntime(runtime: AgentRuntime): Promise<void> {
    const { agent, executable } = runtime;
    const cwd = this.project.path;

    if (agent.versionArgs) {
      runtime.startable = await isAgentInstalled(executable, agent.versionArgs, cwd);
      // Nothing on this machine, but the project runs this agent in its own sandbox, where the
      // CLI lives: startable after all. Only the config is read here — checkSbxReady talks to
      // Docker and stays where it is, on the spawn itself (resolveSbxRun).
      if (!runtime.startable && isSbxAgent(agent.id) && (await readSbxConfig(cwd)).enabled) {
        runtime.startable = true;
        runtime.sbxOnly = true;
      }
    }
    if (!runtime.startable || !agent.sessions) {
      return;
    }
    // Here, not in bringUp: the label stands until the next activity, and a stall long after this
    // must not be written to event-loop.log as a startup phase.
    markStartup(`list ${agent.id}`);
    await this.bringUp(runtime);
  }

  /** Everything an agent that can be started needs before its tabs exist: its setup, the sessions
   *  this repository already has of it, and the watch that keeps that list current. */
  private async bringUp(runtime: AgentRuntime): Promise<void> {
    const { agent } = runtime;
    // Before the listing, which may need what this sets up (opencode's records directory).
    if (!(await this.prepare(runtime))) {
      return;
    }

    const infos = await this.listSessions(runtime);
    // Closed while listing: the watcher started below would outlive `dispose`.
    if (this.disposed) {
      return;
    }
    // `bringUp` runs a second time for an agent that only became startable later
    // (sbxConfigChanged); a session already on screen must not be added twice.
    const known = new Set(this.tabs.map((tab) => tab.sessionId));
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
    // Started after the initial listing so its first event can't race the bootstrap.
    this.startWatching(runtime);
  }

  /**
   * The project's sbx switch was written — by the settings dialog, an agent, an editor or a
   * checkout, all of which the watcher reports the same way (repository.ts's COMMANDS_FILE).
   *
   * It has to be picked up here rather than at the next start: `addProject` opens the project
   * before the dialog that switches sandboxing on is even shown, so a machine with no agent at all
   * would otherwise sit in front of an empty project until it restarts. Only what could not be
   * started is acted on — with the agents on this machine every runtime is startable already, and
   * this ends at the filter, one read later.
   */
  async sbxConfigChanged(): Promise<void> {
    const sbxRuntimes = [...this.runtimes.values()].filter((runtime) => isSbxAgent(runtime.agent.id));
    if (this.disposed || sbxRuntimes.length === 0) {
      return;
    }
    // A write landing during the bootstrap would otherwise find a runtime whose version check is
    // still running and read its "not startable" as "has no executable here".
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
        // Reassigned so a tab already waiting on `ready` joins this listing rather than starting
        // on a runtime that has not been set up.
        runtime.ready = this.bringUp(runtime);
        brought.push(runtime.ready);
      } else if (!enabled && runtime.sbxOnly) {
        // Nothing left to run it with. Tabs already open keep their session — the one that tries
        // to spawn gets resolveSbxRun's notice — but a new tab is honest about it.
        runtime.startable = false;
        runtime.sbxOnly = false;
      }
    }
    if (brought.length === 0) {
      return;
    }
    await Promise.all(brought);
    // Only now: the project was opened with nothing it could start, and this is the moment that
    // changed. Every other write of tet.json leaves the tabs alone — one the user closed stays
    // closed.
    this.openFirstAgentTab();
  }

  /**
   * Runs the agent's setup, at most one at a time. False means it failed and the agent must not
   * be started at all.
   */
  private prepare(runtime: AgentRuntime): Promise<boolean> {
    runtime.preparing ??= this.doPrepare(runtime).finally(() => {
      runtime.preparing = undefined;
    });
    return runtime.preparing;
  }

  private async doPrepare(runtime: AgentRuntime): Promise<boolean> {
    const { agent, executable } = runtime;
    if (this.disposed) {
      return false;
    }
    if (!agent.prepareSpawn || runtime.preparation) {
      return !runtime.prepareFailed;
    }
    try {
      markStartup(`prepare ${agent.id}`);
      const preparation = await agent.prepareSpawn(executable, this.project.path, this.pathsFor(runtime));
      // Closed while that ran: nothing of it may be kept, since nothing may spawn from here on.
      if (this.disposed) {
        return false;
      }
      runtime.preparation = preparation;
      // Nothing else clears an earlier failure.
      runtime.prepareFailed = false;
      return true;
    } catch (error) {
      console.error("[tet] spawn preparation failed:", error);
      this.callbacks.onNotice("error", `${agent.displayName} could not be started: ${String(error)}`);
      runtime.prepareFailed = true;
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

  createTab(agentId: AgentId): TerminalDescriptor {
    return this.addTab(agentId, {});
  }

  /**
   * A tab whose process *is* a saved command, labelled by its `name` or the command line. The
   * program is started directly, without a shell (`resolveCommand` settles the platform
   * difference); only a command that asked for a shell gets the project's shell.
   */
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined {
    const shared = {
      title: command.name ?? command.command,
      command: command.command,
      // `resolve` rather than `join`, so a folder that is already absolute is left alone.
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
    // Shell syntax would reach the program as an ordinary argument — `rm x && y` would ask rm
    // to delete "&&" and "y".
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
    this.newTabCounter += 1;
    const tab: TabState = {
      tabId: `new-${this.newTabCounter}`,
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
    if (!tab) {
      return;
    }
    this.startTab(tab);
  }

  /**
   * Everything one tab's first spawn needs: the agent's setup, its sandbox, then the process at
   * the tab's last fitted size. Shared by `handleResize` and `restartTab`, both of which have
   * put that size in `lastSizes` first.
   */
  private startTab(tab: TabState): void {
    const tabId = tab.tabId;
    // The agent's setup may still be running; the resize that found it underway has already
    // updated `lastSizes`, so the spawn below picks up the newest size.
    if (this.starting.has(tabId)) {
      return;
    }
    this.starting.add(tabId);
    // Released *after* the session is started: `startSession` acquires the same tab's next
    // indicator, and releasing first would flicker the bar off and on.
    this.acquireIndicator(tabId);
    void Promise.all([this.runtimeFor(tab.agentId).ready, this.resolveSbxRun(tab)])
      .then(([, sbxArgs]) => {
        const dims = this.lastSizes.get(tabId);
        if (!dims || !this.tabs.includes(tab) || this.sessions.has(tabId)) {
          // Closed while the setup ran: nothing left to start.
          return;
        }
        // A sandboxed session cannot resume on the host, and an agent that is not installed here
        // has no host process to be (see resolveSbxRun) — without this both would spawn the
        // missing executable. Left in `error` so the tab menu's Restart retries: a `ready` tab
        // gets no second fit for an unchanged size (`sent` in terminal-views.ts). `sbxStranded`
        // has already said why.
        if (sbxArgs === null && (tab.sandbox || this.runtimeFor(tab.agentId).sbxOnly)) {
          tab.status = "error";
          this.callbacks.onStatus(this.project.id, tabId, "error");
          return;
        }
        this.startSession(tab, sbxArgs).ensureStarted(dims.cols, dims.rows);
      })
      .catch((error: unknown) => {
        this.callbacks.onNotice("error", `${tab.agentId} could not be started: ${String(error)}`);
        // Spawned nothing; `error` offers Restart, as above.
        if (this.tabs.includes(tab) && !this.sessions.has(tabId)) {
          tab.status = "error";
          this.callbacks.onStatus(this.project.id, tabId, "error");
        }
      })
      .finally(() => {
        // An entry left here would make every later resize return as "still starting".
        this.starting.delete(tabId);
        this.releaseIndicator(tabId);
      });
  }

  /**
   * Whether this tab runs inside its project's sbx sandbox, and if so the whole `sbx run`
   * argument list. Reads tet.json fresh on every spawn, like `readCommands`.
   *
   * Only sbx agents (isSbxAgent), and only a plain agent tab, never a saved command's.
   *
   * A session runs where it lives: resuming a host session inside a sandbox fails outright
   * ("No conversation found with session ID: …", measured), so a host session stays on the host
   * and a sandboxed one goes back in. A tab with no `sessionId` yet is sandboxed.
   *
   * Sbx not ready (not installed, not signed in, policy never initialized) skips the sandbox for
   * this one spawn and says so, without writing `enabled: false` back: the checks cannot tell an
   * outage from a permanent state (`sbx ls` fails the same way while the daemon restarts, e.g.
   * during an sbx update). Skipping is needed: `sbx run` would otherwise print its own
   * interactive sign-in and policy setup into the tab (measured).
   */
  private async resolveSbxRun(tab: TabState): Promise<string[] | null> {
    if (tab.executable || !isSbxAgent(tab.agentId)) {
      return null;
    }
    const config = await readSbxConfig(this.project.path);
    if (!config.enabled) {
      // Only a tab that cannot follow onto this machine gets a notice.
      this.sbxStranded(tab, "sandboxing is switched off for the project");
      return null;
    }
    const ready = await checkSbxReady();
    if ("notReady" in ready) {
      if (!this.sbxStranded(tab, ready.notReady)) {
        this.callbacks.onNotice(
          "warning",
          `SBX is not available for ${this.project.name}: ${ready.notReady}. This tab starts on this machine directly; sandboxing stays on for the project.`
        );
      }
      return null;
    }
    const runtime = this.runtimeFor(tab.agentId);
    const { agent } = runtime;
    if (tab.sessionId && !tab.sandbox) {
      // Such a session can only be resumed where it was made, and for an agent that is not on
      // this machine that place is gone. Not `sbxStranded`: its "Restart tries again" is a
      // promise nothing can keep here, since a host session never resumes inside the sandbox.
      if (runtime.sbxOnly) {
        this.callbacks.onNotice(
          "warning",
          `${agent.displayName} is not installed on this machine any more, and a session made here cannot be resumed in ${this.project.name}'s SBX sandbox. A new tab runs in the sandbox; this one cannot.`
        );
      } else if (!this.sbxPreexistingSaid) {
        this.sbxPreexistingSaid = true;
        this.callbacks.onNotice(
          "info",
          `${agent.displayName} tabs from before SBX was enabled for ${this.project.name} keep running on this machine; only new tabs run in its sandbox.`
        );
      }
      return null;
    }
    const paths = this.pathsFor(runtime);
    const sandbox = sandboxName(this.project.id, tab.agentId);
    const hooks = agent.prepareSandboxSpawn?.(this.project.path, paths, sandbox) ?? { args: [] };
    const resumeArgs = tab.sessionId && agent.sessions ? agent.sessions.resumeArgs(tab.sessionId) : [];
    const sessionRoot = this.sandboxSessionRoot(tab.agentId);
    const { args, missing } = await prepareSbxRun({
      agentId: tab.agentId,
      projectId: this.project.id,
      projectPath: this.project.path,
      config,
      sandboxes: ready.sandboxes,
      paths,
      agentArgs: [...hooks.args, ...resumeArgs, ...(tab.runArgs ?? [])],
      env: [...(agent.sandboxEnv ?? []), ...Object.entries(hooks.env ?? {}).map(([key, value]) => `${key}=${value}`)],
      sessionMounts: (agent.sessions?.sandbox?.mounts ?? []).map((mount) => ({
        host: path.join(sessionRoot, mount.sub),
        target: mount.target,
        file: mount.file
      })),
      onData: (data) => this.callbacks.onOutput(this.project.id, tab.tabId, data)
    });
    if (missing.length > 0) {
      this.callbacks.onNotice(
        "warning",
        `${agent.displayName} in ${this.project.name} starts without ${missing.length === 1 ? "an allowed path that does not exist" : "allowed paths that do not exist"} on this machine: ${missing.join(", ")}`
      );
    }
    return args;
  }

  /**
   * The one notice a tab with no way onto this machine gets when its sandbox is not there, said at
   * the branch that knows the reason: a session that lives in the sandbox, or an agent that is not
   * installed here at all (AgentRuntime.sbxOnly). Returns whether it applied, so the caller skips
   * its own fallback notice — for these tabs there is no fallback. Said per tab, not once per
   * project: it is about one tab the user just opened.
   */
  private sbxStranded(tab: TabState, reason: string): boolean {
    const { agent, sbxOnly } = this.runtimeFor(tab.agentId);
    if (!tab.sandbox && !sbxOnly) {
      return false;
    }
    const what = tab.sandbox
      ? `This ${agent.displayName} session lives in ${this.project.name}'s SBX sandbox and cannot run on this machine`
      : `${agent.displayName} is not installed on this machine and only runs in ${this.project.name}'s SBX sandbox`;
    this.callbacks.onNotice(
      "warning",
      `${what}: ${reason}. The tab menu's Restart tries again once that has changed.`
    );
    return true;
  }

  private startSession(tab: TabState, sbxArgs: string[] | null): TerminalSession {
    const runtime = this.runtimeFor(tab.agentId);
    const { agent, executable, preparation } = runtime;
    const resumeArgs = tab.sessionId && agent.sessions ? agent.sessions.resumeArgs(tab.sessionId) : [];
    const tabId = tab.tabId;

    // Fresh per session, so the predicate starts counting from zero.
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

    // A saved command is not this agent's process, so the preparation's args don't apply. An
    // sbx-wrapped tab: `sbxArgs` is the full `sbx run` command line, resumeArgs included, and
    // the preparation's host-only executable/args/env don't apply inside the sandbox.
    const args = tab.executable
      ? (tab.runArgs ?? [])
      : (sbxArgs ?? [...(preparation?.args ?? []), ...resumeArgs, ...(tab.runArgs ?? [])]);

    const session = new TerminalSession(
      sbxArgs ? "sbx" : (tab.executable ?? preparation?.executable ?? executable),
      tab.cwd ?? this.project.path,
      sbxArgs ? undefined : preparation?.env,
      {
        onOutput: (data) => {
          this.callbacks.onOutput(this.project.id, tabId, data);
          // Only the shells: an agent tab's output is its own TUI redrawing itself.
          if (!agent.sessions) {
            this.shellContext.append(tabId, tab.title || tabId, data);
          }
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
            // A CLI killed mid-turn never reports its end; a dead tab is neither working nor
            // waiting for an answer.
            if (tab.busy || tab.waitingAt !== undefined) {
              tab.busy = false;
              tab.waitingAt = undefined;
              this.postTabs();
            }
            // The CLI may exit before crossing the readiness heuristic, and a "missing" from
            // `markInstalled` spawns no process at all: release the indicator either way.
            hideIndicator();
          }
        }
      },
      agent.quitPresses ?? 0,
      args,
      tab.env,
      // What `tet-ctl`, run inside this tab, reports as its caller — see src/shared/control.ts.
      { [CONTROL_ENV.projectId]: this.project.id, [CONTROL_ENV.tabId]: tabId }
    );

    if (!tab.sessionId) {
      tab.spawnedAt = Date.now();
    }
    this.sessions.set(tabId, session);
    session.markInstalled(this.canStart(runtime));
    return session;
  }

  write(tabId: string, data: string): void {
    // The one "answered" signal there is: a question is answered by typing into the tab that
    // asked it. Cleared before forwarding, so the answer and the mark's end are one moment.
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (tab?.waitingAt !== undefined && answersQuestion(data)) {
      tab.waitingAt = undefined;
      this.postTabs();
    }
    this.sessions.get(tabId)?.write(data);
  }

  /**
   * What full url a fragment on screen belongs to — see AgentDefinition.resolveUrlPrefix.
   * Undefined whenever it can't be answered (agent doesn't implement it, tab has no
   * session yet, or the lookup failed); the renderer caches that as "don't ask again".
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
   * Closing a tab deletes the session behind it. Every tab is dropped from the UI up front; the
   * teardown runs one tab at a time, so session listing and removal never overlap.
   */
  async closeTabs(tabIds: string[]): Promise<void> {
    const doomed = new Set(tabIds);
    const tabs = this.tabs.filter((tab) => doomed.has(tab.tabId));
    if (tabs.length === 0) {
      return;
    }
    const indices = new Map(tabs.map((tab) => [tab.tabId, this.tabs.indexOf(tab)]));
    this.tabs = this.tabs.filter((tab) => !doomed.has(tab.tabId));
    this.postTabs();

    // Every stop started before any is awaited: each takes a grace period (TerminalSession.stop),
    // and closing four tabs must not cost four. `destroyTab` joins the stop already underway.
    for (const tab of tabs) {
      void this.sessions.get(tab.tabId)?.stop();
    }
    for (const tab of tabs) {
      await this.destroyTab(tab, indices.get(tab.tabId) ?? this.tabs.length);
    }
  }

  /**
   * Kills a removed tab's pty and deletes its persisted session; `index` is where the tab
   * sat before removal, used to put it back if the deletion fails.
   */
  private async destroyTab(tab: TabState, index: number): Promise<void> {
    const session = this.sessions.get(tab.tabId);
    this.lastSizes.delete(tab.tabId);
    if (session) {
      this.sessions.delete(tab.tabId);
      // Awaited: the persisted session is deleted after the process is gone.
      await session.stop();
    }

    const runtime = this.runtimeFor(tab.agentId);
    const { agent, executable } = runtime;
    if (!agent.sessions) {
      this.shellContext.close(tab.tabId);
      return;
    }
    if (!tab.sessionId && session) {
      // A fresh tab may have persisted a session already — claim its id so it gets deleted
      // too. detachedTabs lets reconcile match a tab already spliced out.
      this.detachedTabs.push(tab);
      try {
        // A reconcile already underway listed before this tab was detached; wait it out, then
        // run one that sees the tab.
        await runtime.reconciling;
        await this.reconcile(runtime);
      } finally {
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
      // The persisted session still exists — put its tab back.
      tab.status = "ready";
      this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
      this.postTabs();
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  /** A tab without a sessionId has nothing persisted to rename; the optimistic label reverts. */
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
   * Runs a tab's process again in the same tab. A saved command is respawned in place with the
   * same command line (`TerminalSession.restart`). An agent tab whose process is gone goes
   * through the whole start path instead: a sandboxed tab's `sbx run` line was built around
   * mounts that do not survive a sandbox stop, so the readiness checks, the sandbox and the
   * mounts are redone and the session resumed. Only a tab with no process (`stopped` or
   * `error`, the latter also a start that gave up before spawning); one not fitted yet has its
   * first fit for that.
   */
  restartTab(tabId: string): void {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) {
      return;
    }
    if (isSavedCommandTab(tab)) {
      this.sessions.get(tabId)?.restart();
      return;
    }
    if (!this.lastSizes.has(tabId) || (tab.status !== "stopped" && tab.status !== "error")) {
      return;
    }
    // `startTab` gives up on a tab that already has a session.
    this.sessions.delete(tabId);
    // The status stays until the new process reports its own, so a start that gives up again
    // still offers Restart.
    this.startTab(tab);
  }

  /**
   * One of this tab's own hooks, reporting over the control channel — the only way a session's
   * turns reach tet (see "Both ends of a turn" in CLAUDE.md). Addressed by tab, not by session:
   * the hook is a child of that tab's pty and carries its id in the environment, so a turn is
   * never reported for a session no tab has claimed yet.
   *
   * Answers what the agent is to see on stdout, and the toast for the control server to show —
   * composed here, where the settings are read at the moment of the event rather than baked
   * into a generated script at setup. Whether a mark is *shown* stays the renderer's decision.
   */
  hookEvent(tabId: string, event: HookEvent, payload: string, reportedAt: number | undefined): HookOutcome {
    const tab = this.disposed ? undefined : this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) {
      return {};
    }
    // When the hook *fired*, not when it arrived: two hooks of the same turn are two requests
    // racing each other, and out of a sandbox each spends ~100 ms on the way while the events
    // behind them can be milliseconds apart. Ordering by arrival lets the older one win and
    // leaves a tab both finished and working. Every report about one tab comes from that tab's
    // own agent, so one clock decides throughout.
    const at = typeof reportedAt === "number" && Number.isFinite(reportedAt) && reportedAt > 0 ? reportedAt : Date.now();
    // The one that lost the race has nothing left to say; one that is *much* older is a clock
    // that moved, not a race (turn-order.ts). The toast still goes out either way — it was true
    // when the hook fired, as it was when the toast sat in the hook script itself.
    const fresh = reportApplies(tab.signalAt, at);
    switch (event) {
      case "prompt-submit":
        if (fresh) {
          setTurn(tab, true, at);
          this.postTabs();
        }
        // What tet has to say about the repository, for the agent to put in front of the model.
        return { stdout: this.shellContext.text };
      case "stop": {
        const agent = getAgent(tab.agentId);
        // Only the agent's own payload knows whether the turn it just ended is really over.
        if (agent.holdsTurnEnd?.(payload)) {
          return {};
        }
        if (fresh) {
          setTurn(tab, false, at, agent.questionOutlivesTurn === true);
          this.postTabs();
        }
        return { toast: this.toast(tab, "finished") };
      }
      case "permission":
      case "question":
        // Not through setTurn: the turn is still open, `busy` is untouched.
        if (fresh) {
          tab.waitingAt = at;
          tab.signalAt = at;
          this.postTabs();
        }
        return { toast: this.toast(tab, event) };
      case "idle":
        // A reminder about a turn that already ended — nothing to mark, the bubble stands.
        return { toast: this.toast(tab, "idle") };
    }
  }

  /** What the user is told about this event, or nothing where the settings say so. Read now, so
   *  a switch flipped in the dialog applies to the next turn of every project, not the next one
   *  opened. */
  private toast(tab: TabState, kind: "finished" | "permission" | "question" | "idle"): HookToast | undefined {
    const { notifications } = this.settings.get();
    const wanted =
      kind === "finished" ? notifications.finished : kind === "idle" ? notifications.idleReminder : notifications.needsYou;
    if (!wanted) {
      return undefined;
    }
    const name = getAgent(tab.agentId).displayName;
    const repository = path.basename(this.project.path);
    switch (kind) {
      case "finished":
        return { title: `${name}: Finished`, body: `Finished in ${repository}` };
      case "permission":
        return { title: `${name}: Action needed`, body: `Waiting for input in ${repository}` };
      case "question":
        return { title: `${name}: Question`, body: `Waiting for your answer in ${repository}` };
      case "idle":
        return { title: `${name}: Still waiting`, body: `No response yet in ${repository}` };
    }
  }

  /**
   * The renderer says this tab is in front of the user, so a finished turn has been seen. A
   * standing question is left alone: it stays true while looked at, and ends with an answer
   * (`write`) or with the turn (setTurn).
   */
  markSeen(tabId: string): void {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab || tab.finishedAt === undefined) {
      return;
    }
    tab.finishedAt = undefined;
    this.postTabs();
  }

  private scheduleReconcile(runtime: AgentRuntime, delayMs = RECONCILE_DEBOUNCE_MS): void {
    // Nothing to list for the shell, and this runs on every output chunk.
    if (!runtime.agent.sessions) {
      return;
    }
    runtime.reconcileRetriesLeft = RECONCILE_MAX_RETRIES;
    // Only an unsettled label needs the mid-output reconcile; otherwise the debounce keeps
    // listings out of a turn. Not `tabsOf(...).some(...)`: this runs on every output chunk, and
    // `tabsOf` allocates.
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

  /**
   * Re-lists one agent's sessions to (a) adopt real session ids/titles for fresh tabs whose
   * CLI has persisted a session since spawning, and (b) refresh titles of known tabs.
   */
  private reconcile(runtime: AgentRuntime): Promise<void> {
    // Serialized: a second call while one is in flight just waits for the first.
    runtime.reconciling ??= this.doReconcile(runtime).finally(() => {
      runtime.reconciling = undefined;
    });
    return runtime.reconciling;
  }

  private async doReconcile(runtime: AgentRuntime): Promise<void> {
    countActivity("reconcile");
    const { agent } = runtime;
    // A disposed project has nothing to reconcile into.
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
    // Oldest first, so the `find` below is the *nearest* session created after a tab's spawn.
    const unclaimed = infos.filter((info) => !claimed.has(info.id)).sort((a, b) => a.createdAt - b.createdAt);
    let changed = false;

    // Newest tab first, each taking the nearest session created after its spawn: right as long
    // as CLIs persist in spawn order, and a listing carries no cwd or pid to do better.
    const pendingTabs = [...ownTabs, ...this.detachedTabs.filter((tab) => tab.agentId === agent.id)]
      .filter((tab) => !tab.sessionId && tab.spawnedAt !== undefined)
      .sort((a, b) => (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0));
    for (const tab of pendingTabs) {
      const match = unclaimed.find((info) => info.createdAt > (tab.spawnedAt ?? 0));
      if (!match) {
        continue;
      }
      unclaimed.splice(unclaimed.indexOf(match), 1);
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
      // Tracked even when the label is unchanged: an assigned name can read the same as the
      // stand-in, and that still ends the polling.
      tab.provisionalTitle = info.provisionalTitle;
      // The net under the end-of-turn signal: no Stop hook fires for a turn the user cut short,
      // but the agent's own record has the end. Only ever ends a turn still believed running
      // (an older end belongs to the previous turn), and leaves no mark — the user cut it short
      // in that very tab.
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
    this.shellContext.dispose();
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

  constructor(
    private readonly storageRoot: string,
    private readonly settings: SettingsStore,
    private readonly callbacks: SessionManagerCallbacks
  ) {}

  open(project: Project): ProjectSessionManager {
    const existing = this.managers.get(project.id);
    if (existing) {
      return existing;
    }
    const manager = new ProjectSessionManager(project, this.storageRoot, this.settings, this.callbacks);
    this.managers.set(project.id, manager);
    manager.bootstrap().catch((error: unknown) => {
      this.callbacks.onNotice("error", `${project.name} could not be opened: ${String(error)}`);
    });
    return manager;
  }

  get(projectId: string): ProjectSessionManager | undefined {
    return this.managers.get(projectId);
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
