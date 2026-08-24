import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /**
   * Environment variables that win over the machine's own, unlike `env` above. A saved
   * command's are the only ones: the user wrote them next to the command, so a variable of
   * the same name already in the environment is not what that command asked for.
   */
  envOverride?: Record<string, string>;
  /**
   * tet's own variables for this one process — the project and tab it belongs to, for the
   * control channel (`TET_PROJECT_ID`, `TET_TAB_ID`). Above the machine's like `controlEnv`,
   * see there.
   */
  own?: Record<string, string>;
}

/**
 * What every pty gets from tet itself, set once from main.ts (the control channel's socket and
 * token, and the launcher directory on PATH). Layered *above* `process.env` rather than below:
 * tet started from one of its own shell tabs (`npm start`, while developing) inherits the
 * outer app's values in `process.env`, and its terminals must reach the inner one.
 *
 * Kept here rather than written into `process.env`, so only the terminals carry it — not the
 * opencode server, git, or anything else main.ts spawns with the machine's environment.
 */
let controlEnv: Record<string, string> = {};
/** Prepended to every terminal's PATH — where the `tet-ctl` launchers are. */
let launcherDir: string | undefined;

export function setControlEnv(vars: Record<string, string>, binDir: string): void {
  controlEnv = vars;
  launcherDir = binDir;
}

/**
 * The name PATH goes under in `env`, whatever case it has: win32 stores it as `Path`, and a
 * second key of another case would be one more variable rather than a replacement.
 */
function pathKey(env: Record<string, string>): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

const WIN32_NATIVE_EXTENSIONS = [".exe", ".com"];

/**
 * node-pty spawns via CreateProcessW on win32, which does not apply PATHEXT resolution and
 * cannot launch ".cmd"/".bat"/".ps1" shims directly. Returns the resolved path of a native
 * executable where there is one, so the caller can spawn it without a shell wrapper — or
 * undefined where `executable` only resolves to a shim (or not at all), which still needs the
 * cmd.exe wrapper.
 */
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
    // Shim (.cmd/.bat/.ps1) or unresolved: route through cmd.exe to resolve and launch
    // it reliably. This avoids relying on `shell: true`, which concatenates args into
    // an unescaped command string.
    //
    // A path with a space in it (Codex's launcher under a `C:\Users\John Doe\...` userData)
    // gets `call` in front: node-pty quotes it, and `/s` has cmd strip the first and last
    // quote of everything after `/c` when it *starts* with one — leaving `C:\Users\John` as
    // the command (measured). `call` makes the first character a `c`, so nothing is stripped
    // and the quoted path is resolved as such. Only then, so the npm-shim path measured for
    // the hooks' quoting stays exactly as it was.
    const invoke = /\s/.test(executable) ? ["call", executable] : [executable];
    return { command: "cmd.exe", args: ["/d", "/s", "/c", ...invoke, ...args] };
  }
  return { command: executable, args };
}

/**
 * What a terminal's process is started with. options.env are defaults, not overrides: a
 * variable the user already has set (e.g. their own OPENCODE_TUI_CONFIG) must win, or we'd
 * silently replace their own configuration. tet's own (controlEnv, options.own) come after the
 * machine's — see controlEnv — and a saved command's (envOverride) after everything: the user
 * wrote those next to the command. Its own function so the layering has a test without a pty.
 */
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
    // Windows-only field (node-pty ignores it on Linux/macOS): use the OpenConsole/conpty.dll
    // shipped with node-pty instead of the one built into Windows - the same one VS Code's own
    // integrated terminal uses, and more actively maintained than the inbox conhost.exe.
    useConptyDll: true
  });
}
