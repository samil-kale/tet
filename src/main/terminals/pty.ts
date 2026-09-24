import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { CONTROL_ENV } from "../../shared/control";
import { tabControlToken } from "../control/control-token";
import { KEPT_ENV_NAME } from "../env-names";

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Variables that win over the machine's own, unlike `env` — only a saved command's. */
  envOverride?: Record<string, string>;
  /** This process's project and tab for the control channel (`TET_PROJECT_ID`, `TET_TAB_ID`).
   *  Above the machine's, like `controlEnv`. */
  own?: Record<string, string>;
  /** The tab runs in an sbx sandbox. Part of its control token, which is what the control server
   *  reads it back off (control-token.ts). */
  sandboxed?: boolean;
}

/** The control channel's port and token, set from main.ts. Above `process.env`, since a tet started
 *  from its own shell tab inherits the outer one's; kept out of it so git does not carry them. */
let controlEnv: Record<string, string> = {};
/** Prepended to every terminal's PATH — where the `tet-ctl` launchers are. */
let launcherDir: string | undefined;

export function setControlEnv(vars: Record<string, string>, binDir: string | undefined): void {
  controlEnv = vars;
  launcherDir = binDir;
}

/** The environment variables the user keeps in tet (environment.ts), read at every spawn so a
 *  restarted tab sees what was saved meanwhile. */
let storedEnv: () => Record<string, string> = () => ({});

export function setStoredEnv(provider: () => Record<string, string>): void {
  storedEnv = provider;
}

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
  const ext = path.extname(executable).toLowerCase();
  if (ext) {
    return WIN32_EXTENSIONS.includes(ext) ? { path: executable, batch: WIN32_BATCH_EXTENSIONS.includes(ext) } : undefined;
  }

  const dir = path.dirname(executable);
  const searchDirs = dir !== "." ? [dir] : (process.env.PATH ?? "").split(path.delimiter);
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

interface ResolvedCommand {
  command: string;
  args: string[];
  /** The args are one escaped cmd.exe line: pass as `windowsVerbatimArguments` to child_process,
   *  joined with spaces to node-pty (which takes a string as the command line as is). */
  windowsVerbatimArguments?: true;
}

/** Every character cmd.exe gives a meaning, `^`-escaped — cross-spawn's `lib/util/escape.js`. */
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

/** One argument for a program behind cmd.exe: quoted by the C runtime's rules (qntm.org/cmd), then
 *  `^`-escaped, so `&`, `>` or `%VAR%` reach it literally (measured through an npm shim, via
 *  child_process and node-pty). A shim parses its `%*` a second time, so there it is escaped twice:
 *  once, `a"&b` ends the quote cmd.exe sees and `&b` runs as a command. Only there — a batch file
 *  reading `%~1` itself keeps the second carets (Maven's `if "%~1" == "-f"`: a syntax error). */
function escapeCmdArgument(arg: string, shim: boolean): string {
  const quoted = `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`;
  const escaped = quoted.replace(CMD_META_CHARS, "^$1");
  return shim ? escaped.replace(CMD_META_CHARS, "^$1") : escaped;
}

/** Where a command line goes, for every agent, shell and `sbx` spawn: on win32 a native executable directly, a shim or an
 *  unresolved name through cmd.exe; elsewhere unchanged. */
export function resolveCommand(executable: string, args: string[]): ResolvedCommand {
  if (process.platform === "win32") {
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
  if (process.platform === "win32" && child.pid !== undefined) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    child.kill();
  }
}

/** Deletes from `env` the variables `names` replace, and returns it: on win32 names ignore case, a
 *  name in another case would be a second variable, and of the two the child sees the inherited one
 *  (measured through node-pty) — so a replacement removes its name in any spelling. */
function withoutNames(env: Record<string, string>, names: string[]): Record<string, string> {
  if (process.platform === "win32") {
    const replaced = new Set(names.map((name) => name.toUpperCase()));
    for (const name of Object.keys(env).filter((key) => replaced.has(key.toUpperCase()))) {
      delete env[name];
    }
  }
  return env;
}

/** A terminal's env: options.env as defaults under the machine's (the user's value wins), the
 *  variables kept in tet over it (none in a sandbox), then tet's own (controlEnv, options.own) with
 *  the tab's own control token in place of the run's (control-token.ts), then a saved command's
 *  envOverride. Testable without a pty. */
export function buildEnv(options: Pick<SpawnOptions, "env" | "envOverride" | "own" | "sandboxed">): Record<string, string> {
  const stored = options.sandboxed ? {} : storedEnv();
  const env: Record<string, string> = {
    ...options.env,
    ...withoutNames({ ...(process.env as Record<string, string>) }, Object.keys(stored)),
    ...stored,
    ...controlEnv,
    ...options.own
  };
  // Never an outer tet's: this tab got exactly `stored`.
  delete env[KEPT_ENV_NAME];
  if (Object.keys(stored).length > 0) {
    env[KEPT_ENV_NAME] = Object.keys(stored).join(",");
  }
  const runToken = controlEnv[CONTROL_ENV.token];
  if (runToken) {
    env[CONTROL_ENV.token] = tabControlToken(
      runToken,
      env[CONTROL_ENV.projectId] ?? "",
      env[CONTROL_ENV.tabId] ?? "",
      options.sandboxed === true
    );
  }
  if (launcherDir) {
    const key = pathKey(env);
    env[key] = env[key] ? `${launcherDir}${path.delimiter}${env[key]}` : launcherDir;
  }
  return Object.assign(withoutNames(env, Object.keys(options.envOverride ?? {})), options.envOverride);
}

/**
 * node-pty leaves the pipe it writes into unguarded: `windowsTerminal.js` puts an `error` listener
 * on the pipe it reads from, `windowsPtyAgent.js` puts none on `inSocket`. A write landing after the
 * process behind it has gone — a tab closed, a quit, a resize on the way out — then fails with
 * nothing listening, which is an uncaught `write EAGAIN` and, through uncaught.ts, a notice telling
 * the user TET hit an unexpected error. There is nothing to do about the write itself; those bytes
 * had nowhere to go. Measured on win32 through test/app.test.ts, which fails a run on any uncaught
 * exception. POSIX has no `_agent` and node-pty guards its socket there, so this is a no-op.
 */
function guardPtyInput(spawned: IPty): void {
  const agent = (spawned as unknown as { _agent?: { inSocket?: { on?: (event: string, listener: () => void) => void } } })._agent;
  agent?.inSocket?.on?.("error", () => undefined);
}

export function spawnAgentProcess(executable: string, args: string[], options: SpawnOptions): IPty {
  const env = buildEnv(options);
  // A path is the tab's folder's, as child_process takes it; node-pty looks from this process's
  // (measured on win32: "File not found" for a relative `bin\tool.exe`). A bare name stays a search.
  const program = path.basename(executable) === executable ? executable : path.resolve(options.cwd, executable);
  const resolved = resolveCommand(program, args);

  const spawned = pty.spawn(resolved.command, resolved.windowsVerbatimArguments ? resolved.args.join(" ") : resolved.args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env,
    // Windows only: node-pty's bundled conpty.dll is maintained better than the inbox conhost.exe.
    useConptyDll: true
  });
  guardPtyInput(spawned);
  return spawned;
}
