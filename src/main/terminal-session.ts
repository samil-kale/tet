import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import type { TerminalStatus } from "../shared/types";
import { resolveCommand, spawnAgentProcess } from "./pty";

export interface SessionCallbacks {
  onOutput: (data: string) => void;
  onStatusChange: (status: TerminalStatus) => void;
}

/**
 * Ending an agent asks it to quit before killing it, by writing the Ctrl+C bytes its own quit
 * convention expects (`AgentDefinition.quitPresses`) — a CLI that exits by itself gets to run
 * its exit handlers, one hard kill never does. What that buys, concretely: Claude Code arms a
 * record in `~/.claude.json` while its fullscreen renderer boots and clears it again ten
 * seconds later, counting every process that died in between as a strike against the renderer —
 * twice, and it turns fullscreen off machine-wide. Restarting tet is exactly what killed those,
 * since a tab spawned at startup is inside that window.
 *
 * `\x03` is only safe here because an agent TUI is in raw mode by then and reads it as an
 * ordinary byte — measured, not assumed. In cooked mode (a plain shell, the moment before a TUI
 * starts, or one already on its way out) ConPTY turns the same byte into a process-level
 * CTRL_C_EVENT that kills without running anything. Hence exactly the count the agent asked for
 * and no more, and a straight kill for one that asked for none.
 */
/** Between two Ctrl+C bytes. Only long enough that the first is read as its own keypress — 80ms
 *  still was, measured — since the offer the second answers is withdrawn after about a second. */
const CTRL_C_GAP_MS = 250;
/** After the last one. Measured through this same pty: opencode is gone in ~150ms, Codex in
 *  ~400ms, Claude Code in ~650ms. A session that read Ctrl+C as "interrupt the turn" instead
 *  never leaves at all, and waiting past this only delays the kill it actually needs. */
const GRACEFUL_EXIT_MS = 2000;
/** After the kill, so stopping cannot hang on a pty that never reports its exit. */
const FORCE_KILL_MS = 1000;

/** Resolves true if the process exited within `ms`, false on timeout. */
function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  // Whichever loses the race leaves its timer behind otherwise, and a fast exit is the common case.
  return Promise.race([exited.then(() => true), timedOut]).finally(() => clearTimeout(timer));
}

/**
 * The last answer per executable. Whether a CLI is installed is a fact about the machine, not
 * about a project, and a program installed while the app runs is not on this process's PATH
 * anyway — so every project opened after the first takes the answer already given, instead of
 * spawning `--version` for every agent again (on win32 through cmd.exe, two processes each).
 */
const installedChecks = new Map<string, Promise<boolean>>();

/** Always spawns the check — what the requirements dialog's re-check needs — and remembers the answer. */
export function checkAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  const check = new Promise<boolean>((resolve) => {
    const { command, args } = resolveCommand(executable, versionArgs);
    const process = spawn(command, args, { cwd, windowsHide: true });
    let resolved = false;
    const finish = (installed: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(installed);
      }
    };
    process.on("error", () => finish(false));
    process.on("exit", (code) => finish(code === 0));
  });
  installedChecks.set(`${executable}\0${versionArgs.join("\0")}`, check);
  return check;
}

/** The remembered answer where there is one, otherwise the check. */
export function isAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  return installedChecks.get(`${executable}\0${versionArgs.join("\0")}`) ?? checkAgentInstalled(executable, versionArgs, cwd);
}

