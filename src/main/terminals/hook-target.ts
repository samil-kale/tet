import * as fs from "node:fs";
import * as path from "node:path";

/** Where a generated hook command will actually run — on this host, or inside an sbx sandbox. The
 *  command is the same on both; a sandboxed `tet-ctl` reaches the host through TET_CONTROL_HOST. */
export interface HookTarget {
  /** False only for a Windows host: a sandbox is always Linux, whatever `process.platform` says. */
  posix: boolean;
  /** A host path exactly as this target's own shell will see it — identity outside a sandbox. */
  embed(hostPath: string): string;
}

export const HOST_TARGET: HookTarget = { posix: process.platform !== "win32", embed: (hostPath) => hostPath };

export const SANDBOX_TARGET: HookTarget = { posix: true, embed: toContainerPath };

/** A host path as sbx mounts it in a sandbox (measured): `C:\Users\x` → `/c/Users/x`; macOS and
 *  Linux paths are unchanged.
 *
 *  Spelled as on disk, not as asked (measured, 2026-09-14): a folder created as `tet` mounts at
 *  `…/tet` even when asked as `TET`, and the sandbox is case-sensitive. realpath also resolving
 *  junctions, subst and mapped drives costs nothing: sbx 0.42.1 accepts none of them anyway. */
export function toContainerPath(hostPath: string): string {
  if (process.platform !== "win32") {
    return hostPath;
  }
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(onDiskCase(hostPath));
  if (!match) {
    return hostPath;
  }
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/** The longest existing prefix in on-disk spelling, the rest as given — the file may not exist yet. */
function onDiskCase(hostPath: string): string {
  try {
    return fs.realpathSync.native(hostPath);
  } catch {
    const parent = path.dirname(hostPath);
    return parent === hostPath ? hostPath : path.join(onDiskCase(parent), path.basename(hostPath));
  }
}

/** The sandbox user's home in every template — verified in Claude, Codex, opencode and pi's
 *  community kit. A mount target must be absolute (`sbx mount --help`): `~` never expands. */
export const SANDBOX_HOME = "/home/agent";

/** The host directory mounted where a sandboxed CLI writes its transcripts. Beside
 *  `sandboxHookDir`, never inside it. */
export function sandboxSessionDir(agentDir: string): string {
  return path.join(agentDir, "sandbox-sessions");
}

/** A sandboxed session's generated setup: inside agentDir, which sbx.ts mounts whole, but apart
 *  from the host session's files. */
export function sandboxHookDir(agentDir: string): string {
  return path.join(agentDir, "sandbox");
}
