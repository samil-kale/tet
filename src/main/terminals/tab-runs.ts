import * as fs from "node:fs";
import { getAgent } from "../agents";
import type { AgentDefinition } from "../agents/agent";
import { CONTROL_ENV, CONTROL_START_SIZE } from "../../shared/ctl";
import { errorMessage } from "../../shared/errors";
import { effectivePrompt } from "../../shared/prompts";
import { writeDropFile } from "../store/drops";
import type { NoticeSeverity } from "../../shared/types/app";
import type { ProjectRef } from "../../shared/types/project";
import type { TerminalStatus } from "../../shared/types/terminals";
import type { ResolvedRef } from "../store/resolved-ref";
import type { SettingsStore } from "../store/settings";
import { logError } from "../util/error-log";
import { openExternalTerminal } from "../util/process";
import type { AgentRuntime } from "./agent-runtime";
import type { AgentPlaces } from "./place-resolver";
import { spawnAgentProcess, storedEnvOf, type TerminalEnv } from "./pty";
import { INTERRUPT_RECONCILE_MS } from "./reconcile-scheduler";
import type { StartIndicators } from "./start-indicators";
import type { HandoverFiles, Launch, LaunchInput, StartingPlace, TabPlace } from "./tab-place";
import { answersQuestion, awaitsClaim, endTurnQuietly, isSavedCommandTab, resumeArgsOf, turnMarked, type TabState } from "./tab-state";
import { TerminalSession } from "./terminal-session";

// How long after a fresh tab's Enter its close waits for the hook naming its session
// (reportBeforeQuit).
const REPORT_WAIT_MS = 3000;
// Readiness fires on the CLI's first full frame, a moment before the terminal looks settled.
const INDICATOR_LINGER_MS = 700;

/** What a tab's process holds, by tab id. Each part ends at its own point (endRun), the entry with
 *  its last. */
interface TabRun {
  /** Its process; held past the tab's close until it has stopped, so a dispose meanwhile stops it. */
  session?: TerminalSession;
  /**
   * The last size it was fitted to, used by every spawn — a restart comes after the fit, and no
   * new fit follows.
   */
  size?: { cols: number; rows: number };
  /** Its session is being constructed; a second resize must not start a second one. */
  starting?: true;
  /** Running and quitting for a restart (restartTab), so a second click starts nothing more. */
  restarting?: true;
  /** What ends a close's wait for the report naming its session (reportBeforeQuit). */
  reportWaiter?: () => void;
}

/** What the session manager tells the window of a tab's process. */
export interface RunCallbacks {
  onOutput: (ref: ProjectRef, tabId: string, data: string) => void;
  onStatus: (ref: ProjectRef, tabId: string, status: TerminalStatus) => void;
  onNotice: (severity: NoticeSeverity, message: string) => void;
}

/** What a tab's process runs on, handed in by the session manager. */
export interface RunsTarget {
  tabOf(tabId: string): TabState | undefined;
  /** Whether the tab is on the strip: closed or archived, its process is only ending. */
  onStrip(tab: TabState): boolean;
  runtimeFor(agentId: TabState["agentId"]): AgentRuntime;
  canStart(runtime: AgentRuntime): boolean;
  /** Where the tab runs (TabSessionManager.placeOf). */
  placeOf(tab: TabState): TabPlace;
  /** PlaceResolver.resolvePlace. */
  resolvePlace(tab: TabState, places: AgentPlaces): Promise<StartingPlace | "stranded">;
  postTabs(): void;
  indicators: StartIndicators;
}

/** A handover's first prompt: the settings' text, then whose transcript it is and where this start
 *  sees it. */
function handoverPrompt(text: string, handover: HandoverFiles, files: string[]): string {
  return `${text}\n\nThe previous agent: ${getAgent(handover.from).displayName}. Its session files: ${files.join(", ")}`;
}

/** One line, as cmd.exe passes a multi-line argument cut short (ask.ts puts its question on stdin). */
function singleLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}

