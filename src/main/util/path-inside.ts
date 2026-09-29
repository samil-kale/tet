import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A path in on-disk spelling, as `readWorktrees` and `readMainWorktree` give it: a project's path
 * is stored so, or string comparisons with theirs miss — a Windows 8.3 name, macOS's `/var`, a
 * junction or a symlink. Where it does not exist (yet), its longest existing prefix so and the
 * rest as given.
 */
export function onDisk(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(onDisk(parent), path.basename(absolute));
  }
}

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

/**
 * `normalizeHostPath`'s inverse, for tet.json: under home as `~/…` with forward slashes, so a row serves another user
 * on the same OS; else as typed. Case-insensitive on win32 through `path.relative`.
 */
export function contractHome(hostPath: string): string {
  const typed = hostPath.trim();
  const resolved = normalizeHostPath(typed);
  if (!path.isAbsolute(resolved)) {
    return typed;
  }
  if (path.relative(os.homedir(), resolved) === "") {
    return "~";
  }
  const relative = relativeInside(os.homedir(), resolved);
  if (relative === undefined) {
    return typed;
  }
  return `~/${relative.split(path.sep).join("/")}`;
}

/** A typed host path as sbx lists it back: `~` expanded, native separators, no trailing one.
 *  Relative paths are left alone. */
export function normalizeHostPath(hostPath: string): string {
  const expanded = expandHome(hostPath.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
}
