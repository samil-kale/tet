import type { GitActionResult } from "./git";

/** The file at HEAD — the diff editor's original side. */
export interface HeadBlob {
  content: string;
  /** Binary, image or too large; `content` is empty. */
  binary: boolean;
  /** Not in HEAD (untracked, added, unborn branch); diffs as all new. */
  missing: boolean;
  /** An image's committed version as a data URL, instead of `content`. */
  image?: string;
}

/** The working tree's text plus HEAD's, read once per open. */
export interface FileContent {
  path: string;
  content: string;
  /** Checked on save so an outside edit is never clobbered. 0 for a deleted file, never saved. */
  mtimeMs: number;
  binary: boolean;
  tooLarge: boolean;
  /** An image as a data URL, instead of `content`. */
  image?: string;
  /** `content` is the text taken out of a document (ODF), not the file itself; the editor is read-only. */
  extracted?: boolean;
  /** Absent for an unchanged file: the diff editor mirrors its own content, nothing marked. */
  head?: HeadBlob;
  /** Missing from the working tree; the editor is read-only. */
  deleted?: boolean;
  error?: string;
}

/** Written, or why not — a stale `mtimeMs` never overwrites silently. */
export interface FileWriteResult extends GitActionResult {
  mtimeMs?: number;
  /** Refused as changed on disk since `expectedMtimeMs`: its mtime now, to overwrite against once
   *  the user agreed. */
  diskMtimeMs?: number;
}

/**
 * The Explorer tree's files — a filesystem scan, not `git ls-files`, which cannot represent an empty
 * directory. `emptyDirs` holds only directories no file implies. `.git` is always left out. Carries
 * `tet.json`'s view settings too, for one read; `roots` is absent without a `folders` list. Paths
 * are repository-relative, each file listed once whatever roots contain it.
 */
export interface ExplorerListing {
  files: string[];
  emptyDirs: string[];
  roots?: ExplorerRoot[];
  compactFolders: boolean;
  sortOrder: ExplorerSortOrder;
  /** Per listed file and directory — only read for `modified`. */
  mtimes?: Record<string, number>;
}

/** A `folders` entry: a top-level tree node labelled `name`. */
export interface ExplorerRoot {
  name: string;
  /** Repository-relative, forward slashes; "" for the root. */
  path: string;
}

/** VS Code's `explorer.sortOrder`. `foldersNestsFiles` is `default` without file nesting. */
export const EXPLORER_SORT_ORDERS = ["default", "mixed", "filesFirst", "type", "modified", "foldersNestsFiles"] as const;

export type ExplorerSortOrder = (typeof EXPLORER_SORT_ORDERS)[number];

/** What the settings dialog's Files tab edits, read on its own. */
export interface ExplorerSettings {
  /** `explorer.excludeGitIgnore`: hide what git ignores too. */
  excludeGitIgnore: boolean;
  /** `explorer.compactFolders`: fold `src/main/java` into one row. */
  compactFolders: boolean;
  /** `explorer.sortOrder`. */
  sortOrder: ExplorerSortOrder;
}

/**
 * What the SEARCH pane's field asks for: VS Code's search box with its three toggles, over the
 * files' lines (`Repository.searchFiles`). The Explorer's own field filters the tree by name and
 * asks for nothing here.
 */
export interface FileSearchQuery {
  /** What was typed; a regex when `regex` is on. */
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One match, not one line: two matches in a line are two rows, as VS Code lists them. */
export interface FileSearchMatch {
  /** 1-based, as the editor counts. */
  line: number;
  /** 1-based, in the line — where the editor puts the selection. */
  column: number;
  length: number;
  /** The row's text: the line without its indent, cut to a window that holds the match. */
  text: string;
  /** Where the match starts inside `text`, 0-based. */
  textColumn: number;
}

export interface FileSearchFile {
  path: string;
  matches: FileSearchMatch[];
}

/** `Repository.searchFiles`'s answer, files in path order. */
export interface FileSearchResult {
  files: FileSearchFile[];
  /** The match cap was reached: what is listed is a part of what is there. */
  truncated: boolean;
  /** An invalid regex; nothing was searched. */
  error?: string;
}
