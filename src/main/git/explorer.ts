import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../../shared/errors";
import type {
  ExplorerListing,
  FileSearchFile,
  FileSearchMatch,
  FileSearchQuery,
  FileSearchResult
} from "../../shared/types";
import { readExplorerView, type ExplorerView } from "../tet-json";
import { git } from "./git-client";

/**
 * The Explorer's listing and its search: filesystem walks off `Repository`'s git state machine
 * (they take no index lock and share nothing with `runAction`), per repository root.
 */

/** Above this, the editor shows "too large" instead of reading the file into the renderer
 *  (`Repository.readFile`); a file the tab cannot show is no use as a search result either. */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

/** A search's cap, counted in matches, since every one of them is a row the renderer draws. A
 *  one-character query in a large repository stops here instead of filling the pane. */
const MAX_SEARCH_MATCHES = 2000;
/** Files read at once; beyond a handful only file handles are spent. */
const SEARCH_READERS = 8;
/** The longest result row, and how much of the line is kept before a match far to the right. */
const MAX_MATCH_TEXT = 400;
const MATCH_LEAD = 40;

/** What a result row shows: the line without its indent, cut to a window holding the match — which
 *  may itself start inside the indent, and then keeps it. */
function matchText(line: string, index: number): { text: string; textColumn: number } {
  const indent = line.length - line.trimStart().length;
  const start = Math.min(index, Math.max(indent, index - MATCH_LEAD));
  return { text: line.slice(start, start + MAX_MATCH_TEXT), textColumn: index - start };
}

/**
 * The query as a regex, `flags` on top of the case flag — "g" for the search, which walks a line's
 * matches. Throws on an invalid regex, which `searchFiles` answers as the result's `error`.
 */
function searchPattern(query: FileSearchQuery, flags: string): RegExp {
  const escaped = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // As ripgrep's `-w`, which VS Code searches with: the whole expression between word boundaries.
  const source = query.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
  return new RegExp(source, query.matchCase ? flags : `${flags}i`);
}

/** Every file, plus empty directories — see `ExplorerListing`. The walk's own doc is
 *  `walkExplorer`; mtimes cost a `stat` per entry, so only `modified` asks for them. */
export async function listExplorer(root: string): Promise<ExplorerListing> {
  const view = await readExplorerView(root);
  const wantMtimes = view.sortOrder === "modified";
  const walked = await walkExplorer(root, view, wantMtimes);
  return {
    files: walked.files.sort(),
    emptyDirs: walked.emptyDirs.sort(),
    roots: view.folders.length > 0 ? view.folders : undefined,
    compactFolders: view.compactFolders,
    sortOrder: view.sortOrder,
    mtimes: walked.mtimes
  };
}

/**
 * The Explorer's entries under one view. A filesystem walk, not a git process: off the index lock
 * `runAction` serialises, and `fs.promises` so a large `node_modules` doesn't hold the main event
 * loop. Skips `exclude` globs and, if the view says so, git's ignore list (one `ls-files` per
 * walk, never on the refresh path); walks only the outermost `folders`.
 */
async function walkExplorer(
  root: string,
  view: ExplorerView,
  wantMtimes: boolean
): Promise<{ files: string[]; emptyDirs: string[]; mtimes: Record<string, number> | undefined }> {
  const ignored = view.excludeGitIgnore ? await git.listIgnored(root).catch(() => []) : [];
  const ignoredFiles = new Set(ignored.filter((entry) => !entry.endsWith("/")));
  const ignoredDirs = new Set(ignored.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)));
  const skip = (relativePath: string, isDirectory: boolean): boolean =>
    (isDirectory ? ignoredDirs : ignoredFiles).has(relativePath) ||
    view.exclude.some((pattern) => path.matchesGlob(relativePath, pattern));

  const files: string[] = [];
  const emptyDirs: string[] = [];
  const mtimes: Record<string, number> = {};
  const stat = async (absolutePath: string, relativePath: string): Promise<void> => {
    try {
      mtimes[relativePath] = (await fs.promises.stat(absolutePath)).mtimeMs;
    } catch {
      // Vanished: sorts with the oldest until the next listing.
    }
  };
  const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length === 0) {
      if (relativeDir) {
        emptyDirs.push(relativeDir);
      }
      return;
    }
    const pending: Promise<void>[] = [];
    for (const entry of entries) {
      // Hidden regardless of `files.exclude`.
      if (entry.name === ".git") {
        continue;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      const isDirectory = entry.isDirectory();
      if (!isDirectory && !entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (skip(relativePath, isDirectory)) {
        continue;
      }
      if (isDirectory) {
        pending.push(walk(absolutePath, relativePath));
      } else {
        // A symlink is a file row, never descended into, so a link cycle is harmless.
        files.push(relativePath);
      }
      if (wantMtimes) {
        pending.push(stat(absolutePath, relativePath));
      }
    }
    // In parallel; the caller's sort keeps the listing deterministic.
    await Promise.all(pending);
  };
  const roots = view.folders;
  const outermost = roots.filter(
    (entry) => !roots.some((other) => other !== entry && (other.path === "" || entry.path.startsWith(`${other.path}/`)))
  );
  if (outermost.length === 0) {
    await walk(root, "");
  } else {
    await Promise.all(outermost.map((entry) => walk(path.join(root, entry.path), entry.path)));
  }
  return { files, emptyDirs, mtimes: wantMtimes ? mtimes : undefined };
}

