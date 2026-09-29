import * as path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { CONTROL_ENV } from "../../shared/control";
import { tabControlToken } from "./control-token";
import { KEPT_ENV_NAME, machineName } from "../store/env-names";
import { pathKey, resolveCommand } from "../util/spawn";
import { HOST_TAB, type TabSide } from "./tab-side";

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Variables that win over the machine's own, unlike `env`: a saved command's, or those `sbx run
   *  -e` passes on. */
  envOverride?: Record<string, string>;
  /** This process's project, worktree and tab for the control channel (`TET_PROJECT_ID`,
   *  `TET_WORKTREE`, `TET_TAB_ID`).
   *  Above the machine's, like `controlEnv`. */
  own?: Record<string, string>;
  /** Where the tab runs (TabPlace): whether TET's stored variables reach it, and part of its control
   *  token, which is what the control server reads it back off (control-token.ts). This machine
   *  where omitted. */
  side?: TabSide;
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

/** Deletes from `env` the variables `names` replace, and returns it: on win32 names ignore case, a
 *  name in another case would be a second variable, and of the two the child sees the inherited one
 *  — so a replacement removes its name in any spelling. */
function withoutNames(env: Record<string, string>, names: string[]): Record<string, string> {
  const replaced = new Set(names.map(machineName));
  for (const name of Object.keys(env).filter((key) => replaced.has(machineName(key)))) {
    delete env[name];
  }
  return env;
}

/** A terminal's env: options.env as defaults under the machine's (the user's value wins), the
 *  variables kept in tet over it where its side takes them (TabSide.storedEnv), then tet's own
 *  (controlEnv, options.own) with the tab's own control token in place of the run's
 *  (control-token.ts), then options.envOverride. Testable without a pty. */
export function buildEnv(options: Pick<SpawnOptions, "env" | "envOverride" | "own" | "side">): Record<string, string> {
  const side = options.side ?? HOST_TAB;
  const stored = side.storedEnv ? storedEnv() : {};
  const inherited = withoutNames({ ...(process.env as Record<string, string>) }, Object.keys(stored));
  // Never an outer tet's caller ids (a tet started from a tet tab): only `own` names this tab.
  for (const name of [CONTROL_ENV.projectId, CONTROL_ENV.worktree, CONTROL_ENV.tabId]) {
    delete inherited[name];
  }
  const env: Record<string, string> = {
    ...options.env,
    ...inherited,
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
      { projectId: env[CONTROL_ENV.projectId] ?? "", worktree: env[CONTROL_ENV.worktree] },
      env[CONTROL_ENV.tabId] ?? "",
      side
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
 * had nowhere to go. POSIX has no `_agent` and node-pty guards its socket there, so this is a
 * no-op.
 */
function guardPtyInput(spawned: IPty): void {
  const agent = (spawned as unknown as { _agent?: { inSocket?: { on?: (event: string, listener: () => void) => void } } })._agent;
  agent?.inSocket?.on?.("error", () => undefined);
}

export function spawnAgentProcess(executable: string, args: string[], options: SpawnOptions): IPty {
  const env = buildEnv(options);
  // A path is the tab's folder's, as child_process takes it; node-pty looks from this process's. A
  // bare name stays a search.
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
