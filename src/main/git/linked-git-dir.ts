import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where a linked worktree's or a submodule's git data lives, read off its `.git` file — no git
 * process: `gitDir` the file names, and for a worktree the `commonDir` its `commondir` points at
 * (the main repository's `.git`). Undefined for a `.git` directory (the usual repository) or none.
 * Synchronous, for `ProjectStore.load` and the watcher setup.
 */
export function readLinkedGitDir(root: string): { gitDir: string; commonDir?: string } | undefined {
  let gitDir: string;
  try {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(root, ".git"), "utf8"));
    if (!pointer) {
      return undefined;
    }
    gitDir = path.resolve(root, pointer[1]);
  } catch {
    return undefined;
  }
  try {
    return { gitDir, commonDir: path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()) };
  } catch {
    // A submodule: no common directory.
    return { gitDir };
  }
}

/**
 * A linked worktree's main worktree, the folder holding the common `.git`; undefined otherwise. In
 * on-disk spelling, as `git rev-parse --show-toplevel` gives a project's path (measured on win32),
 * so the two compare as strings.
 */
export function readMainWorktree(root: string): string | undefined {
  const commonDir = readLinkedGitDir(root)?.commonDir;
  if (commonDir === undefined) {
    return undefined;
  }
  try {
    return fs.realpathSync.native(path.dirname(commonDir));
  } catch {
    // The main worktree is gone; the worktree is no longer one either.
    return undefined;
  }
}
