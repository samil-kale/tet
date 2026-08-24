import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where the agents actually land, added to this process's PATH once at startup so tet finds
 * one installed after tet's own launcher was set on PATH — and, more to the point, one installed
 * to a place the PATH tet inherited never had. Both halves of tet read `process.env.PATH`: the
 * startup check spawns `<agent> --version` (requirements.ts → checkAgentInstalled), and every
 * terminal derives its env from `process.env` (buildEnv). So one addition here serves both, and
 * nothing downstream has to know.
 *
 * Why it is needed at all: a program is found only in a PATH directory, and the PATH a process
 * inherits is its launcher's. Started from the dock or the Start menu — the normal case — tet
 * gets the OS's PATH for GUI programs, which on macOS/Linux is a bare list the login shell has
 * not yet extended (nvm, Homebrew, `~/.local/bin` all live in `.zshrc`/`.bashrc`), and on win32
 * often lacks the bin directory of whichever manager installed the agent (npm's global bin,
 * nvm-windows, Volta, scoop, winget) when that manager did not put it on PATH itself.
 * An agent the user installed "somehow" then sits in a directory tet's PATH never mentions.
 *
 * This is not what VS Code does on win32 — it trusts the registry PATH there and resolves the
 * login-shell environment on macOS/Linux only. tet adds the win32 half deliberately: an agent is
 * a hard requirement, and "installed but not on PATH" is a common enough state (an installer that
 * skipped the PATH edit) to be worth covering rather than leaving the user at the requirements
 * wall. See win32AgentDirs for how far that reaches, and where it stops.
 */
export async function augmentAgentPath(): Promise<void> {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = process.env[key] ?? "";
  const additions =
    process.platform === "win32"
      ? win32AgentDirs(process.env, await npmGlobalPrefix()).filter(directoryExists)
      : await loginShellPath(process.env.SHELL).catch(() => []);
  const merged = mergePath(current, additions, path.delimiter);
  if (merged !== current) {
    process.env[key] = merged;
  }
}

/**
 * The bin directories a win32 agent installer writes to that the inherited PATH may miss. Two
 * kinds, so a moved or unusual install is covered rather than only the defaults:
 *
 * - Where a package manager reports it puts global binaries: `npmPrefix` from `npm config get
 *   prefix` (the global bin *is* the prefix on win32), and the roots the managers export in the
 *   environment — `NVM_SYMLINK` (nvm-windows' current node), `VOLTA_HOME`, `SCOOP`.
 * - The fixed shim directories the managers use when they export nothing: npm's default
 *   `%APPDATA%\npm` (a fallback for when the npm query failed), Volta's and scoop's under their
 *   default roots, and winget's `Links`.
 *
 * The caller keeps only those that exist, so a manager the user does not have contributes
 * nothing. Order is widest-support-first; `mergePath` drops the duplicates a default and an
 * env-reported root resolve to.
 */
export function win32AgentDirs(env: NodeJS.ProcessEnv, npmPrefix: string | undefined): string[] {
  const dirs: string[] = [];
  if (npmPrefix) {
    dirs.push(npmPrefix);
  }
  if (env.APPDATA) {
    dirs.push(path.join(env.APPDATA, "npm"));
  }
  if (env.NVM_SYMLINK) {
    dirs.push(env.NVM_SYMLINK);
  }
  dirs.push(env.VOLTA_HOME ? path.join(env.VOLTA_HOME, "bin") : env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Volta", "bin") : "");
  dirs.push(env.SCOOP ? path.join(env.SCOOP, "shims") : env.USERPROFILE ? path.join(env.USERPROFILE, "scoop", "shims") : "");
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
  }
  return dirs.filter(Boolean);
}

/**
 * The global bin directory npm reports, so a prefix the user moved with `npm config set prefix`
 * is covered too — not only the `%APPDATA%\npm` default. npm itself is found because the Node
 * install directory is the one thing installers reliably put on PATH; the thing missing from it
 * is npm's *global* bin, which this asks npm for. Through `cmd.exe` because `npm` is a `.cmd`
 * shim CreateProcessW cannot launch directly — the same route resolveCommand takes, and without
 * `shell: true`, whose arg concatenation node now deprecates (DEP0190). Only ever called on
 * win32; undefined on any failure — the default in win32AgentDirs then stands in.
 */
function npmGlobalPrefix(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("cmd.exe", ["/d", "/s", "/c", "npm config get prefix"], { timeout: 5000, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      const value = stdout.trim();
      resolve(!error && value && value !== "undefined" ? value : undefined);
    });
  });
}

/** Only an existing directory is worth adding — an entry that resolves nothing only bloats PATH. */
function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Markers around the printed PATH, so shell noise (a profile's banner) can be discarded. */
const START = "__TET_PATH_START__";
const END = "__TET_PATH_END__";

/**
 * The PATH of the user's login shell, which is what actually holds the tool directories on
 * macOS/Linux — the version-managed ones (nvm's per-version `node/<v>/bin`) can be known no
 * other way. Run as a login, interactive shell (`-ilc`) so it sources the same files a real
 * terminal would, and bounded by a timeout: a shell that hangs or has no such PATH must not hold
 * startup. Returns the entries, or nothing on any failure — a wrong guess is worse than none.
 */
function loginShellPath(shell: string | undefined): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (!shell) {
      reject(new Error("no $SHELL"));
      return;
    }
    // `command printf` sidesteps a shell function or alias shadowing printf; the markers isolate
    // the value from anything the profile prints to stdout.
    const script = `command printf '%s%s%s' '${START}' "$PATH" '${END}'`;
    execFile(shell, ["-ilc", script], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const value = parseShellPath(stdout);
      if (value === undefined) {
        reject(new Error("no PATH in shell output"));
        return;
      }
      resolve(value.split(path.delimiter).filter(Boolean));
    });
  });
}

/** The PATH between the markers, or undefined if the shell never printed them. */
export function parseShellPath(output: string): string | undefined {
  const start = output.indexOf(START);
  const end = output.indexOf(END, start + START.length);
  if (start === -1 || end === -1) {
    return undefined;
  }
  return output.slice(start + START.length, end);
}

/**
 * `current` with each of `additions` that is not already in it appended, keeping order and
 * dropping blanks — new directories go after the inherited ones, so nothing already found is
 * shadowed by a namesake an installer put in one of these. Case-sensitive: PATH matching is on
 * every platform tet supports (win32's own resolution is case-insensitive, but a duplicate entry
 * is only cosmetic).
 */
export function mergePath(current: string, additions: string[], delimiter: string): string {
  const seen = new Set(current.split(delimiter).filter(Boolean));
  const added = additions.filter((dir) => dir && !seen.has(dir));
  return added.length === 0 ? current : [current, ...added].filter(Boolean).join(delimiter);
}
