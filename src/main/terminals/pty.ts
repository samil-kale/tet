import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

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

export function resolveCommand(executable: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const native = resolveWin32NativeExecutable(executable);
    if (native) {
      return { command: native, args };
    }
    // Shim or unresolved: cmd.exe, not `shell: true`, which joins args unescaped. A path with a space
    // gets `call` in front: node-pty quotes it, and `/s` strips a leading and trailing quote after
    // `/c`, leaving `C:\Users\John` as the command (measured). Only then, so the measured npm-shim
    // invocation is unchanged.
    const invoke = /\s/.test(executable) ? ["call", executable] : [executable];
    return { command: "cmd.exe", args: ["/d", "/s", "/c", ...invoke, ...args] };
  }
  return { command: executable, args };
}

/** A terminal's env: options.env as defaults under the machine's (the user's value wins), then
 *  tet's own (controlEnv, options.own), then a saved command's envOverride. Testable without a pty. */
export function buildEnv(options: Pick<SpawnOptions, "env" | "envOverride" | "own">): Record<string, string> {
  const env: Record<string, string> = {
    ...options.env,
    ...(process.env as Record<string, string>),
    ...controlEnv,
    ...options.own
  };
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
  const { command, args: resolvedArgs } = resolveCommand(executable, args);

  return pty.spawn(command, resolvedArgs, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env,
    // Windows only: node-pty's bundled conpty.dll is maintained better than the inbox conhost.exe.
    useConptyDll: true
  });
}
