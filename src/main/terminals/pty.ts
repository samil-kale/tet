import * as path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { CONTROL_ENV } from "../../shared/ctl";
import { tabControlToken } from "./ctl-token";
import { KEPT_ENV_NAME, machineName } from "../store/env-names";
import { pathKey, resolveCommand } from "../util/process";
import type { ControlChannel } from "../util/control-channel";
import { HOST_TAB, type TabSide } from "./tab-side";

/** What every terminal's environment takes of TET, read at each spawn. */
export interface TerminalEnv {
  control(): ControlChannel | undefined;
  /** The variables the user keeps in TET (environment.ts), so a restarted tab sees what was saved
   *  meanwhile. */
  stored(): Record<string, string>;
}

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Variables that win over the machine's own, unlike `env`: a saved command's, or those `sbx run
   *  -e` passes on. */
  envOverride?: Record<string, string>;
  /** This process's project, worktree and tab for the control channel (`TET_PROJECT_ID`,
   *  `TET_WORKTREE`, `TET_TAB_ID`). Above the machine's, like the control channel's. */
  own?: Record<string, string>;
  /** Where the tab runs (TabPlace): whether TET's stored variables reach it, and part of its control
   *  token, which is what the control server reads it back off (ctl-token.ts). This machine
   *  where omitted. */
  side?: TabSide;
  terminalEnv: TerminalEnv;
}

/** The variables kept in TET that a tab of `side` gets (TabSide.storedEnv), with the one naming them
 *  (KEPT_ENV_NAME) so a TET started from that tab does not take them for the machine's. Also what
 *  the OS's own terminal opened for a tab is set with. */
export function storedEnvOf(terminalEnv: TerminalEnv, side: TabSide): Record<string, string> {
  const stored = side.storedEnv ? terminalEnv.stored() : {};
  const names = Object.keys(stored);
  return names.length > 0 ? { ...stored, [KEPT_ENV_NAME]: names.join(",") } : stored;
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
 *  variables kept in TET over it where its side takes them (TabSide.storedEnv), then TET's own
 *  (the control channel's, options.own) with the tab's own control token in place of the run's
 *  (ctl-token.ts), then options.envOverride. Testable without a pty. */
export function buildEnv(
  terminalEnv: TerminalEnv,
  options: Pick<SpawnOptions, "env" | "envOverride" | "own" | "side">,
): Record<string, string> {
  const side = options.side ?? HOST_TAB;
  const stored = storedEnvOf(terminalEnv, side);
  const control = terminalEnv.control();
  const inherited = withoutNames({ ...(process.env as Record<string, string>) }, Object.keys(stored));
  // Never an outer TET's caller ids or list of kept variables (a TET started from a TET tab): only
  // `own` names this tab, and it got exactly `stored`.
  for (const name of [CONTROL_ENV.projectId, CONTROL_ENV.worktree, CONTROL_ENV.tabId, KEPT_ENV_NAME]) {
    delete inherited[name];
  }
  const env: Record<string, string> = {
    ...options.env,
    ...inherited,
    ...stored,
    ...control?.env,
    ...options.own,
  };
  const runToken = control?.env[CONTROL_ENV.token];
  if (runToken) {
    env[CONTROL_ENV.token] = tabControlToken(
      runToken,
      { projectId: env[CONTROL_ENV.projectId] ?? "", worktree: env[CONTROL_ENV.worktree] },
      env[CONTROL_ENV.tabId] ?? "",
      side,
    );
  }
  if (control?.binDir) {
    const key = pathKey(env);
    env[key] = env[key] ? `${control.binDir}${path.delimiter}${env[key]}` : control.binDir;
  }
  return Object.assign(withoutNames(env, Object.keys(options.envOverride ?? {})), options.envOverride);
}

/**
 * node-pty leaves the pipe it writes into unguarded (`windowsPtyAgent.js`'s `inSocket`). A write
 * landing after the process behind it has gone — a tab closed, a quit, a resize on the way out —
 * fails with nothing listening: an uncaught `write EAGAIN`, and through uncaught.ts a notice of an
 * unexpected error, though those bytes had nowhere to go. POSIX has no `_agent` and node-pty guards
 * its socket there, so this is a no-op.
 */
function guardPtyInput(spawned: IPty): void {
  const agent = (spawned as unknown as { _agent?: { inSocket?: { on?: (event: string, listener: () => void) => void } } })._agent;
  agent?.inSocket?.on?.("error", () => undefined);
}

export function spawnAgentProcess(executable: string, args: string[], options: SpawnOptions): IPty {
  const env = buildEnv(options.terminalEnv, options);
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
    useConptyDll: true,
  });
  guardPtyInput(spawned);
  return spawned;
}
