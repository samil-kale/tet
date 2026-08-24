import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS, getAgent } from "../agents";

import type { AgentDefinition, AgentPaths, SpawnPreparation } from "../agents/agent";
import { splitCommand } from "../shared/command";
import { CONTROL_ENV } from "../shared/control";
import type {
  AgentId,
  NoticeSeverity,
  Project,
  ProjectCommand,
  TerminalDescriptor,
  TerminalStatus
} from "../shared/types";
import { countActivity, logSlow } from "./event-loop-monitor";
import type { SettingsStore } from "./settings";
import { ShellContext } from "./shell-context";
import { isAgentInstalled, TerminalSession } from "./terminal-session";
import { currentTheme } from "./theme";

const RECONCILE_DEBOUNCE_MS = 5000;
// A tab's CLI can persist a title (a generated summary) well after its output went idle, so
// one reconcile after the debounce is not always enough — retry a few times before giving up.
const RECONCILE_RETRY_MS = 5000;
const RECONCILE_MAX_RETRIES = 3;
// A busy CLI redraws continuously, so the debounce above would be pushed out for the whole
// turn and a tab whose session or title is not known yet would keep its placeholder long
// after the CLI persisted one. Caps how far output can push it.
const RECONCILE_MAX_WAIT_MS = 10000;
// A watcher event is the change itself, not a guess that one may have happened, so it only
// needs enough of a debounce to collapse the handful of events a single write produces.
const WATCH_DEBOUNCE_MS = 300;
// A killed CLI gets a moment to die before its transcript is removed, so a final in-flight
// write can't resurrect the file we just deleted.
const SESSION_REMOVE_DELAY_MS = 500;
/**
 * How long a turn whose session no tab has claimed is held before it is given up on. It has to
 * outlast the gap between a CLI reporting its first prompt and persisting the transcript that
 * the session listing reads — seconds, not milliseconds — and it is the only thing bounding
 * `pendingTurns`, so it must not be indefinite either.
 */
const PENDING_TURN_TTL_MS = 60_000;
// Readiness fires on the CLI's first full frame, which is a moment before the terminal
// actually looks settled — hiding the indicator right then reads as a flicker.
const INDICATOR_LINGER_MS = 700;
/**
 * A token that only means anything to a shell. A saved command is started without one, so it
 * would silently become an argument; such a command is refused with a message instead. Whole
 * tokens only — `2>&1` and `>>` are matched, an argument that merely holds a `>` is not.
 */
const SHELL_OPERATOR = /^(?:&&|\|\||[|;&]|\d*>>?|\d*>&\d*|<)$/;

interface TabState extends TerminalDescriptor {
  /** When this tab's pty was spawned — used to claim newly persisted sessions. */
  spawnedAt?: number;
  /** Mirrors AgentSessionInfo.provisionalTitle for this tab's session. */
  provisionalTitle?: boolean;
  /** When the running turn was reported as started — what a turn end is dated against. */
  busySince?: number;
  /**
   * When the latest turn signal applied here was made. Claude Code's and Codex's signals are
   * files in three directories, each watched and swept on its own, so a `busy` the watcher
   * missed can be found after the `finished` of the same short turn — and applied in that
   * order it left the spinner running until the next turn ended. Anything older is dropped.
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
  installed: boolean;
  /** Resolves once the agent's version check, spawn preparation and initial listing are done. */
  ready: Promise<void>;
  preparation?: SpawnPreparation;
  prepareFailed: boolean;
  /** One setup at a time: two tabs opened at once must not bring up two opencode servers. */
  preparing?: Promise<boolean>;
  /** Its setup and watcher are let go because nothing in this project is using them. */
  released: boolean;
  stopWatching?: () => void;
  reconciling?: Promise<void>;
  reconcileTimer?: ReturnType<typeof setTimeout>;
  reconcileRetriesLeft: number;
  /** Latest point in time the debounced reconcile may be pushed to; unset once it fires. */
  reconcileDeadline?: number;
  /**
   * Sessions whose turn state arrived before any tab had claimed their id, what that state was,
   * and when it came in — see markTurn and PENDING_TURN_TTL_MS.
   */
  readonly pendingTurns: Map<string, PendingTurn>;
}

