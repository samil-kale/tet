import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where the agents actually land, put on this process's PATH at startup and on every re-check
 * of the requirements, so tet finds one installed after tet's own launcher was set on PATH — and,
 * more to the point, one installed to a place the PATH tet inherited never had. Both halves of
 * tet read `process.env.PATH`: the startup check spawns `<agent> --version` (requirements.ts →
 * checkAgentInstalled), and every terminal derives its env from `process.env` (buildEnv). So one
 * change here serves both, and nothing downstream has to know. Idempotent: a second call finds
 * nothing new and leaves PATH as it is — and a call while one is still running joins it rather
 * than starting a second shell (main.ts starts the first without awaiting it; the requirements
 * check may arrive before it is done).
 *
 * Why it is needed at all: a program is found only in a PATH directory, and the PATH a process
 * inherits is its launcher's. Started from the dock or the Start menu — the normal case — tet
 * gets the OS's PATH for GUI programs, which on macOS/Linux is a bare list the login shell has
 * not yet extended (nvm, Homebrew, `~/.local/bin` all live in `.zshrc`/`.bashrc`), and on win32
 * often lacks the bin directory of whichever manager installed the agent (npm's global bin,
 * nvm-windows, Volta, scoop, winget) when that manager did not put it on PATH itself.
 * An agent the user installed "somehow" then sits in a directory tet's PATH never mentions.
 *
 * The two platforms merge differently, on purpose. On macOS/Linux the login shell's PATH
 * *replaces* the inherited one (what was inherited and not in it goes last): an npm-installed
 * agent is a `#!/usr/bin/env node` shim, and with the shell's entries merely appended, a distro's
 * old `/usr/bin/node` would win over the nvm node the agent was installed with, and the agent
 * would die on start. That is VS Code's choice too. On win32 the manager directories are
 * *appended*: there is no shell PATH to trust over the inherited one, only a list of guesses, and
 * a guess must not shadow something already found. VS Code does not do the win32 half at all; tet
 * adds it deliberately, since an agent is a hard requirement and "installed but not on PATH" is a
 * common enough state (an installer that skipped the PATH edit) to be worth covering rather than
 * leaving the user at the requirements wall.
 */
export function augmentAgentPath(): Promise<void> {
  pending ??= augment().finally(() => {
    pending = undefined;
  });
  return pending;
}

let pending: Promise<void> | undefined;

async function augment(): Promise<void> {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = process.env[key] ?? "";
  let merged: string;
  if (process.platform === "win32") {
    merged = mergePath(current, win32AgentDirs(process.env, npmGlobalPrefix(process.env)).filter(directoryExists), path.delimiter);
  } else {
    let shellPath: string[];
    try {
      shellPath = await loginShellPath();
    } catch (error) {
      // Not fatal — the inherited PATH may well suffice — but worth a line, since "agent not
      // found" on a machine that has it is otherwise a mystery.
      console.error("[tet] could not read the login shell's PATH:", error);
      return;
    }
    merged = mergePath(shellPath.join(path.delimiter), current.split(path.delimiter), path.delimiter);
  }
  if (merged !== current) {
    process.env[key] = merged;
  }
}

/**
 * The bin directories a win32 agent installer writes to that the inherited PATH may miss. Two
 * kinds, so a moved or unusual install is covered rather than only the defaults:
 *
 * - Where a package manager says it puts global binaries: `npmPrefix` (the global bin *is* the
 *   prefix on win32), and the roots the managers export in the environment — `NVM_SYMLINK`
 *   (nvm-windows' current node), `VOLTA_HOME`, `SCOOP`.
 * - The fixed shim directories the managers use when they export nothing: npm's default
 *   `%APPDATA%\npm`, Volta's and scoop's under their default roots, and winget's `Links`.
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
 * A global prefix the user moved with `npm config set prefix`, read from where npm itself reads
 * it — the environment (`NPM_CONFIG_PREFIX`, `npm_config_prefix`) before the user's `~/.npmrc` —
 * rather than by asking npm: `npm config get prefix` through cmd.exe measured ~480 ms on a warm
 * machine, paid on every start before the window, for an answer that is the `%APPDATA%\npm`
 * default nearly always (and that default is in win32AgentDirs regardless). `${VAR}` in the
 * value is expanded the way npm does it, from `env`; a variable not set stays literal, as in
 * npm. Undefined when nothing names one. Only ever called on win32.
 */
export function npmGlobalPrefix(env: NodeJS.ProcessEnv, npmrc: string | undefined = readUserNpmrc()): string | undefined {
  const fromEnv = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix;
  const value = fromEnv || npmrc?.match(/^\s*prefix\s*=\s*(.+?)\s*$/m)?.[1];
  return value?.replace(/\$\{([^}]+)\}/g, (match, name: string) => env[name] ?? match);
}

function readUserNpmrc(): string | undefined {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf8");
  } catch {
    return undefined;
  }
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
 * How to make `shell` source its profile and run one line. `-ilc` for the Bourne family, so it
 * reads the same files a real terminal would (`-l` the login ones, `-i` the rc); csh and tcsh
 * take `-l` only on its own and have no `command` builtin, so they get `-ic` and a bare printf.
 * The markers isolate the value from anything the profile prints to stdout; `command printf`
 * sidesteps a function or alias shadowing printf.
 */
export function shellInvocation(shell: string): string[] {
  const csh = ["csh", "tcsh"].includes(path.basename(shell));
  const printf = `printf '%s%s%s' '${START}' "$PATH" '${END}'`;
  return csh ? ["-ic", printf] : ["-ilc", `command ${printf}`];
}

/**
 * The PATH of the user's login shell, which is what actually holds the tool directories on
 * macOS/Linux — the version-managed ones (nvm's per-version `node/<v>/bin`) can be known no
 * other way. `$SHELL` names it; a GUI launch without one falls back to the account's shell.
 * Bounded by a timeout: a shell that hangs (a profile that `exec`s tmux, say) must not hold
 * startup, and `TET_RESOLVING_ENVIRONMENT` lets such a profile skip that when it knows to look.
 * Rejects on any failure — a wrong guess is worse than none.
 */
function loginShellPath(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || os.userInfo().shell || "/bin/sh";
    const env = { ...process.env, TET_RESOLVING_ENVIRONMENT: "1" };
    execFile(shell, shellInvocation(shell), { timeout: 5000, encoding: "utf8", env }, (error, stdout) => {
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
 * `base` with each of `additions` that is not already in it appended, keeping order and dropping
 * blanks. Which list is the base is the caller's call — see augmentAgentPath for why the
 * platforms differ. Case-sensitive: PATH matching is on every platform tet supports (win32's own
 * resolution is case-insensitive, but a duplicate entry is only cosmetic).
 */
export function mergePath(base: string, additions: string[], delimiter: string): string {
  const seen = new Set(base.split(delimiter).filter(Boolean));
  const added = additions.filter((dir) => dir && !seen.has(dir));
  return added.length === 0 ? base : [base, ...added].filter(Boolean).join(delimiter);
}
