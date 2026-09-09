import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Puts the directories the agents actually land in on this process's PATH, at startup and on every
 * re-check of the requirements. Both halves of tet read `process.env.PATH`: the startup check
 * spawns `<agent> --version`, and every terminal derives its env from it (buildEnv). Idempotent,
 * and a call while one runs joins it rather than starting a second shell. Launched from the dock
 * or the Start menu, tet gets the OS's PATH for GUI programs, which the login shell has not yet
 * extended (nvm, Homebrew, `~/.local/bin` live in `.zshrc`/`.bashrc`).
 *
 * On macOS/Linux the login shell's PATH *replaces* the inherited one (what was inherited and not in
 * it goes last): an npm-installed agent is a `#!/usr/bin/env node` shim, and with the shell's
 * entries merely appended a distro's old `/usr/bin/node` would win over the nvm node it was
 * installed with, killing it on start. On win32 the manager directories are *appended*: there is no
 * shell PATH to trust, only guesses, and a guess must not shadow something already found.
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
      // Not fatal: the inherited PATH may well suffice.
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
 * The bin directories a win32 agent installer writes to that the inherited PATH may miss: where a
 * package manager says it puts global binaries (`npmPrefix` — the global bin *is* the prefix on
 * win32 — plus `NVM_SYMLINK`, `VOLTA_HOME`, `SCOOP`), and the fixed shim directories used when
 * they export nothing. The caller keeps only those that exist; `mergePath` drops duplicates.
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
    // Docker Sandboxes' installer (winget) writes straight to the user PATH rather than through a
    // WinGet Links shim (verified against a real install).
    dirs.push(path.join(env.LOCALAPPDATA, "DockerSandboxes", "bin"));
  }
  return dirs.filter(Boolean);
}

/**
 * A global prefix the user moved with `npm config set prefix`, read the way npm reads it — the
 * environment (`NPM_CONFIG_PREFIX`, `npm_config_prefix`) before `~/.npmrc`. Never by asking npm:
 * `npm config get prefix` through cmd.exe measured as a noticeable part of every start, for an
 * answer nearly always the `%APPDATA%\npm` default win32AgentDirs already has. `${VAR}` is
 * expanded from `env` as npm does it. win32 only, undefined when nothing names one.
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

/** Only an existing directory is worth adding. */
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
 * How to make `shell` source its profile and run one line. `-ilc` for the Bourne family (`-l` the
 * login files, `-i` the rc); csh and tcsh take `-l` only on its own and have no `command` builtin,
 * so they get `-ic` and a bare printf. `command` sidesteps an alias shadowing printf.
 */
export function shellInvocation(shell: string): string[] {
  const csh = ["csh", "tcsh"].includes(path.basename(shell));
  const printf = `printf '%s%s%s' '${START}' "$PATH" '${END}'`;
  return csh ? ["-ic", printf] : ["-ilc", `command ${printf}`];
}

/**
 * The PATH of the user's login shell, where the tool directories live on macOS/Linux — the
 * version-managed ones (nvm's per-version `node/<v>/bin`) can be known no other way. `$SHELL`
 * names it, else the account's shell. Timeout-bounded so a hanging profile cannot hold startup;
 * `TET_RESOLVING_ENVIRONMENT` lets such a profile skip its slow part.
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

/** `base` with each of `additions` not already in it appended, keeping order and dropping blanks.
 *  Which list is the base differs per platform, see augmentAgentPath. Case-sensitive: win32's own
 *  resolution is case-insensitive, but a duplicate entry is only cosmetic. */
export function mergePath(base: string, additions: string[], delimiter: string): string {
  const seen = new Set(base.split(delimiter).filter(Boolean));
  const added = additions.filter((dir) => dir && !seen.has(dir));
  return added.length === 0 ? base : [base, ...added].filter(Boolean).join(delimiter);
}