/**
 * What a session reported before any tab held its id, waiting for the reconcile that gives it
 * one. The two are kept side by side rather than as one latest-wins value: a question always
 * arrives *within* a turn, so a waiting report that overwrote the busy before it would land a
 * mark on a tab that never learned it was working.
 */
interface PendingTurn {
  /** The latest turn signal, if one came in at all, and when it was made. */
  busy?: boolean;
  busyAt?: number;
  /** When a question was reported, if one was; see TerminalDescriptor.waitingAt. */
  waitingAt?: number;
  since: number;
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
 * A turn started or ended. The spinner follows it either way, and the end of one also leaves
 * the mark that outlives it — the two belong together, so one function sets both.
 *
 * Either end also clears `waitingAt`: a question can only stand open within a turn, so a turn
 * that has just begun cannot have one yet and one that has ended cannot still have one. This is
 * the only signal there is — no agent reports that a question was answered — which is why a
 * permission granted mid-turn leaves the mark until the tab is looked at.
 */
function setTurn(tab: TabState, busy: boolean, at: number): void {
  tab.busy = busy;
  tab.waitingAt = undefined;
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
 * no Enter at all) and a mouse *click*: the TUIs turn mouse tracking on, so a click on an option
 * arrives here as an SGR press sequence, `ESC [ < button ; x ; y M`. What is left out is moving
 * around without choosing — the arrow keys, Tab and Shift+Tab, a bare Escape, mouse motion (bit
 * 32 in the button code) and the wheel (64 and up), since scrolling past a prompt is not answering
 * it. Deliberately generous otherwise: a mark dropped a keystroke early is a mark on a tab the
 * user is typing into, which is on screen and hides it regardless.
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
  const { tabId, projectId, agentId, title, updatedAt, createdAt, status, sessionId, finishedAt, busy, waitingAt } =
    tab;
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
    savedCommand: isSavedCommandTab(tab)
  };
}