/** Not awaited: nothing reads the copy once its tab is gone. */
export function removeHandoverCopy(dir: string): void {
  fs.promises.rm(dir, { recursive: true, force: true }).catch((error: unknown) => logError("could not delete a handover's copy", error));
}

/**
 * The processes behind a repository's or worktree's tabs: starting, restarting and stopping them, and
 * what the window types into them. The session manager keeps the tabs and asks here for what becomes
 * of their processes.
 */
export class TabRuns {
  /** By tab id, of the tabs on the strip, archived, or closing. */
  private readonly runs = new Map<string, TabRun>();

  constructor(
    private readonly at: ResolvedRef,
    private readonly settings: SettingsStore,
    private readonly terminalEnv: TerminalEnv,
    private readonly callbacks: RunCallbacks,
    private readonly target: RunsTarget,
    /** What starts a tab's process (TerminalSession); a test's stands in for the pty. */
    private readonly spawnProcess: typeof spawnAgentProcess = spawnAgentProcess,
  ) {}

  /** The tab's run, begun where it has none. */
  private runOf(tabId: string): TabRun {
    let run = this.runs.get(tabId);
    if (!run) {
      run = {};
      this.runs.set(tabId, run);
    }
    return run;
  }

  /** Ends one part of a tab's run; the entry goes with its last. */
  private endRun(tabId: string, part: keyof TabRun): void {
    const run = this.runs.get(tabId);
    if (!run) {
      return;
    }
    run[part] = undefined;
    if (Object.values(run).every((value) => value === undefined)) {
      this.runs.delete(tabId);
    }
  }

  private sessionOf(tabId: string): TerminalSession | undefined {
    return this.runs.get(tabId)?.session;
  }

  /** `tet-ctl tabs-start`: starts a tab no window has fitted, at the last fit's size if any. False
   *  for a tab not waiting for its first start. */
  start(tabId: string): boolean {
    const tab = this.target.tabOf(tabId);
    if (tab?.status !== "ready" || this.sessionOf(tabId)) {
      return false;
    }
    const size = this.runs.get(tabId)?.size ?? CONTROL_START_SIZE;
    this.handleResize(tabId, size.cols, size.rows);
    return true;
  }

  /** `restartTab` for `tet-ctl tabs-restart`, which may come before any window fitted the tab. */
  restart(tabId: string): boolean {
    // A closed tab gets no run: nothing would end it.
    if (!this.target.tabOf(tabId)) {
      return false;
    }
    this.runOf(tabId).size ??= CONTROL_START_SIZE;
    return this.restartTab(tabId);
  }

  handleResize(tabId: string, cols: number, rows: number): void {
    const tab = this.target.tabOf(tabId);
    // A fit sent as its tab closed: a closed tab gets no run, nothing would end it.
    if (!tab) {
      return;
    }
    this.runOf(tabId).size = { cols, rows };
    const existing = this.sessionOf(tabId);
    if (existing) {
      existing.ensureStarted(cols, rows);
      return;
    }
    // A failed start (`error`) waits for Restart, which reads the size kept above; retried here,
    // every resize would rerun the whole setup, sbx's checks and notice included. Likewise a tab
    // opened in a terminal before its first start.
    if (tab.status === "error" || tab.openedInTerminal) {
      return;
    }
    this.startTab(tab);
  }

