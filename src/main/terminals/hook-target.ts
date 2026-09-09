import * as path from "node:path";

/**
 * Where a generated hook command will actually run — on this host, or inside an sbx sandbox.
 * Shared by marker-watch.ts, os-notify.ts's buildReadFileCommand and each agent's hooks.ts, so
 * "is this for a sandbox" is one concept passed around rather than a `process.platform` check
 * repeated (and gotten wrong) in each.
 */
export interface HookTarget {
  /** False only for a Windows host — a sandbox is always Linux, whatever host it runs on, so a
   *  hook generated for one must take the POSIX branch even when `process.platform` is win32. */
  posix: boolean;
  /** Whether this is a sandbox rather than the host — for what a *desktop* session is needed
   *  for rather than a shell. A sandbox has none, so anything that would show a toast there has
   *  to go through `tet-ctl notify` instead of running a notify script itself (see
   *  buildHookNotifyCommand, and pi's extension, which spawns the two as argument lists). */
  sandbox: boolean;
  /** A host path exactly as this target's own shell will see it — identity outside a sandbox. */
  embed(hostPath: string): string;
}

export function hostTarget(): HookTarget {
  return { posix: process.platform !== "win32", sandbox: false, embed: (hostPath) => hostPath };
}

export function sandboxTarget(): HookTarget {
  return { posix: true, sandbox: true, embed: toContainerPath };
}

/**
 * A host path the way sbx mounts it inside a sandbox — verified live, 2026-09-08: a Windows
 * path is exposed as a Linux path with the drive letter lower-cased as its own top segment
 * (`C:\Users\x` → `/c/Users/x`); macOS and Linux hosts already use the same path inside and out
 * (`sbx create shell --help`: "mounted inside the sandbox at the same path as on the host").
 */
export function toContainerPath(hostPath: string): string {
  if (process.platform !== "win32") {
    return hostPath;
  }
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (!match) {
    return hostPath;
  }
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/** Every sandbox template's non-root user's home — verified live for a Claude, a Codex and an
 *  opencode sandbox (2026-09-08) and for pi's community-kit one (2026-09-09), each by `$HOME`
 *  and `whoami` inside it. Here rather than in sbx.ts because an agent's own folder needs it to
 *  say where its sessions sit inside a sandbox (SessionProvider.sandbox), and the agents may
 *  not reach into the sbx layer for it. A mount target must be absolute (`sbx mount --help`):
 *  it is not passed through a shell, so `~` never expands there. */
export const SANDBOX_HOME = "/home/agent";

/**
 * Where the sessions a sandboxed agent writes land on the host — the directory tet mounts into
 * the sandbox at the path that agent's CLI keeps its transcripts under (see
 * SessionProvider.sandbox). Beside `sandboxHookDir` rather than inside it: that one is watched
 * for marker files, and a transcript tree under it would be swept for markers on every pass.
 */
export function sandboxSessionDir(agentDir: string): string {
  return path.join(agentDir, "sandbox-sessions");
}

/** Where a sandboxed session's own hook scripts, settings and markers live — a subdirectory of
 *  the same agentDir a host session uses, so the two never overwrite each other's files (a host
 *  one is posix/win32-specific and path-literal; a sandboxed one is always posix with
 *  container-translated paths) while still sitting inside the one folder sbx.ts mounts whole.
 *  Each agent's prepareSpawn watches this for markers next to agentDir itself, so either kind
 *  of tab's turn is picked up by the one runtime. */
export function sandboxHookDir(agentDir: string): string {
  return path.join(agentDir, "sandbox");
}