/**
 * A saved command's own program (non-shell) or its shell arguments (`"shell": true`) — either
 * is set only for a tab created by `createCommandTab`, never for a plain interactive shell tab
 * or an agent tab.
 */
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
  private readonly starting = new Map<string, { cols: number; rows: number }>();
  /** Session ids whose removal is still in flight — reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs already removed from the UI that still need their persisted session claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];
  private newTabCounter = 0;
  /** The project was closed; nothing that was still in flight may start anything back up. */
  private disposed = false;
  /**
   * How many things in this project are still starting — the progress bar is shared across
   * the project's tabs, so it stays up as long as at least one of them hasn't settled.
   */
  private indicators = 0;
  /**
   * How many of those belong to which tab — what `TerminalDescriptor.starting` says, so the pane
   * that tab lives in can show the bar itself. A count per tab rather than a flag on the tab,
   * for two reasons: a tab's setup and its CLI's first frame are two indicators that overlap
   * (see `handleResize` and `startSession`), and a release for a tab that has just been closed
   * must still balance its acquire — `closeTabs` can put a tab back after a failed delete, and
   * a flag on it would come back stuck.
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

  /** Where one agent may set itself up for this repository — see AgentDefinition.prepareSpawn. */
  private pathsFor(runtime: AgentRuntime): AgentPaths {
    const agentDir = path.join(this.storageRoot, "agents", runtime.agent.id, this.project.id);
    fs.mkdirSync(agentDir, { recursive: true });
    return {
      agentDir,
      contextFile: this.shellContext.contextFile,
      contextReadPaths: [this.shellContext.logFile],
      storageRoot: this.storageRoot,
      // Read here rather than held: an agent prepares once per project, so this is the moment
      // the current settings apply, and a change reaches the ones set up after it.
      notifications: this.settings.get().notifications,
      theme: currentTheme(this.settings),
      // The shell has no switch of its own — nor a look to switch — so it reads as on.
      themeAgents: runtime.agent.id === "shell" || this.settings.get().themeAgents[runtime.agent.id],
      onSessionBusy: (sessionId, at) => this.markTurn(runtime, sessionId, true, at ?? Date.now()),
      onSessionFinished: (sessionId, at) => this.markTurn(runtime, sessionId, false, at ?? Date.now()),
      onSessionWaiting: (sessionId, at) => this.markWaiting(runtime, sessionId, at ?? Date.now())
    };
  }

  snapshot(): TerminalDescriptor[] {
    return this.tabs.map((tab) => toDescriptor(tab, this.tabIndicators.has(tab.tabId)));
  }

  private postTabs(): void {
    // Not after the project is gone: a release, a status or a turn arriving late would post an
    // empty list for it, and the renderer — which forgot the project on close — would take
    // that as a project it has tabs for again.
    if (this.disposed) {
      return;
    }
    this.callbacks.onTabs(this.project.id, this.snapshot());
  }

  /**
   * The current value of what onStartupProgress reports. The bootstrap of a project restored
   * at app start runs before the window exists, so its "show" never reaches a renderer — the
   * pane asks for the state once instead of waiting for a push.
   */
  isStarting(): boolean {
    return this.indicators > 0;
  }

  /**
   * `tabId`, where there is one, is what lets the pane that tab lives in show the bar itself
   * instead of every pane borrowing pane "a"'s — `bootstrap` below has none, since it starts
   * before any tab does, and stays a plain project-wide reason for pane "a" to fall back to.
   * Every acquire is matched by one release with the same `tabId`, or the count never comes
   * back down.
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
    this.indicators -= 1;
    if (this.indicators === 0) {
      this.callbacks.onStartupProgress(this.project.id, false);
    }
    if (tabId !== undefined) {
      const count = this.tabIndicators.get(tabId) ?? 0;
      if (count <= 1) {
        this.tabIndicators.delete(tabId);
        // The tab may be gone already; posting for one that is not there costs a snapshot
        // nothing changed in, and the map is right either way.
        this.postTabs();
      } else {
        this.tabIndicators.set(tabId, count - 1);
      }
    }
  }

  /** Restores one tab per persisted session of every installed agent. */
  async bootstrap(): Promise<void> {
    // Covers the version checks and session listings too, not just the first tab's CLI
    // startup: opencode's server start and listing take seconds that would otherwise show
    // nothing at all.
    this.acquireIndicator();
    try {
      await Promise.all(AGENTS.map((agent) => this.runtimeFor(agent.id).ready));
      this.openFirstAgentTab();
    } finally {
      this.releaseIndicator();
    }
  }

  /**
   * A project that restored no session at all — just cloned, or every session deleted — opens
   * with one agent tab rather than an empty pane. Which agent is registration order, so Claude
   * Code where it is installed and opencode otherwise; the shell is skipped by having no
   * sessions, the same rule that decides whether a tab takes its title from one.
   *
   * Nothing is spawned by this: the tab only goes in the list, and the pane's first resize is
   * what starts the CLI — so a project the user never switches to costs nothing, and a fresh
   * tab persists no session, which is why this runs again on the next start.
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
      installed: agent.versionArgs === undefined,
      ready: Promise.resolve(),
      prepareFailed: false,
      released: false,
      reconcileRetriesLeft: 0,
      pendingTurns: new Map()
    };
    this.runtimes.set(agentId, runtime);
    runtime.ready = this.prepareRuntime(runtime);
    return runtime;
  }

  /** Both conditions for running the agent at all: it exists, and its setup succeeded. */
  private canStart(runtime: AgentRuntime): boolean {
    return runtime.installed && !runtime.prepareFailed;
  }

  private async prepareRuntime(runtime: AgentRuntime): Promise<void> {
    const { agent, executable } = runtime;
    const cwd = this.project.path;

    if (agent.versionArgs) {
      runtime.installed = await isAgentInstalled(executable, agent.versionArgs, cwd);
    }
    if (!runtime.installed || !agent.sessions) {
      return;
    }

    // Before anything that could lead to a spawn: opencode's listing already needs the
    // server this brings up, and the terminal's own arguments come out of it too.
    if (!(await this.prepare(runtime))) {
      return;
    }

    const infos = await agent.sessions.list(executable, cwd);
    // Closed while listing: nothing to post to, and the watcher started below would be one
    // `dispose` has already run past.
    if (this.disposed) {
      return;
    }
    for (const info of infos) {
      this.tabs.push({
        tabId: info.id,
        projectId: this.project.id,
        agentId: agent.id,
        sessionId: info.id,
        title: info.title,
        updatedAt: info.updatedAt,
        createdAt: info.createdAt,
        provisionalTitle: info.provisionalTitle,
        status: "ready"
      });
    }
    if (infos.length > 0) {
      this.postTabs();
    }
    // Started after the initial listing so its first event can't race the bootstrap.
    this.startWatching(runtime);
    // Nothing was found and nothing has been opened while we were listing, so whatever the
    // setup is holding is serving no one.
    if (infos.length === 0) {
      this.releaseIdleRuntime(runtime);
    }
  }

  /**
   * Runs the agent's setup, at most one at a time. False means it failed and the agent must
   * not be started at all — one that asks for preparation cannot run without it in any
   * meaningful way (opencode would start a second instance sharing only the database: no
   * events, renames invisible to it). Better to start nothing than a terminal that quietly
   * misbehaves.
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
      const preparation = await agent.prepareSpawn(executable, this.project.path, this.pathsFor(runtime));
      // The project may have been closed while that ran — opencode's server boot takes seconds
      // — and `dispose` has already been past `runtime.preparation`, so what arrives now would
      // outlive the project (a server, the marker watchers) with nothing left to end it.
      if (this.disposed) {
        preparation.dispose();
        return false;
      }
      runtime.preparation = preparation;
      // A setup that worked clears the earlier failure: `canStart` reads this flag and nothing
      // else puts it back, so one failed preparation (opencode's port taken, say) would leave
      // the agent unstartable for the rest of the session.
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

  /**
   * Lets go of what this agent keeps running for a project that has no session and no tab of
   * it — but only if its own preparation says that is allowed (see releaseWhenIdle). The
   * watcher goes too: for opencode it is a subscription on the very server being stopped and
   * would bring it straight back up. ensurePrepared restores both.
   */
  private releaseIdleRuntime(runtime: AgentRuntime): void {
    if (!runtime.preparation?.releaseWhenIdle || this.tabsOf(runtime).length > 0) {
      return;
    }
    runtime.stopWatching?.();
    runtime.stopWatching = undefined;
    runtime.preparation.dispose();
    runtime.preparation = undefined;
    runtime.released = true;
  }

  /**
   * The agent's setup, brought back if it was released. Everything that spawns waits on this:
   * without the preparation the CLI would be started with the wrong arguments entirely.
   */
  private async ensurePrepared(runtime: AgentRuntime): Promise<void> {
    await runtime.ready;
    if (!runtime.released) {
      return;
    }
    if (await this.prepare(runtime)) {
      runtime.released = false;
      this.startWatching(runtime);
    }
  }

  createTab(agentId: AgentId): TerminalDescriptor {
    return this.addTab(agentId, {});
  }

  /**
   * A tab that runs one of the project's saved commands and ends with it. Its process *is* the
   * command, and its label is the command's `name` if it has one, the command line otherwise,
   * since a shell tab has no session to take a title from.
   *
   * The program is started directly, without a shell; `resolveCommand` is where the platform
   * difference is settled (a `.cmd` shim on win32 goes through cmd.exe). Only a command that
   * asked for a shell gets one, and then it is the same one the project's shell tabs use.
   */
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined {
    const shared = {
      title: command.name ?? command.command,
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
    // to delete "&&" and "y". Said out loud rather than run: a file written when saved
    // commands still went through a shell is where such a line comes from.
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
    // Nothing of a tab this new can be starting yet — that begins with its first fit.
    return toDescriptor(tab, false);
  }

  handleResize(tabId: string, cols: number, rows: number): void {
    const existing = this.sessions.get(tabId);
    if (existing) {
      existing.ensureStarted(cols, rows);
      return;
    }
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) {
      return;
    }
    // The agent's setup may still be running (version check, opencode's server). Remember
    // the size and start once it settles — the first resize is what spawns the process.
    const pending = this.starting.get(tabId);
    this.starting.set(tabId, { cols, rows });
    if (pending) {
      return;
    }
    // Bringing a released setup back can mean starting opencode's server, which takes
    // seconds — the bar under the tab strip is what says so. Released *after* the session is
    // started, not before: `startSession` acquires the same tab's next indicator (its CLI's
    // first frame), and releasing first would drop both counts to zero for a moment — the bar
    // flickering off and on between two pushes for what is one wait to the user.
    this.acquireIndicator(tabId);
    void this.ensurePrepared(this.runtimeFor(tab.agentId))
      .then(() => {
        const dims = this.starting.get(tabId);
        this.starting.delete(tabId);
        if (!dims || !this.tabs.includes(tab) || this.sessions.has(tabId)) {
          // Closed while the setup ran: what it brought back has no tab to serve, and the
          // close that would have let it go found nothing to release yet.
          this.releaseIdleRuntime(this.runtimeFor(tab.agentId));
          return;
        }
        this.startSession(tab).ensureStarted(dims.cols, dims.rows);
      })
      .finally(() => this.releaseIndicator(tabId));
  }

  private startSession(tab: TabState): TerminalSession {
    const runtime = this.runtimeFor(tab.agentId);
    const { agent, executable, preparation } = runtime;
    const resumeArgs = tab.sessionId && agent.sessions ? agent.sessions.resumeArgs(tab.sessionId) : [];
    const tabId = tab.tabId;

    // Called fresh per session, so each one's predicate starts counting from zero rather
    // than carrying over a previous session's already-passed state.
    let isSessionReady = agent.createIsSessionReady?.();
    if (isSessionReady) {
      this.acquireIndicator(tabId);
    }
    const hideIndicator = (): void => {
      if (!isSessionReady) {
        return;
      }
      // Cleared before the delay, so a second call (e.g. the session stopping right after)
      // can't queue a second release.
      isSessionReady = undefined;
      setTimeout(() => this.releaseIndicator(tabId), INDICATOR_LINGER_MS);
    };

    // A tab that brings its own program — a saved command's — is not this agent's process, so
    // nothing the agent itself would have been started with applies to it.
    const args = tab.executable
      ? (tab.runArgs ?? [])
      : [...(preparation?.args ?? []), ...resumeArgs, ...(tab.runArgs ?? [])];

    const session = new TerminalSession(
      tab.executable ?? preparation?.executable ?? executable,
      tab.cwd ?? this.project.path,
      preparation?.env,
      {
        onOutput: (data) => {
          this.callbacks.onOutput(this.project.id, tabId, data);
          // Only the shells: an agent tab's output is its own TUI redrawing itself.
          if (!agent.sessions) {
            this.shellContext.append(data);
          }
          if (isSessionReady?.(data)) {
            hideIndicator();
          }
          // A CLI persists or updates its session shortly after producing output, so
          // reconciling once output settles adopts a fresh session id and picks up a title
          // the CLI generated for one it already had.
          this.scheduleReconcile(runtime);
        },
        onStatusChange: (status) => {
          tab.status = status;
          this.callbacks.onStatus(this.project.id, tabId, status);
          if (status === "stopped" || status === "error" || status === "missing") {
            this.scheduleReconcile(runtime);
            // A process that is gone is not working on anything, whatever the agent last said:
            // a CLI killed mid-turn never gets to report its end, and the spinner would turn
            // on a dead tab for the rest of the session. An open question goes the same way and
            // for the same reason — there is nothing left to answer it.
            if (tab.busy || tab.waitingAt !== undefined) {
              tab.busy = false;
              tab.waitingAt = undefined;
              this.postTabs();
            }
            // Safety net: the CLI may exit before ever producing enough output to cross the
            // heuristic above — don't leave the bar stuck up forever. `markInstalled` can report
            // "missing" here too (found not installed exactly when this tab tried to start): no
            // process is ever spawned for it, so neither this status change nor any output would
            // otherwise follow to release the indicator startSession acquired.
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
    // The one "answered" signal there is, and it is ours rather than the agent's: a question
    // is answered by typing into the tab that asked it, and every keystroke and click passes
    // through here on its way to the pty. Uniform across agents — no hook, no event, no
    // process per tool call. Cleared before forwarding, so the answer and the mark's end are
    // one moment; wrong at worst by a stray keystroke into a prompt, which puts the mark back
    // to what the tab in front of the user says anyway.
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
   * Closing a tab deletes the session behind it. Every tab is dropped from the UI up front;
   * the teardown then runs one tab at a time, to avoid concurrent CLI calls for
   * listing/removing sessions.
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

    // Every process is asked to end here, before the loop below waits for any of them: stopping
    // an agent now takes a grace period (see TerminalSession.stop), and closing four tabs must
    // not cost four of them. The loop itself stays one at a time — `destroyTab` asks for the same
    // stop again and joins the one already underway.
    for (const tab of tabs) {
      void this.sessions.get(tab.tabId)?.stop();
    }
    for (const tab of tabs) {
      await this.destroyTab(tab, indices.get(tab.tabId) ?? this.tabs.length);
    }
    // Closing a tab deleted its session too, so this may have been the last thing keeping the
    // agent's setup up — the same state the project was in when it had nothing to show.
    for (const runtime of this.runtimes.values()) {
      this.releaseIdleRuntime(runtime);
    }
  }

  /**
   * Kills a removed tab's pty and deletes its persisted session; `index` is where the tab
   * sat before removal, used to put it back if the deletion fails.
   */
  private async destroyTab(tab: TabState, index: number): Promise<void> {
    const session = this.sessions.get(tab.tabId);
    if (session) {
      this.sessions.delete(tab.tabId);
      // Awaited, so everything below — deleting what the CLI persisted — happens after the
      // process is gone rather than beside one that could still write it.
      await session.stop();
    }

    const runtime = this.runtimeFor(tab.agentId);
    const { agent, executable } = runtime;
    if (!agent.sessions) {
      return;
    }
    if (!tab.sessionId && session) {
      // A fresh tab may have persisted a session already — claim its id so it gets deleted
      // too. Runs after the UI removal (the list call can take seconds); detachedTabs lets
      // reconcile match a tab we already spliced out.
      this.detachedTabs.push(tab);
      try {
        // A reconcile already underway listed before this tab was detached and cannot match
        // it; `reconcile` would hand back that very promise. Let it finish, then run one that
        // sees the tab — or its session outlives the tab and is back on the next start.
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
      await agent.sessions.remove(executable, this.project.path, sessionId);
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

  /**
   * A tab without a sessionId yet has nothing persisted to rename (no transcript file, no
   * opencode row) — the renderer's optimistic label reverts to the placeholder in that case.
   */
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
      await agent.sessions.rename(executable, this.project.path, tab.sessionId, title);
      tab.title = title.trim();
      // A name the user picked is final — nothing left for the polling below to wait for.
      tab.provisionalTitle = false;
    } catch (error) {
      this.callbacks.onNotice("error", `Could not rename ${agent.displayName} session: ${String(error)}`);
      tab.title = previousTitle;
    }
    this.postTabs();
  }

  /**
   * Kills a saved command's process and spawns it again in the same tab, at the same size, with
   * the same executable, arguments, cwd and env it was started with — a no-op for any other kind
   * of tab, or one whose process was never spawned in the first place.
   */
  restartTab(tabId: string): void {
    const tab = this.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab || !isSavedCommandTab(tab)) {
      return;
    }
    this.sessions.get(tabId)?.restart();
  }

  /**
   * A turn in one of this project's sessions started or ended, as the agent itself reported it
   * — see AgentPaths.onSessionBusy and onSessionFinished. Whether the mark a finished turn
   * leaves is *shown* is not decided here: the renderer is the half that knows which tab is in
   * front of the user.
   */
  private markTurn(runtime: AgentRuntime, sessionId: string, busy: boolean, at: number): void {
    if (this.disposed || this.applyTurn(runtime, sessionId, busy, at)) {
      return;
    }
    // No tab holds that id yet — a fresh tab whose first turn began, or ended, before the
    // reconcile that adopts its session ran; the common short-first-question case. Held rather
    // than dropped, and re-listed at once so the wait is as short as it can be. A newer turn
    // signal for the same session replaces the one held, so what lands is the state it ended up
    // in; a question held alongside it is left where it is, since applying the turn is what
    // decides whether it still stands.
    const pending = runtime.pendingTurns.get(sessionId);
    if (pending?.busyAt !== undefined && at < pending.busyAt) {
      return;
    }
    runtime.pendingTurns.set(sessionId, { ...pending, busy, busyAt: at, since: Date.now() });
    this.scheduleReconcile(runtime, 0);
  }

  private applyTurn(runtime: AgentRuntime, sessionId: string, busy: boolean, at: number): boolean {
    const tab = this.tabsOf(runtime).find((candidate) => candidate.sessionId === sessionId);
    if (!tab) {
      return false;
    }
    // Made before the signal already applied: found late, not sent late — see `signalAt`.
    if (at >= (tab.signalAt ?? 0)) {
      setTurn(tab, busy, at);
      this.postTabs();
    }
    return true;
  }

  /**
   * A turn in one of this project's sessions stopped on a question — see
   * AgentPaths.onSessionWaiting. Held for a tabless session the same way a turn is, because the
   * very first thing a fresh session does can be to ask for a permission.
   *
   * Deliberately not routed through setTurn: the turn is still open, and nothing here touches
   * `busy`. What the mark does to the spinner is the renderer's decision.
   */
  private markWaiting(runtime: AgentRuntime, sessionId: string, waitingAt: number): void {
    if (this.disposed) {
      return;
    }
    const tab = this.tabsOf(runtime).find((candidate) => candidate.sessionId === sessionId);
    if (tab) {
      // A question from before the turn signal already applied belongs to a turn that is over.
      if (waitingAt >= (tab.signalAt ?? 0)) {
        tab.waitingAt = waitingAt;
        tab.signalAt = waitingAt;
        this.postTabs();
      }
      return;
    }
    const pending = runtime.pendingTurns.get(sessionId);
    runtime.pendingTurns.set(sessionId, { ...pending, waitingAt, since: pending?.since ?? waitingAt });
    this.scheduleReconcile(runtime, 0);
  }

  /**
   * The tab is in front of the user, so a turn that finished out of sight has been seen. Nothing
   * is checked here: the renderer calls it for the active tab of the project on screen, which is
   * the one thing this process cannot know for itself.
   *
   * A standing question is left alone: unlike a finished turn, it is not a one-off notification
   * of something that already happened — the turn is still open, so the mark states a fact that
   * remains true for as long as the user is looking at it too. It ends with an answer typed into
   * the tab (see `write`) or with the turn itself, at either end of setTurn.
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
    // Nothing to list for an agent without sessions (the shell) — and its output arrives per
    // chunk, so this would otherwise re-arm a timer for a no-op on every line of a build.
    if (!runtime.agent.sessions) {
      return;
    }
    runtime.reconcileRetriesLeft = RECONCILE_MAX_RETRIES;
    // Only tabs whose label is unsettled need the mid-output reconcile; elsewhere the debounce
    // alone keeps the extra session listings out of a turn. A stand-in title counts as
    // unsettled — non-empty, but the agent can still replace it mid-turn.
    if (runtime.reconcileDeadline === undefined && this.tabsOf(runtime).some(titleUnsettled)) {
      runtime.reconcileDeadline = Date.now() + RECONCILE_MAX_WAIT_MS;
    }
    this.armReconcileTimer(runtime, delayMs);
  }

  private armReconcileTimer(runtime: AgentRuntime, delayMs: number): void {
    // The retry below re-arms this timer after every run, so a reconcile in flight when the
    // project closed would put a fresh one in place behind dispose's back — and opencode's
    // listing brings its server back up, leaving a process nobody owns.
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
    const { agent, executable } = runtime;
    // A released runtime has nothing to reconcile, and listing would start its server back up.
    // A disposed project is the same case: the listing is what would revive it.
    if (this.disposed || runtime.released || !agent.sessions || !this.canStart(runtime)) {
      return;
    }
    // Wall time, not pure blocking time: the listing's own I/O is async. But for local
    // transcript files that I/O is fast, so a slow listing here is the per-line JSON.parse
    // dominating — the actual synchronous cost this exists to surface.
    const listStart = performance.now();
    const infos = await agent.sessions.list(executable, this.project.path);
    logSlow("reconcile", performance.now() - listStart);
    const ownTabs = this.tabsOf(runtime);
    const claimed = new Set([
      ...ownTabs.map((tab) => tab.sessionId).filter((id) => id !== undefined),
      ...this.deletingSessionIds
    ]);
    const unclaimed = infos.filter((info) => !claimed.has(info.id));
    let changed = false;

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
      // Detached tabs are gone from the UI — claiming their id is all that's needed.
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
      // Tracked even when the label itself is unchanged: an assigned name can read the same
      // as the stand-in it replaces, and that still ends the polling above.
      tab.provisionalTitle = info.provisionalTitle;
      // The net under the end-of-turn signal, for the ends that signal cannot carry: Claude
      // Code runs no Stop hook for a turn the user cut short — an escaped prompt or a rejected
      // tool call — so no marker lands and the spinner would run until the *next* turn ends.
      // The agent's own record has the end either way, so the listing reports it and this is
      // where it is read, the way the marker sweep is the net under fs.watch.
      //
      // Only ever ends a turn, and only one still believed to be running: an end older than
      // the busy that started this turn belongs to the one before it. And it leaves no mark —
      // the only end that reaches us this way is one the user cut short in that very tab, so
      // there is nothing to find again later.
      if (tab.busy && info.turnEndedAt !== undefined && info.turnEndedAt > (tab.busySince ?? 0)) {
        tab.busy = false;
        // A question can only stand within a turn — the same rule setTurn applies, without the
        // mark setTurn would leave (a turn cut short in that tab has nothing to find again).
        tab.waitingAt = undefined;
        changed = true;
      }
      if (info.title !== tab.title || info.updatedAt !== tab.updatedAt) {
        tab.title = info.title;
        tab.updatedAt = info.updatedAt;
        changed = true;
      }
    }

    // Turns reported before their tab had claimed the session — see markTurn. Held until a tab
    // takes them or they age out, and **not** dropped merely for being absent from this
    // listing: a brand new session's `busy` arrives from UserPromptSubmit *before* Claude Code
    // has written the transcript that listing reads, so dropping it there lost the spinner for
    // exactly the case it matters most — the first turn of a fresh tab. The age limit is what
    // bounds the map instead.
    for (const [sessionId, pending] of runtime.pendingTurns) {
      const tab = ownTabs.find((candidate) => candidate.sessionId === sessionId);
      if (tab) {
        // The turn first, the question after: setTurn clears `waitingAt`, so the other order
        // would drop a question that came in while the same turn was still open.
        if (pending.busy !== undefined) {
          setTurn(tab, pending.busy, pending.busyAt ?? Date.now());
        }
        if (pending.waitingAt !== undefined && tab.busy !== false && pending.waitingAt >= (pending.busyAt ?? 0)) {
          tab.waitingAt = pending.waitingAt;
          tab.signalAt = pending.waitingAt;
        }
        runtime.pendingTurns.delete(sessionId);
        changed = true;
      } else if (Date.now() - pending.since > PENDING_TURN_TTL_MS) {
        runtime.pendingTurns.delete(sessionId);
      }
    }

    if (changed) {
      this.postTabs();
    }
  }

  async dispose(): Promise<void> {
    // Read by the reconcile loop, whose calls can outlive this and would otherwise arm
    // themselves again — see armReconcileTimer.
    this.disposed = true;
    // A resize whose preparation is still underway spawns its tab once that resolves, if the
    // tab is still known — with the project gone, none of them is.
    this.tabs = [];
    this.starting.clear();
    this.tabIndicators.clear();
    this.shellContext.dispose();
    for (const runtime of this.runtimes.values()) {
      clearTimeout(runtime.reconcileTimer);
      runtime.stopWatching?.();
      runtime.stopWatching = undefined;
    }
    // All at once: each one may take a grace period to end (see TerminalSession.stop), and the
    // app is waiting on this before it quits.
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    this.sessions.clear();
    // Last: the sessions above may still be talking to whatever it set up.
    for (const runtime of this.runtimes.values()) {
      runtime.preparation?.dispose();
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
    void manager.bootstrap();
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
