import * as os from "node:os";
import * as path from "node:path";

/**
 * `target` relative to `root` when strictly below it, else undefined (`root` itself too). Only a
 * whole `..` segment escapes (`..env` is inside); another win32 drive comes back absolute: outside.
 */
export function relativeInside(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return relative === "" || escapes ? undefined : relative;
}

/**
 * The same, in git's shape: root-relative with forward slashes, as the change list and the editor
 * tabs name a file. Both transports that open one go through here, so a ctrl-click and
 * `tet-ctl editor-open` land on the same tab.
 */
export function repositoryRelative(root: string, target: string): string | undefined {
  return relativeInside(root, target)?.replace(/\\/g, "/");
}

/** Expands a leading `~` or `~/…` to the home folder, as a shell would; on win32 `~\…` too. */
export function expandHome(hostPath: string): string {
  if (hostPath === "~") {
    return os.homedir();
  }
  const homeRelative = hostPath.startsWith("~/") || (path.sep === "\\" && hostPath.startsWith("~\\"));
  return homeRelative ? path.join(os.homedir(), hostPath.slice(2)) : hostPath;
}