/**
 * The Explorer search field's matches, VS Code's "search in files": every line of every listed
 * file the query matches. The Explorer's own file set, always without what git ignores — VS
 * Code's `search.useIgnoreFiles`, which the tree's `excludeGitIgnore` does not decide, and a
 * search must not read `node_modules`. The files are read a few at a time (more only costs file
 * handles) until the match cap.
 *
 * The cap bounds what is listed, not the reading: a query matching nothing still costs the whole
 * repository. So a search gives up as soon as `overtaken` says the next one was asked for
 * (`Repository.searchFiles`) — typing in a large repository would otherwise have several full
 * scans running at once, all but the last one already discarded by the renderer.
 */
export async function searchFiles(root: string, query: FileSearchQuery, overtaken: () => boolean): Promise<FileSearchResult> {
  let matcher: RegExp;
  try {
    matcher = searchPattern(query, "g");
  } catch (error) {
    return { files: [], truncated: false, error: errorMessage(error) };
  }
  const view = await readExplorerView(root);
  const { files } = await walkExplorer(root, { ...view, excludeGitIgnore: true }, false);
  const wanted = [...files].sort();

  const found: (FileSearchFile | undefined)[] = new Array(wanted.length);
  let next = 0;
  let matches = 0;
  let truncated = false;
  const read = async (): Promise<void> => {
    while (next < wanted.length && !truncated && !overtaken()) {
      const index = next++;
      const filePath = wanted[index];
      const lines = await matchesIn(root, filePath, matcher);
      if (matches + lines.length > MAX_SEARCH_MATCHES) {
        lines.length = MAX_SEARCH_MATCHES - matches;
        truncated = true;
      }
      // Empty, or emptied by the cap another reader reached while this file was being read.
      if (lines.length === 0) {
        continue;
      }
      matches += lines.length;
      found[index] = { path: filePath, matches: lines };
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_READERS, wanted.length) }, read));
  // The cap is only ever reached mid-file, so it always left matches out.
  return { files: found.filter((file) => file !== undefined), truncated };
}

/**
 * One file's matches, empty for a file too large, binary or unreadable — none of which the editor
 * would show either. The readers share `matcher`, whose `lastIndex` the loop below carries from
 * one match to the next: nothing in that loop awaits, so no second reader can reach it meanwhile.
 */
async function matchesIn(root: string, filePath: string, matcher: RegExp): Promise<FileSearchMatch[]> {
  const absolute = path.join(root, filePath);
  let content: string;
  try {
    const stat = await fs.promises.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_EDIT_BYTES) {
      return [];
    }
    const buffer = await fs.promises.readFile(absolute);
    if (buffer.includes(0)) {
      return [];
    }
    content = buffer.toString("utf8");
  } catch {
    // Vanished or unreadable between the walk and the read.
    return [];
  }
  const matches: FileSearchMatch[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    matcher.lastIndex = 0;
    for (let match = matcher.exec(line); match; match = matcher.exec(line)) {
      if (match[0].length === 0) {
        // A pattern that can match nothing (`a*`) would never advance on its own.
        matcher.lastIndex++;
        continue;
      }
      matches.push({ line: index + 1, column: match.index + 1, length: match[0].length, ...matchText(line, match.index) });
    }
  });
  return matches;
}
