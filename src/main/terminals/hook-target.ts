import * as path from "node:path";

/** Where a generated hook command will actually run — on this host, or inside an sbx sandbox. */
export interface HookTarget {
  /** False only for a Windows host: a sandbox is always Linux, so a hook generated for one takes
   *  the POSIX branch even when `process.platform` is win32. */
  posix: boolean;
  /** Whether this is a sandbox rather than the host. A sandbox has no desktop session, so a
   *  toast there goes through `tet-ctl notify` rather than a notify script of its own. */
  sandbox: boolean;
  /** A host path exactly as this target's own shell will see it — identity outside a sandbox. */
  embed(hostPath: string): string;
}

export const HOST_TARGET: HookTarget = { posix: process.platform !== "win32", sandbox: false, embed: (hostPath) => hostPath };

export const SANDBOX_TARGET: HookTarget = { posix: true, sandbox: true, embed: toContainerPath };

/** A host path the way sbx mounts it inside a sandbox — measured: a Windows path becomes a Linux
 *  path with the drive letter lower-cased as its own top segment (`C:\Users\x` → `/c/Users/x`);
 *  macOS and Linux hosts use the same path inside and out. */
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

/** Every sandbox template's non-root user's home — verified by `$HOME` and `whoami` inside a
 *  Claude, a Codex, an opencode and pi's community-kit sandbox. A mount target must be absolute
 *  (`sbx mount --help`): it is not passed through a shell, so `~` never expands there. */
export const SANDBOX_HOME = "/home/agent";

/** Where the sessions a sandboxed agent writes land on the host — the directory tet mounts into
 *  the sandbox at the path that agent's CLI keeps its transcripts under. Beside `sandboxHookDir`,
 *  never inside it: that one is swept for marker files on every pass. */
export function sandboxSessionDir(agentDir: string): string {
  return path.join(agentDir, "sandbox-sessions");
}

/** Where a sandboxed session's own hook scripts, settings and markers live — a subdirectory of the
 *  agentDir a host session uses, so the two never overwrite each other's files while still sitting
 *  inside the one folder sbx.ts mounts whole. Watched for markers next to agentDir itself. */
export function sandboxHookDir(agentDir: string): string {
  return path.join(agentDir, "sandbox");
}
