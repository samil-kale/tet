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

/**
 * Opens `file` only as a plain file inside `root`, links resolved: a folder a sandbox writes into
 * can hold a link to any file of this machine. What was opened is checked, not the path before it,
 * so a link swapped in meanwhile is refused too, before anything is read or written. Its folder is
 * checked before, too: a file created through a linked folder would be left behind outside.
 */
export async function openInside(root: string, file: string, flags: string | number): Promise<fs.promises.FileHandle> {
  await assertInside(root, path.dirname(file));
  const handle = await fs.promises.open(file, flags);
  try {
    const [realRoot, realFile] = await Promise.all([root, file].map((entry) => fs.promises.realpath(entry)));
    const [opened, there] = await Promise.all([handle.stat(), fs.promises.stat(realFile)]);
    const same = opened.dev === there.dev && opened.ino === there.ino;
    if (!opened.isFile() || !same || relativeInside(realRoot, realFile) === undefined) {
      throw new Error(`${file} leads outside ${root}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Throws unless `target`, links resolved, is `root` or inside it. */
export async function assertInside(root: string, target: string): Promise<void> {
  const [realRoot, real] = await Promise.all([root, target].map((entry) => fs.promises.realpath(entry)));
  if (real !== realRoot && relativeInside(realRoot, real) === undefined) {
    throw new Error(`${target} leads outside ${root}`);
  }
}

/**
 * Removes `target` only where its folder is `root` or inside it, links resolved: a linked folder
 * where a sandbox writes would remove this machine's file. A missing folder resolves, as a missing
 * `target` does (`force`).
 */
export async function removeInside(root: string, target: string, recursive = false): Promise<void> {
  try {
    await assertInside(root, path.dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await fs.promises.rm(target, { recursive, force: true });
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
