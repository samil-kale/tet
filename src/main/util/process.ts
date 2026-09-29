import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logError } from "./error-log";
import { PLATFORM } from "./host-platform";

/** PATH's key in `env` — win32's `Path`; a key in another case would be a second variable. */
export function pathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

const WIN32_NATIVE_EXTENSIONS = [".exe", ".com"];
const WIN32_BATCH_EXTENSIONS = [".cmd", ".bat"];
const WIN32_EXTENSIONS = [...WIN32_NATIVE_EXTENSIONS, ...WIN32_BATCH_EXTENSIONS];

/**
 * What `executable` names, searched in its folder or else along PATH, and whether it is a batch
 * file: node-pty's CreateProcessW applies no PATHEXT and cannot launch a .cmd/.bat/.ps1 shim, so
 * only a native one is spawned directly. Every extension is tried per folder before the next
 * folder, as cmd.exe resolves a name — a `.cmd` earlier on PATH beats an `.exe` later, and a shim
 * put in front of a program is what runs. Undefined where nothing (or only a .ps1) resolves.
 */
function resolveWin32Executable(executable: string): { path: string; batch: boolean } | undefined {
  const pathDirs = (): string[] => (process.env.PATH ?? "").split(path.delimiter);
  const ext = path.extname(executable).toLowerCase();
  if (ext) {
    if (!WIN32_EXTENSIONS.includes(ext)) {
      return undefined;
    }
    // A bare `npm.cmd` is found along PATH too, or isCmdShim would read it in this process's folder
    // and miss the shim. Unfound, it stays the name, for CreateProcessW or cmd.exe to look up.
    const found = path.basename(executable) === executable ? pathDirs().map((dir) => path.join(dir, executable)).find((candidate) => fs.existsSync(candidate)) : undefined;
    return { path: found ?? executable, batch: WIN32_BATCH_EXTENSIONS.includes(ext) };
  }

  const dir = path.dirname(executable);
  const searchDirs = dir !== "." ? [dir] : pathDirs();
  for (const searchDir of searchDirs) {
    for (const extension of WIN32_EXTENSIONS) {
      const candidate = path.join(searchDir, path.basename(executable) + extension);
      if (fs.existsSync(candidate)) {
        return { path: candidate, batch: WIN32_BATCH_EXTENSIONS.includes(extension) };
      }
    }
  }
  return undefined;
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  /** The args are one escaped cmd.exe line: pass as `windowsVerbatimArguments` to child_process,
   *  joined with spaces to node-pty (which takes a string as the command line as is). */
  windowsVerbatimArguments?: true;
}

/** Every character cmd.exe gives a meaning, `^`-escaped. */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** The line of an npm, pnpm or yarn cmd-shim that runs the package: a script by its path beside the
 *  shim (`"%dp0%\…"`, `"%~dp0\…"`), then `%*`. Recognized by content, since a global shim
 *  (`%APPDATA%\npm`) lies outside cross-spawn's `node_modules\.bin`. */
const CMD_SHIM_LINE = /"%(?:dp0%|~dp0)[^"\r\n]*"[ \t]*%\*[ \t]*$/im;

