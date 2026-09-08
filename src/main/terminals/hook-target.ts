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
  /** A host path exactly as this target's own shell will see it — identity outside a sandbox. */
  embed(hostPath: string): string;
}

export function hostTarget(): HookTarget {
  return { posix: process.platform !== "win32", embed: (hostPath) => hostPath };
}

export function sandboxTarget(): HookTarget {
  return { posix: true, embed: toContainerPath };
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

/** Where a sandboxed session's own hook scripts, settings and markers live — a subdirectory of
 *  the same agentDir a host session uses, so the two never overwrite each other's files (a host
 *  one is posix/win32-specific and path-literal; a sandboxed one is always posix with
 *  container-translated paths) while still sitting inside the one folder sbx.ts mounts whole.
 *  Each agent's prepareSpawn watches this for markers next to agentDir itself, so either kind
 *  of tab's turn is picked up by the one runtime. */
export function sandboxHookDir(agentDir: string): string {
  return path.join(agentDir, "sandbox");
}