  /**
   * A tab's first spawn: setup, sandbox, then the process at its run's `size`, which `handleResize`
   * and `restartTab` set first.
   */
  private startTab(tab: TabState): void {
    const tabId = tab.tabId;
    const run = this.runOf(tabId);
    // Already underway; the spawn reads the newest `size`.
    if (run.starting) {
      return;
    }
    run.starting = true;
    // Released after `startSession` acquires the next one, or the bar flickers.
    this.target.indicators.acquire(tabId);
    const runtime = this.target.runtimeFor(tab.agentId);
    // A reported, unclaimed session (a fresh tab restarted right after its first prompt) is claimed
    // first so the start resumes it; otherwise the new process's report would replace it for good.
    // Before resolvePlace, which reads the `sandbox` the claim sets.
    const claimed = awaitsClaim(tab) ? runtime.ready.then(() => runtime.reconciler?.run()) : Promise.resolve();
    void claimed
      .then(() => Promise.all([runtime.ready, this.target.resolvePlace(tab, runtime)]))
      .then(async ([, place]) => {
        // Left in `error` so Restart retries: a `ready` tab gets no second fit for an unchanged
        // size (`sent` in terminal-views.ts). resolvePlace has said why.
        if (place === "stranded") {
          this.failStart(tab);
          return;
        }
        await this.writeInitialFile(tab, place);
        const launch = await place.launch(this.launchInput(tab));
        const dims = this.runs.get(tabId)?.size;
        if (!dims || !this.target.onStrip(tab) || this.sessionOf(tabId) || tab.openedInTerminal) {
          // Closed (or opened in a terminal) while the setup ran: nothing reads a copy it made.
          if (launch.handoverDir !== undefined) {
            removeHandoverCopy(launch.handoverDir);
          }
          return;
        }
        this.startSession(tab, place, launch).ensureStarted(dims.cols, dims.rows);
      })
      .catch((error: unknown) => {
        this.callbacks.onNotice("error", `${runtime.agent.displayName} could not be started: ${errorMessage(error)}`);
        // Spawned nothing; `error` offers Restart, as above.
        this.failStart(tab);
      })
      .finally(() => {
        // A leftover entry would make every later resize return as "still starting".
        this.endRun(tabId, "starting");
        this.target.indicators.release(tabId);
      });
  }

  /** The tab's `initialFile` written where `place` keeps what has no path of its own, and its prompt
   *  naming the path as the tab sees it. Refused a sight of it, the tab starts without it. */
  private async writeInitialFile(tab: TabState, place: TabPlace): Promise<void> {
    const { initialFile } = tab;
    if (!initialFile) {
      return;
    }
    const file = await writeDropFile(place.dropsDir(), initialFile.name, Buffer.from(initialFile.content));
    const [seen] = await place.handPaths([file]);
    tab.initialFile = undefined;
    tab.initialPrompt = seen === undefined ? undefined : `${initialFile.prompt} ${seen}`;
  }

  /** A start that spawned nothing leaves its tab in `error`, unless it was closed or started anew
   *  meanwhile. */
  private failStart(tab: TabState): void {
    if (this.target.onStrip(tab) && !this.sessionOf(tab.tabId)) {
      this.setTabStatus(tab, "error");
    }
  }

  private setTabStatus(tab: TabState, status: TerminalStatus): void {
    tab.status = status;
    // With the restarted process running, the old one's output is over: its kill writes a trailing "^C".
    if (status === "running" && tab.restarted) {
      tab.restarted = undefined;
      this.clearOutput(tab);
    }
    this.callbacks.onStatus(this.at.ref, tab.tabId, status);
  }

  /** What a start hands its place: this tab's arguments, its handover, where its output goes. */
  private launchInput(tab: TabState): LaunchInput {
    const { agent } = this.target.runtimeFor(tab.agentId);
    return {
      agentArgs: (files) => [...resumeArgsOf(tab, agent), ...this.promptArgs(tab, agent, files)],
      handover: tab.handover,
      onData: (data) => this.reportOutput(tab, data),
    };
  }

  /** The first prompt's arguments, a handover's naming `files` as this start sees them. */
  private promptArgs(tab: TabState, agent: AgentDefinition, files = tab.handover?.files ?? []): string[] {
    const prompt = tab.handover
      ? handoverPrompt(effectivePrompt(this.settings.get().prompts.texts, "handover"), tab.handover, files)
      : tab.initialPrompt;
    return prompt !== undefined && agent.terminal ? agent.terminal.initialPromptArgs(singleLine(prompt)) : [];
  }

  /**
   * A closed tab's session keeps printing while it quits (closeTabs lists the tab as gone first);
   * that output reaches nobody.
   */
  private reportOutput(tab: TabState, data: string): void {
    if (this.target.onStrip(tab)) {
      this.callbacks.onOutput(this.at.ref, tab.tabId, data);
    }
  }