/** One agent process behind one tab: spawned lazily, at the size the view actually has. */
export class TerminalSession {
  private process: IPty | undefined;
  private status: TerminalStatus = "missing";
  private intentionalStop = false;
  /** The size of the last `ensureStarted` call — what `restart` respawns at. */
  private lastCols: number | undefined;
  private lastRows: number | undefined;
  /** Set while a running process is being killed for a restart, so a second click can't queue another. */
  private restartQueued = false;
  /** The teardown underway, so a second `stop()` joins it rather than starting its own. */
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly env: Record<string, string> | undefined,
    private readonly callbacks: SessionCallbacks,
    /** How many Ctrl+C bytes this agent wants before it is killed; 0 asks for none. */
    private readonly quitPresses: number,
    private readonly args: string[] = [],
    /** A saved command's own variables, which outrank the ones inherited from the machine. */
    private readonly envOverride?: Record<string, string>,
    /** tet's own for this process — which project and tab it is; see SpawnOptions.own. */
    private readonly own?: Record<string, string>
  ) {}

  private setStatus(status: TerminalStatus): void {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  /** Settled before the first `ensureStarted`: only a "ready" session ever spawns. */
  markInstalled(installed: boolean): void {
    this.setStatus(installed ? "ready" : "missing");
  }

  /**
   * Called with the terminal's real dimensions (from the renderer). Starts the agent on the
   * first call, so it never renders for a size the view does not have; afterwards it only
   * forwards resizes.
   */
  ensureStarted(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    if (this.process) {
      // A pty that has just died is still held here until node-pty's own exit event arrives,
      // and resizing one throws rather than reporting anything — which took the whole main
      // process with it. A saved command whose program does not exist dies inside exactly that
      // window: it is spawned by the first resize and gone before the second one lands.
      try {
        this.process.resize(cols, rows);
      } catch {
        // The exit handler is on its way and is what sets the status; there is nothing to do
        // for a size the process will never draw at.
      }
      return;
    }
    this.start(cols, rows);
  }

  private start(cols: number, rows: number): void {
    // "ready" is the state a session is in before its first spawn and never again: after one
    // it is running, and once the process is gone it is stopped or errored. Without that
    // check any later resize — switching tabs is one — would spawn a second process for a
    // terminal the user closed with `exit`, or bring a crashed agent back unasked.
    if (this.process || this.status !== "ready") {
      return;
    }

    try {
      this.process = spawnAgentProcess(this.executable, this.args, {
        cwd: this.cwd,
        cols,
        rows,
        env: this.env,
        envOverride: this.envOverride,
        own: this.own
      });
    } catch (error) {
      console.error(`[tet] failed to spawn ${this.executable}:`, error);
      this.callbacks.onOutput(`\r\n[tet] failed to spawn ${this.executable}:\r\n${String(error)}\r\n`);
      this.setStatus("error");
      return;
    }

    this.setStatus("running");
    this.process.onData((data) => this.callbacks.onOutput(data));
    this.process.onExit(({ exitCode }) => {
      this.process = undefined;
      if (!this.intentionalStop) {
        this.callbacks.onOutput(`\r\n[tet] ${this.executable} exited with code ${exitCode}\r\n`);
      }
      // What the process said, not merely that it is gone: a saved command ends by itself every
      // time it is run, and a build that passed is not an error. Killed by us is "stopped"
      // whatever the code, since that code is our doing rather than the command's.
      this.setStatus(this.intentionalStop || exitCode === 0 ? "stopped" : "error");
      this.intentionalStop = false;
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  /**
   * Ends the process and resolves once it is actually gone — not merely once a kill was asked
   * for, since a caller deleting what the session persisted (`destroyTab`) must not race a
   * process still writing it. Every agent is asked to quit first (see the Ctrl+C comment at the
   * top of this file); the shell is killed outright, having nothing to save and no handler for
   * the byte anyway.
   */
  stop(): Promise<void> {
    this.stopping ??= this.runStop().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async runStop(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      return;
    }
    // Before the first write, not after: whichever way the process ends from here — its own exit
    // on Ctrl+C, or the kill below — is our doing, and `start`'s exit handler reads this to tell
    // "stopped" from a process that failed on its own.
    this.intentionalStop = true;
    // A second listener beside the one `start` registered; node-pty's onExit is multicast and
    // `restart` already relies on that. It only observes — clearing `this.process` and setting
    // the status stay with the primary handler.
    const exited = new Promise<void>((resolve) => {
      proc.onExit(() => resolve());
    });

    for (let press = 0; press < this.quitPresses; press += 1) {
      this.writeQuit(proc);
      // The last press gets the long wait; the ones before it only wait long enough to be told
      // apart as keypresses. Returning early on an exit is what keeps a byte from reaching an
      // agent that is already leaving, where it would kill what we asked for — Codex gives up
      // raw mode as it goes, so a second one lands as a CTRL_C_EVENT instead.
      const last = press === this.quitPresses - 1;
      if (await exitedWithin(exited, last ? GRACEFUL_EXIT_MS : CTRL_C_GAP_MS)) {
        return;
      }
    }

    try {
      proc.kill();
    } catch (error) {
      // Already gone, most likely — its exit is on its way and there is nothing else to try.
      console.error(`[tet] failed to kill ${this.executable}:`, error);
    }
    await exitedWithin(exited, FORCE_KILL_MS);
  }

  private writeQuit(proc: IPty): void {
    try {
      proc.write("\x03");
    } catch {
      // A pty that died between the two writes: the exit race decides what happens next.
    }
  }

  /**
   * Kills the current process, if any, and spawns it again at the same size once it is gone —
   * a saved command run once more in the tab it already has. Registered on the process's own
   * exit rather than spawning right away: `start`'s exit handler is what clears `this.process`,
   * and an immediate second spawn would have its own reference clobbered by that handler firing
   * late. No-op before the first `ensureStarted`, since there is no size to respawn at yet.
   */
  restart(): void {
    if (this.lastCols === undefined || this.lastRows === undefined || this.restartQueued) {
      return;
    }
    const cols = this.lastCols;
    const rows = this.lastRows;
    const respawn = (): void => {
      this.restartQueued = false;
      // A `stop()` that landed while the kill was underway wins: the tab is being closed, and
      // a process spawned now would belong to nothing and never be killed.
      if (this.stopping) {
        return;
      }
      this.setStatus("ready");
      this.start(cols, rows);
    };
    if (this.process) {
      this.restartQueued = true;
      this.intentionalStop = true;
      this.process.onExit(respawn);
      try {
        this.process.kill();
      } catch (error) {
        // Already gone; its exit is on its way and `respawn` runs from there.
        console.error(`[tet] failed to kill ${this.executable}:`, error);
      }
    } else {
      respawn();
    }
  }
}
