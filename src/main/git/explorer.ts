import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import { errorMessage, failure } from "../../shared/errors";
import type { ExplorerListing, ExplorerSettings, FileSearchQuery, FileSearchResult } from "../../shared/types/files";
import type { GitActionResult } from "../../shared/types/git";
import { readExplorerView } from "../store/tet-json";
import { walkExplorer } from "./explorer-read";
import { explorerRead } from "./explorer-client";
import { git } from "./git-client";
import { relativeInside } from "../util/path-inside";
import { logError } from "../util/error-log";

/**
 * The Explorer's listing and its search: filesystem walks off `Repository`'s git state machine
 * (they take no index lock and share nothing with `runAction`), per repository root.
 */

/** Every file, plus empty directories — see `ExplorerListing` — walked in the Explorer's process
 *  (explorer-read.ts's `walkExplorer`). Git's ignore list is one `ls-files` per walk, never on the
 *  refresh path. A process that died walks here instead: the Explorer waits on an answer. */
export async function listExplorer(root: string, settings: ExplorerSettings): Promise<ExplorerListing> {
  const view = await readExplorerView(root);
  const wantMtimes = settings.sortOrder === "modified";
  const ignored = settings.excludeGitIgnore ? await git.listIgnored(root).catch(() => []) : [];
  const walked = await explorerRead.walkExplorer(root, view, ignored, wantMtimes).catch((error: unknown) => {
    logError("the Explorer's process failed to list", error);
    return walkExplorer(root, view, ignored, wantMtimes);
  });
  return {
    files: walked.files,
    emptyDirs: walked.emptyDirs,
    roots: view.folders.length > 0 ? view.folders : undefined,
    compactFolders: settings.compactFolders,
    sortOrder: settings.sortOrder,
    mtimes: walked.mtimes,
  };
}

/** The SEARCH section's matches (explorer-read.ts's `searchFiles`), in the Explorer's process. A
 *  process that died answers as a failed search. */
export async function searchFiles(root: string, query: FileSearchQuery, signal: AbortSignal): Promise<FileSearchResult> {
  const view = await readExplorerView(root);
  const ignored = await git.listIgnored(root).catch(() => []);
  // Overtaken while these were read: the walk is no use any more.
  if (signal.aborted) {
    return { files: [], truncated: false };
  }
  return explorerRead
    .searchFiles(root, view, ignored, query, signal)
    .catch((error: unknown) => ({ files: [], truncated: false, error: errorMessage(error) }));
}

/** What every path check answers for a path that escapes the repository root. */
export const OUTSIDE_REPOSITORY = { ok: false, error: "Path is outside the repository" } as const;

/**
 * A filesystem action as a `GitActionResult`: whatever it threw becomes the failure's message, in
 * the words the OS used. For the Explorer's own edits, which run off `runAction` — they take no
 * index lock (Repository.listExplorer).
 */
function attempt(action: () => Promise<unknown>): Promise<GitActionResult> {
  return action().then(() => ({ ok: true }), failure);
}

/** Whether two paths name one entry, e.g. differing in case on a case-insensitive filesystem. By
 *  file id, as bigints: a win32 file id overflows a number. */
function sameEntry(a: string, b: string): boolean {
  try {
    const [first, second] = [fs.statSync(a, { bigint: true }), fs.statSync(b, { bigint: true })];
    return first.ino === second.ino && first.dev === second.dev;
  } catch {
    return false;
  }
}

/** A repository-relative path for a new entry, resolved, or an error if outside or taken.
 *  `renaming` is the source: on a case-insensitive filesystem `Readme.md` → `README.md` finds the
 *  source at the target, which is no conflict. */
function resolveNew(root: string, filePath: string, renaming?: string): { absolute: string } | { error: string } {
  const absolute = resolveInside(root, filePath);
  if (!absolute) {
    return { error: OUTSIDE_REPOSITORY.error };
  }
  if (fs.existsSync(absolute) && !(renaming && sameEntry(absolute, renaming))) {
    return { error: `A file or folder "${filePath}" already exists at this location` };
  }
  return { absolute };
}

/** The Explorer's "New File...", creating parent directories. */
export async function createFile(root: string, filePath: string): Promise<GitActionResult> {
  const target = resolveNew(root, filePath);
  if ("error" in target) {
    return { ok: false, error: target.error };
  }
  return attempt(async () => {
    await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.promises.writeFile(target.absolute, "", { flag: "wx" });
  });
}

/** The Explorer's "New Folder...". */
export async function createDirectory(root: string, dirPath: string): Promise<GitActionResult> {
  const target = resolveNew(root, dirPath);
  if ("error" in target) {
    return { ok: false, error: target.error };
  }
  return attempt(() => fs.promises.mkdir(target.absolute, { recursive: true }));
}

/** The Explorer's "Delete...": to the trash, like `discard`. */
export async function deletePath(root: string, filePath: string): Promise<GitActionResult> {
  const absolute = resolveInside(root, filePath);
  if (!absolute) {
    return OUTSIDE_REPOSITORY;
  }
  return attempt(() => shell.trashItem(absolute));
}

/** The Explorer's "Rename...", which may also move. */
export async function renamePath(root: string, fromPath: string, toPath: string): Promise<GitActionResult> {
  const from = resolveInside(root, fromPath);
  if (!from) {
    return OUTSIDE_REPOSITORY;
  }
  const to = resolveNew(root, toPath, from);
  if ("error" in to) {
    return { ok: false, error: to.error };
  }
  // Before the `mkdir` below, which would leave its folders inside the source.
  if (relativeInside(from, to.absolute) !== undefined) {
    return { ok: false, error: `Cannot move "${fromPath}" into itself` };
  }
  return attempt(async () => {
    await fs.promises.mkdir(path.dirname(to.absolute), { recursive: true });
    await fs.promises.rename(from, to.absolute);
  });
}

/** The absolute path, or undefined if it escapes the root. */
export function resolveInside(root: string, filePath: string): string | undefined {
  const absolute = path.resolve(root, filePath);
  return relativeInside(root, absolute) === undefined ? undefined : absolute;
}