  /** Wipes the tab's scrollback and screen with a reset (RIS), sent as output so it lands after what
   *  the session wrote last. */
  private clearOutput(tab: TabState): void {
    this.reportOutput(tab, "\x1bc");
  }

  private startSession(tab: TabState, place: TabPlace, launch: Launch): TerminalSession {
    const runtime = this.target.runtimeFor(tab.agentId);
    const { agent } = runtime;
    const tabId = tab.tabId;

    // Fresh per session, counting from zero.
    let isCliReady = agent.terminal?.createIsCliReady();
    if (isCliReady) {
      this.target.indicators.acquire(tabId);
    }
    const hideIndicator = (): void => {
      if (!isCliReady) {
        return;
      }
      // Cleared before the delay, so a second call can't queue a second release.
      isCliReady = undefined;
      setTimeout(() => this.target.indicators.release(tabId), INDICATOR_LINGER_MS);
    };

    // Given once: a restart resumes the session the prompt began.
    tab.initialPrompt = undefined;
    tab.handover = undefined;
    const moved = this.target.placeOf(tab).sandbox !== place.sandbox;
    tab.place = place;
    // A new process is in no turn; a late report of the last one may have marked a tab waiting for
    // this start (applyTurnReport's `exited` is about a process gone, not a start to come).
    if (turnMarked(tab)) {
      endTurnQuietly(tab);
      this.target.postTabs();
    }
    // The status alone posts no tabs, and the window's badge follows where the tab runs
    // (TabDescriptor.sandboxed).
    if (moved) {
      this.target.postTabs();
    }
    tab.handoverDir = launch.handoverDir ?? tab.handoverDir;

    const session = new TerminalSession(
      launch.executable,
      {
        cwd: tab.cwd ?? this.at.path,
        env: launch.env,
        // A saved command's variables, or those `sbx run -e NAME` passes on — never both, as a saved
        // command never runs in a sandbox. Over the machine's, so the sandbox gets the row's value.
        envOverride: launch.envOverride,
        // What `tet-ctl` in this tab reports as its caller — see src/shared/ctl.ts.
        own: {
          [CONTROL_ENV.projectId]: this.at.ref.projectId,
          ...(this.at.ref.worktree !== undefined && { [CONTROL_ENV.worktree]: this.at.ref.worktree }),
          [CONTROL_ENV.tabId]: tabId,
        },
        side: place.side,
        terminalEnv: this.terminalEnv,
      },
      {
        onOutput: (data) => {
          this.reportOutput(tab, data);
          if (isCliReady?.(data)) {
            hideIndicator();
          }
          // A CLI persists or updates its session shortly after producing output; a watched store
          // reports that itself.
          if (!place.sessionsWatched()) {
            runtime.reconciler?.schedule();
          }
        },
        onStatusChange: (status) => {
          // A process whose exit came after `stop()` gave up waiting may have been replaced, its tab
          // archived and reopened: its status is no longer the tab's. Nor is a tab's off the strip,
          // settled by what took it (settleWithoutProcess). The indicator and reconcile are still its.
          const current = this.target.onStrip(tab) && this.sessionOf(tabId) === session;
          if (current) {
            this.setTabStatus(tab, status);
          }
          if (status === "stopped" || status === "error" || status === "missing") {
            runtime.reconciler?.schedule();
            // A CLI killed mid-turn never reports its end.
            if (current && turnMarked(tab)) {
              endTurnQuietly(tab);
              this.target.postTabs();
            }
            // The CLI may exit before looking ready, and `markInstalled`'s "missing" spawns nothing.
            hideIndicator();
          }
        },
      },
      agent.terminal?.quitPresses ?? 0,
      launch.args,
      this.spawnProcess,
    );

    this.runOf(tabId).session = session;
    session.markInstalled(this.target.canStart(runtime));
    return session;
  }

