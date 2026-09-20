import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import type { TerminalStatus } from "../../shared/types";
import { killProcessTree, resolveCommand, spawnAgentProcess } from "./pty";
import { timeStartup } from "../event-loop-monitor";

export interface SessionCallbacks {
  onOutput: (data: string) => void;
  onStatusChange: (status: TerminalStatus) => void;
}

// Stopping writes the Ctrl+C bytes an agent quits on (`AgentDefinition.quitPresses`) before a
// kill, so the CLI runs its exit handlers. Claude Code arms a record in `~/.claude.json` while its
// fullscreen renderer boots and clears it ten seconds later; a process dying in between counts as a
// strike, and two turn fullscreen off machine-wide — a tab spawned at tet's startup is in that
// window. `\x03` is safe only because an agent TUI in raw mode reads it as a byte (measured); in
// cooked mode ConPTY makes it a CTRL_C_EVENT that kills without running anything.

/** Between two Ctrl+C bytes: long enough to be read as two keypresses (measured), short enough for
 *  the offer the second answers. */
const CTRL_C_GAP_MS = 250;
/** After the last one. Measured: Claude Code, opencode and Codex are gone well inside it. A session
 *  that read Ctrl+C as "interrupt the turn" never leaves. */
const GRACEFUL_EXIT_MS = 2000;
/** After the kill, so stopping cannot hang on a pty that never reports its exit. */
const FORCE_KILL_MS = 1000;

/** Resolves true if the process exited within `ms`, false on timeout. */
function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  // A fast exit would otherwise leave the timer running.
  return Promise.race([exited.then(() => true), timedOut]).finally(() => clearTimeout(timer));
}

/** The last answer per executable — a program installed while tet runs is not on its PATH anyway. */
const installedChecks = new Map<string, Promise<boolean>>();

/**
 * How long a version check may take before the program counts as missing. This runs before the
 * workspace opens (requirements.ts), so a check that never ends holds the whole start: generous
 * enough for a cold cmd.exe shim behind an antivirus scan, short enough to be a wait and not a
 * hang. Whatever it kills is reported as not installed — the tab then offers Restart, where a
 * start that hangs forever offers nothing.
 */
const VERSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Always spawns (the requirements re-check needs that) and remembers the answer.
 *
 * stdin is closed, as at every other spawn here: with the default pipe it stays open, and a
 * `--version` that reads a line (an interactive shim, a login prompt, cmd.exe's "Terminate batch
 * job (Y/N)?") waits for input nobody sends. stdout and stderr are ignored rather than piped —
 * nothing reads them, and an unread pipe fills and blocks the program it was meant to measure.
 */
export function checkAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  const check = new Promise<boolean>((resolve) => {
    const command = resolveCommand(executable, versionArgs);
    const child = spawn(command.command, command.args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ["ignore", "ignore", "ignore"]
    });
    let resolved = false;
    const finish = (installed: boolean) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(installed);
      }
    };
    // With its children: on win32 the program sits behind a cmd.exe that `kill()` alone would leave
    // it running under (killProcessTree).
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(false);
    }, VERSION_CHECK_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
  installedChecks.set(`${executable}\0${versionArgs.join("\0")}`, check);
  return check;
}

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
  /** Set while killing for a restart, so a second click can't queue another. */
  private restartQueued = false;
  /** The teardown underway, which a second `stop()` joins. */
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly env: Record<string, string> | undefined,
    private readonly callbacks: SessionCallbacks,
    /** How many Ctrl+C bytes this agent wants before it is killed; 0 asks for none. */
    private readonly quitPresses: number,
    private readonly args: string[] = [],
    /** A saved command's variables, outranking the machine's. */
    private readonly envOverride?: Record<string, string>,
    /** What `tet-ctl` in this tab reports as its caller (SpawnOptions.own), and whether the tab
     *  runs in a sandbox — both go into its control token. */
    private readonly caller?: { env: Record<string, string>; sandboxed: boolean }
  ) {}

  private setStatus(status: TerminalStatus): void {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  /** Settled before the first `ensureStarted`: only a "ready" session ever spawns. */
  markInstalled(installed: boolean): void {
    this.setStatus(installed ? "ready" : "missing");
  }

  /** Starts the agent on the first call, at the view's real size; afterwards forwards resizes. */
  ensureStarted(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    if (this.process) {
      // A dead pty is held until node-pty's exit event, and resizing it throws in the main process.
      try {
        this.process.resize(cols, rows);
      } catch {
        // The exit handler sets the status.
      }
      return;
    }
    this.start(cols, rows);
  }

  private start(cols: number, rows: number): void {
    // "ready" only precedes the first spawn; else a resize would respawn an exited or crashed one.
    if (this.process || this.status !== "ready") {
      return;
    }

    try {
      // Timed: node-pty's spawn is a synchronous CreateProcess/fork.
      this.process = timeStartup(`spawn ${this.executable}`, () =>
        spawnAgentProcess(this.executable, this.args, {
          cwd: this.cwd,
          cols,
          rows,
          env: this.env,
          envOverride: this.envOverride,
          own: this.caller?.env,
          sandboxed: this.caller?.sandboxed
        })
      );
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
      // By exit code, so a passed build is no error; killed by us is "stopped" whatever the code.
      this.setStatus(this.intentionalStop || exitCode === 0 ? "stopped" : "error");
      this.intentionalStop = false;
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  /** Resolves once the process is gone, not once a kill was asked for: `destroyTab` deletes what the
   *  session persisted and must not race it. Asks to quit first (see the Ctrl+C comment above). */
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
    // Before the first write: `start`'s exit handler reads it to tell "stopped" from a failure.
    this.intentionalStop = true;
    // node-pty's onExit is multicast; this one only observes, `start`'s clears and sets status.
    const exited = new Promise<void>((resolve) => {
      proc.onExit(() => resolve());
    });

    for (let press = 0; press < this.quitPresses; press += 1) {
      this.writeQuit(proc);
      // Return on exit so no byte reaches an agent already leaving: Codex drops raw mode as it
      // goes, and a second byte lands as CTRL_C_EVENT and kills the shutdown.
      const last = press === this.quitPresses - 1;
      if (await exitedWithin(exited, last ? GRACEFUL_EXIT_MS : CTRL_C_GAP_MS)) {
        return;
      }
    }

    try {
      proc.kill();
    } catch (error) {
      console.error(`[tet] failed to kill ${this.executable}:`, error);
    }
    await exitedWithin(exited, FORCE_KILL_MS);
  }

  private writeQuit(proc: IPty): void {
    try {
      proc.write("\x03");
    } catch {
      // Died meanwhile: the exit race decides.
    }
  }

  /** Kills and respawns at the same size, on the old process's exit: `start`'s handler clears
   *  `this.process`, and firing late it would clobber an immediate respawn. No-op before the first
   *  `ensureStarted`. */
  restart(): void {
    if (this.lastCols === undefined || this.lastRows === undefined || this.restartQueued) {
      return;
    }
    const cols = this.lastCols;
    const rows = this.lastRows;
    const respawn = (): void => {
      this.restartQueued = false;
      // A `stop()` mid-kill wins: a process spawned now would never be killed.
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
        // Already gone; `respawn` runs from its exit.
        console.error(`[tet] failed to kill ${this.executable}:`, error);
      }
    } else {
      respawn();
    }
  }
}