function isCmdShim(file: string): boolean {
  try {
    return CMD_SHIM_LINE.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** One argument for a program behind cmd.exe: quoted by the C runtime's rules, then `^`-escaped, so
 *  `&`, `>` or `%VAR%` reach it literally. A shim parses its `%*` a second time, so there it is
 *  escaped twice:
 *  once, `a"&b` ends the quote cmd.exe sees and `&b` runs as a command. Only there — a batch file
 *  reading `%~1` itself keeps the second carets (Maven's `if "%~1" == "-f"`: a syntax error). */
function escapeCmdArgument(arg: string, shim: boolean): string {
  // Every backslash before a quote, or before the closing one, doubled: the C runtime halves a run.
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const escaped = quoted.replace(CMD_META_CHARS, "^$1");
  return shim ? escaped.replace(CMD_META_CHARS, "^$1") : escaped;
}

/** Where a command line goes, for every agent, shell and `sbx` spawn: on win32 a native executable directly, a shim or an
 *  unresolved name through cmd.exe; elsewhere unchanged. */
export function resolveCommand(executable: string, args: string[]): ResolvedCommand {
  if (PLATFORM.spawnsThroughCmd) {
    const resolved = resolveWin32Executable(executable);
    if (resolved && !resolved.batch) {
      return { command: resolved.path, args };
    }
    // Shim or unresolved: cmd.exe, not `shell: true`, which joins args unescaped. The whole line is
    // escaped as cross-spawn does it; `/s` strips only the outer quotes.
    const shim = resolved !== undefined && isCmdShim(resolved.path);
    const line = [executable.replace(CMD_META_CHARS, "^$1"), ...args.map((arg) => escapeCmdArgument(arg, shim))].join(" ");
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
  }
  return { command: executable, args };
}

/** Kills a process `resolveCommand` started, with its children: on win32 `kill()` would end only the
 *  cmd.exe in front of a shim, while the program keeps running (and its pipes open). */
export function killProcessTree(child: ChildProcess): void {
  if (PLATFORM.killsWithTaskkill && child.pid !== undefined) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    child.kill();
  }
}

export interface RunProcessOptions {
  cwd?: string;
  /** Written to stdin, then closed. Without it stdin is closed from the start, so a command waiting
   *  on it fails rather than waits for input nobody sends. */
  stdin?: string;
  /** Past this the process is killed with its children and the run answers at once, `timedOut`. */
  timeoutMs?: number;
  /** Every stdout and stderr chunk as it arrives, in arrival order. */
  onData?: (chunk: string) => void;
  /** Handed the process once started, e.g. to kill it on a Cancel. */
  onSpawn?: (child: ChildProcess) => void;
  /** Neither pipe is opened: nothing is read, so a grandchild inheriting them cannot hold the run
   *  open, and an unread pipe cannot fill and block the program. */
  ignoreOutput?: boolean;
}

export interface ProcessResult {
  /** The exit code; null when the process could not start, died of a signal or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why the process could not be started. */
  error?: Error;
}

/** One run at a time a dialog's Cancel may kill (the renderer's `DialogFrame` `abort`). */
export interface Stoppable {
  /** Runs `start`, whose process — handed to the `onSpawn` it is given — `stop` kills until it ends. */
  run<T>(start: (onSpawn: (child: ChildProcess) => void) => Promise<T>): Promise<T>;
  /** Kills the running one with its children (killProcessTree); a no-op when none runs. */
  stop(): void;
}

export function stoppable(): Stoppable {
  let current: ChildProcess | undefined;
  return {
    async run(start) {
      let own: ChildProcess | undefined;
      try {
        return await start((child) => {
          own = current = child;
        });
      } finally {
        if (own && current === own) {
          current = undefined;
        }
      }
    },
    stop() {
      if (current) {
        killProcessTree(current);
        current = undefined;
      }
    }
  };
}

/**
 * Runs a command to completion through `resolveCommand`, without a shell, and never rejects. It
 * answers on `close`, once every pipe is drained, so no output is cut off. The timeout does not wait
 * for that: a child the program started can hold the pipes open past its end. Killed with its
 * children, as on win32 `kill()` would end only the cmd.exe in front of a shim (killProcessTree).
 * A timeout and a start that fails are logged; an exit code is the caller's to judge.
 */
export function runProcess(executable: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const resolved = resolveCommand(executable, args);
    const output = options.ignoreOutput ? "ignore" : "pipe";
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", output, output]
    });
    options.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    // Decoded per stream, so a character split across two chunks stays whole.
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      options.onData?.(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      options.onData?.(chunk);
    });
    let settled = false;
    const finish = (result: Omit<ProcessResult, "stdout" | "stderr">): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, stdout, stderr });
      }
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killProcessTree(child);
            logError(`${executable} ${args.join(" ")} timed out after ${options.timeoutMs}ms`);
            finish({ code: null, timedOut: true });
          }, options.timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => {
      // A missing program is an answer (not installed), not a failure.
      if (error.code !== "ENOENT") {
        logError(`${executable} ${args.join(" ")} could not start`, error);
      }
      finish({ code: null, timedOut: false, error });
    });
    child.on("close", (code) => finish({ code, timedOut: false }));
    if (options.stdin !== undefined) {
      // A command gone before reading it fails the write (EPIPE); unhandled, that stream error
      // raises Electron's modal crash dialog. The exit reports the failure.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}