  write(tabId: string, data: string): void {
    // Typing into the asking tab answers it: a declined one reports no `answered`, an allowed one
    // only once its tool has run. Cleared before forwarding.
    const tab = this.target.tabOf(tabId);
    if (tab?.waitingAt !== undefined && answersQuestion(data)) {
      tab.waitingAt = undefined;
      this.target.postTabs();
    }
    // A turn cut short is read off the session record (turnEndedAt): looked at soon, not after the
    // output debounce.
    if (tab?.inTurn && data === "\x1b") {
      this.target.runtimeFor(tab.agentId).reconciler?.schedule(INTERRUPT_RECONCILE_MS);
    }
    if (tab && !tab.sessionId && tab.reportedSessionId === undefined && data.includes("\r")) {
      tab.submittedAt = Date.now();
    }
    this.sessionOf(tabId)?.write(data);
  }

  /**
   * For a tab closed right after its first prompt, resolves once it named its session (bounded).
   * Codex takes the quitting Ctrl+C as an abort of a still-running `UserPromptSubmit` hook, and its
   * hooks are the only reports naming the session, which would then come back as a tab of its own.
   */
  private reportBeforeQuit(tab: TabState): Promise<void> {
    const waited = tab.submittedAt === undefined ? 0 : Date.now() - tab.submittedAt;
    if (tab.sessionId || tab.reportedSessionId !== undefined || tab.submittedAt === undefined || waited >= REPORT_WAIT_MS) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.endRun(tab.tabId, "reportWaiter");
        resolve();
      };
      const timer = setTimeout(done, REPORT_WAIT_MS - waited);
      this.runOf(tab.tabId).reportWaiter = done;
    });
  }

  /**
   * A saved command respawns in place (`TerminalSession.restart`). An agent tab with no process
   * (`stopped`, or `error` incl. a start that gave up) takes the whole start path: the sandbox and
   * its mounts may have changed outside TET, so checks, sandbox and mounts are redone and the
   * session resumed. With `running`, a running one quits first, then takes the same path. Only the
   * window asks that (the tab menu, the environment dialog), never `tabs-restart`, which would let an
   * agent end another's session or its own. A tab not fitted yet waits for its first fit. False where
   * there was nothing to restart. One whose process outlives the quit stays as it is, said in a notice.
   */
  restartTab(tabId: string, running = false): boolean {
    const tab = this.target.tabOf(tabId);
    if (!tab) {
      return false;
    }
    if (isSavedCommandTab(tab)) {
      // Its process ends in `restart()`: a running one only when the window asks.
      if (!running && tab.status === "running") {
        return false;
      }
      const session = this.sessionOf(tabId);
      if (!session) {
        return false;
      }
      tab.restarted = true;
      session.restart();
      return true;
    }
    if (!this.runs.get(tabId)?.size) {
      return false;
    }
    if (running && tab.status === "running") {
      // Asked to quit first, so its exit handlers run, then the start path below — as the
      // environment dialog's Save does it, so the tab takes up what was saved meanwhile (pty.ts).
      if (this.runs.get(tabId)?.restarting) {
        return false;
      }
      this.runOf(tabId).restarting = true;
      const session = this.sessionOf(tabId);
      void this.quit(tab).then((gone) => {
        this.endRun(tabId, "restarting");
        // Closed meanwhile, or started anew by something else: nothing left to start.
        if (!this.target.onStrip(tab) || this.sessionOf(tabId) !== session) {
          return;
        }
        if (gone === false) {
          this.noticeStillRunning(tab);
          return;
        }
        this.endRun(tabId, "session");
        tab.restarted = true;
        this.startTab(tab);
      });
      return true;
    }
    if (tab.status !== "stopped" && tab.status !== "error") {
      return false;
    }
    // `startTab` gives up on a tab that already has a session.
    this.endRun(tabId, "session");
    tab.openedInTerminal = undefined;
    tab.restarted = true;
    this.target.postTabs();
    // The status stays until the new process reports, so a start giving up again offers Restart.
    this.startTab(tab);
    return true;
  }

  /** Its process outlived a stop (TerminalSession.stop): nothing starts beside it, as two processes
   *  must not write one session. */
  private noticeStillRunning(tab: TabState): void {
    this.callbacks.onNotice("error", `The ${getAgent(tab.agentId).displayName} session is still running: try again in a moment.`);
  }

  /**
   * The tab's session resumed in the OS's own terminal, the bare CLI: none of TET's setup, so no
   * hooks and no `tet-ctl`, but the variables kept in TET. On this machine only — a sandbox's session
   * would need TET's mounts. The tab is stopped first, not closed: two processes must not write
   * one session, and a restart takes it back. One not started yet (restored, not fitted) is held
   * `stopped` the same way, or its first fit would resume the session beside the terminal's.
   */
  async openInTerminal(tabId: string): Promise<void> {
    const tab = this.target.tabOf(tabId);
    if (!tab?.sessionId || this.target.placeOf(tab).sandbox !== undefined) {
      return;
    }
    const { agent, executable } = this.target.runtimeFor(tab.agentId);
    const variables = storedEnvOf(this.terminalEnv, this.target.placeOf(tab).side);
    const session = this.sessionOf(tabId);
    // Before the terminal opens, so no fit starts the tab meanwhile.
    tab.openedInTerminal = true;
    const gone = await session?.stop();
    // Closed or archived meanwhile: the session is being deleted or kept, nothing resumes it here.
    if (!this.target.onStrip(tab)) {
      tab.openedInTerminal = undefined;
      return;
    }
    if (gone === false) {
      tab.openedInTerminal = undefined;
      this.noticeStillRunning(tab);
      return;
    }
    if (!(await openExternalTerminal(tab.cwd ?? this.at.path, executable, resumeArgsOf(tab, agent), variables))) {
      tab.openedInTerminal = undefined;
      this.callbacks.onNotice("error", `Could not open a terminal for the ${agent.displayName} session.`);
      return;
    }
    if (!session) {
      this.setTabStatus(tab, "stopped");
    }
    // The window asks before closing it (TabDescriptor.openedInTerminal).
    this.target.postTabs();
    // An intentional `stop` prints nothing of its own, so the tab says why it stopped, on a screen
    // wiped of the stopped TUI's last frame.
    this.clearOutput(tab);
    this.reportOutput(tab, "[TET] Opened in an external terminal. Restart the tab from its menu to take it back.\r\n");
  }

  /** Whether a process stands behind the tab, running or ended and not yet let go. */
  hasSession(tabId: string): boolean {
    return this.sessionOf(tabId) !== undefined;
  }

  /** Asks the tab's process to quit, once a fresh tab has named its session (reportBeforeQuit). */
  private quit(tab: TabState): Promise<boolean | undefined> {
    const session = this.sessionOf(tab.tabId);
    return this.reportBeforeQuit(tab).then(() => session?.stop());
  }

  /**
   * A tab leaving the strip, closed or archived: its fit is over, and its process is let go once it
   * quit or was given up on. Still listed until then, so a dispose meanwhile stops it. What that
   * resolves on, none where it has no process.
   */
  end(tab: TabState): Promise<void> | undefined {
    this.endRun(tab.tabId, "size");
    if (!this.hasSession(tab.tabId)) {
      return undefined;
    }
    return this.quit(tab).then(() => this.endRun(tab.tabId, "session"));
  }

  /**
   * A tab opened while its agent was missing spawned nothing (`markInstalled`), and neither a fit nor
   * Restart starts a `missing` one: its session goes, and the start runs as on a first fit.
   */
  startMissing(tab: TabState): void {
    this.endRun(tab.tabId, "session");
    this.setTabStatus(tab, "ready");
    if (this.runs.get(tab.tabId)?.size) {
      this.startTab(tab);
    }
  }

  /** A hook named the session a close or restart may be waiting on (reportBeforeQuit). */
  sessionNamed(tabId: string): void {
    this.runs.get(tabId)?.reportWaiter?.();
  }

  /** Closed: no start underway spawns, and every process is asked to stop, all at once, as each may
   *  take a grace period (TerminalSession.stop) and quit waits on this. */
  async dispose(): Promise<void> {
    for (const tabId of [...this.runs.keys()]) {
      this.endRun(tabId, "starting");
      this.endRun(tabId, "size");
    }
    await Promise.all([...this.runs.values()].flatMap(({ session }) => (session ? [session.stop()] : [])));
    this.runs.clear();
  }
}
