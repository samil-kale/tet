import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { CONTROL_ENV } from "../../shared/control";
import { tabControlToken } from "../control/control-token";

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

/** PATH's key in `env` — win32's `Path`; a key in another case would be a second variable. */
export function pathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

const WIN32_NATIVE_EXTENSIONS = [".exe", ".com"];

/** node-pty's CreateProcessW applies no PATHEXT and cannot launch .cmd/.bat/.ps1 shims. The native
 *  executable's path, or undefined where only a shim (or nothing) resolves and cmd.exe is needed. */
function resolveWin32NativeExecutable(executable: string): string | undefined {
  const ext = path.extname(executable).toLowerCase();
  if (WIN32_NATIVE_EXTENSIONS.includes(ext)) {
    return executable;
  }
  if (ext) {
    return undefined;
  }

  const dir = path.dirname(executable);
  const searchDirs = dir !== "." ? [dir] : (process.env.PATH ?? "").split(path.delimiter);
  for (const searchDir of searchDirs) {
    for (const nativeExt of WIN32_NATIVE_EXTENSIONS) {
      const candidate = path.join(searchDir, executable + nativeExt);
      if (fs.existsSync(candidate)) {
        return candidate;
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

/** Every character cmd.exe gives a meaning, `^`-escaped — cross-spawn's `lib/util/escape.js`. */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a program behind cmd.exe: quoted by the C runtime's rules (qntm.org/cmd), then
 *  `^`-escaped, so `&`, `>` or `%VAR%` reach it literally (measured through an npm shim, via
 *  child_process and node-pty). */
function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`;
  return quoted.replace(CMD_META_CHARS, "^$1");
}

/** Where a command line goes, for every spawn: on win32 a native executable directly, a shim or an
 *  unresolved name through cmd.exe; elsewhere unchanged. */
export function resolveCommand(executable: string, args: string[]): ResolvedCommand {
  if (process.platform === "win32") {
    const native = resolveWin32NativeExecutable(executable);
    if (native) {
      return { command: native, args };
    }
    // Shim or unresolved: cmd.exe, not `shell: true`, which joins args unescaped. The whole line is
    // escaped as cross-spawn does it; `/s` strips only the outer quotes.
    const line = [executable.replace(CMD_META_CHARS, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
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

/** A terminal's env: options.env as defaults under the machine's (the user's value wins), then
 *  tet's own (controlEnv, options.own) with the tab's own control token in place of the run's
 *  (control-token.ts), then a saved command's envOverride. Testable without a pty. */
export function buildEnv(options: Pick<SpawnOptions, "env" | "envOverride" | "own">): Record<string, string> {
  const env: Record<string, string> = {
    ...options.env,
    ...(process.env as Record<string, string>),
    ...controlEnv,
    ...options.own
  };
  const runToken = controlEnv[CONTROL_ENV.token];
  if (runToken) {
    env[CONTROL_ENV.token] = tabControlToken(runToken, env[CONTROL_ENV.projectId] ?? "", env[CONTROL_ENV.tabId] ?? "");
  }
  if (launcherDir) {
    const key = pathKey(env);
    env[key] = env[key] ? `${launcherDir}${path.delimiter}${env[key]}` : launcherDir;
  }
  // win32 names ignore case, and of `Path` and `PATH` together the child sees the inherited one
  // (measured through node-pty) — so an override replaces its name in any spelling.
  if (process.platform === "win32") {
    const names = new Set(Object.keys(options.envOverride ?? {}).map((name) => name.toUpperCase()));
    for (const name of Object.keys(env).filter((name) => names.has(name.toUpperCase()))) {
      delete env[name];
    }
  }
  return Object.assign(env, options.envOverride);
}

export function spawnAgentProcess(executable: string, args: string[], options: SpawnOptions): IPty {
  const env = buildEnv(options);
  // A path is the tab's folder's, as child_process takes it; node-pty looks from this process's
  // (measured on win32: "File not found" for a relative `bin\tool.exe`). A bare name stays a search.
  const program = path.basename(executable) === executable ? executable : path.resolve(options.cwd, executable);
  const resolved = resolveCommand(program, args);

  return pty.spawn(resolved.command, resolved.windowsVerbatimArguments ? resolved.args.join(" ") : resolved.args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env,
    // Windows only: node-pty's bundled conpty.dll is maintained better than the inbox conhost.exe.
    useConptyDll: true
  });
}
