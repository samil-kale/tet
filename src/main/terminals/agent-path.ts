import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathKey } from "./pty";

/**
 * Puts the directories agents are installed in on `process.env.PATH`, at startup and on every
 * requirements re-check — the `<agent> --version` check, every terminal's env (buildEnv) and the
 * git process, which inherits it at the fork (main.ts waits for it), read it. A concurrent call
 * joins the running one. tet may be started by a desktop launcher whose
 * PATH the login shell never extended (nvm, Homebrew, `~/.local/bin` live in `.zshrc`/`.bashrc`).
 *
 * On macOS/Linux the login shell's PATH *replaces* the inherited one (leftovers go last): an npm
 * agent is a `#!/usr/bin/env node` shim, and with the shell's entries merely appended a distro's
 * old `/usr/bin/node` would win over the nvm node and kill it on start. On win32 the manager
 * directories are *appended*: they are only guesses, and a guess must not shadow what was found.
 */
export function augmentAgentPath(): Promise<void> {
  pending ??= augment().finally(() => {
    pending = undefined;
  });
  return pending;
}

let pending: Promise<void> | undefined;

async function augment(): Promise<void> {
  const key = pathKey(process.env);
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
 * win32 bin directories the inherited PATH may miss: the package managers' declared global bins
 * (`npmPrefix` — on win32 the bin *is* the prefix — `NVM_SYMLINK`, `VOLTA_HOME`, `SCOOP`), else
 * their fixed shim directories. The caller keeps those that exist; `mergePath` drops duplicates.
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
    // Docker Sandboxes' winget installer writes to the user PATH, not a WinGet Links shim (verified).
    dirs.push(path.join(env.LOCALAPPDATA, "DockerSandboxes", "bin"));
  }
  return dirs.filter(Boolean);
}

/**
 * A global prefix moved with `npm config set prefix`, read as npm reads it: env before `~/.npmrc`,
 * `${VAR}` expanded. Never by asking npm — `npm config get prefix` through cmd.exe measured as a
 * noticeable part of every start, for what is nearly always the `%APPDATA%\npm` default. win32 only.
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
 * Makes `shell` source its profile and run one line: `-ilc` for the Bourne family (`-l` login
 * files, `-i` the rc); csh/tcsh take `-l` only alone and lack `command`, so `-ic` and a bare printf.
 * `command` sidesteps an alias shadowing printf.
 */
export function shellInvocation(shell: string): string[] {
  const csh = ["csh", "tcsh"].includes(path.basename(shell));
  const printf = `printf '%s%s%s' '${START}' "$PATH" '${END}'`;
  return csh ? ["-ic", printf] : ["-ilc", `command ${printf}`];
}

/**
 * The login shell's PATH (`$SHELL`, else the account's) — the only way to know version-managed
 * directories like nvm's `node/<v>/bin`. Timeout-bounded so a hanging profile cannot hold startup;
 * `TET_RESOLVING_ENVIRONMENT` lets a profile skip its slow part.
 *
 * SIGKILL, because an interactive shell ignores SIGTERM (measured: a hung bash outlived the
 * timeout). It suffices: measured, the timeout settles the call even with a profile's background
 * process holding or writing stdout, or in its own session — so no process-group kill, which would
 * take down what the profile deliberately started.
 */
function loginShellPath(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || os.userInfo().shell || "/bin/sh";
    const env = { ...process.env, TET_RESOLVING_ENVIRONMENT: "1" };
    execFile(shell, shellInvocation(shell), { timeout: 5000, killSignal: "SIGKILL", encoding: "utf8", env }, (error, stdout) => {
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

/** `base` plus the `additions` not already in it, in order, blanks dropped. Which list is the base
 *  differs per platform (augmentAgentPath). Case-sensitive: a win32 duplicate is only cosmetic. */
export function mergePath(base: string, additions: string[], delimiter: string): string {
  const seen = new Set(base.split(delimiter).filter(Boolean));
  const added = additions.filter((dir) => dir && !seen.has(dir));
  return added.length === 0 ? base : [base, ...added].filter(Boolean).join(delimiter);
}
