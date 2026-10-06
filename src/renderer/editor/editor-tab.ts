import type { ProjectRef } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";

/**
 * The non-terminal tabs: a project's files in monaco, VS Code's preview semantics. One preview
 * tab per repository or worktree, replaced by the next file opened; it is kept (no longer replaced) by an edit,
 * "Keep Open" or an Explorer double-click, and the next file gets a new preview tab. Which tab is
 * the preview is the editor's own state (`editor-views.ts`), decided where an edit lands. A path
 * is open in at most one tab per repository or worktree, and a commit's file in one per commit.
 * Renderer-only: no pty, no session, never persisted
 * (`serializeLayout` writes only tabs with a session id).
 *
 * Ids count up, so the preview tab keeps its id, pane and place when its file changes. The prefix
 * is shaped unlike any session id, which `loadLayout` hands back as tab ids.
 */
const EDITOR_TAB_PREFIX = "tet:editor:";

let editorTabs = 0;

export function nextEditorTabId(): string {
  return `${EDITOR_TAB_PREFIX}${++editorTabs}`;
}

/** Where a search result opens its file: the match, 1-based as the editor counts. */
export interface EditorReveal {
  line: number;
  column: number;
  length: number;
}

/** A file as a commit left it, against the commit's first parent: the GRAPH's diff. */
export interface CommitSide {
  sha: string;
  /** The first parent; absent for a root commit. */
  parent?: string;
  /** A rename's source path, the one the parent has. */
  origPath?: string;
}

/**
 * How a file is opened, named rather than passed as a row of booleans: every view that opens one
 * says the same thing, and the rule for its own kind of click lives at that one call.
 */
export interface OpenEditor {
  /** The side the tab opens on: the changes list opens a change against HEAD, everything else a
   *  plain file, as VS Code shows it. A tab already open only ever has its diff switched on. */
  diff?: boolean;
  /** A tab of its own instead of the project's preview tab. */
  keep?: boolean;
  /** A Markdown file with its preview beside the editor, and the default for the ones after. */
  markdownPreview?: boolean;
  /** A search result's match, selected once the file's text is in the editor. */
  reveal?: EditorReveal;
  /** The file at a commit, read-only, instead of the working tree's. */
  commit?: CommitSide;
}

export interface EditorTab {
  tabId: string;
  ref: ProjectRef;
  /** Repository-relative path of the file shown. */
  path: string;
  /** Set for a GRAPH diff: a path is then open once per commit. */
  commit?: CommitSide;
}

/** The path of tab `tabId` where it shows the working tree's file, the one the Explorer marks open;
 *  a commit's file is not in the tree. */
export function workingTreePathOf(tabs: EditorTab[] | undefined, tabId: string | undefined): string | null {
  const tab = tabs?.find((candidate) => candidate.tabId === tabId);
  return tab && !tab.commit ? tab.path : null;
}

/** What a tab strip holds: a project's terminals, then its editor tabs. */
export type PaneTab = TabDescriptor | EditorTab;

export function isEditorTabId(tabId: string): boolean {
  return tabId.startsWith(EDITOR_TAB_PREFIX);
}

export function isEditorTab(tab: PaneTab): tab is EditorTab {
  return isEditorTabId(tab.tabId);
}

/** Opens a file of the repository or worktree in its preview tab, a Markdown file with its preview
 *  beside the editor if asked. Set by App. */
let revealHandler: ((ref: ProjectRef, path: string, how: OpenEditor) => void) | undefined;

export function setRevealHandler(handler: (ref: ProjectRef, path: string, how: OpenEditor) => void): () => void {
  revealHandler = handler;
  return () => {
    if (revealHandler === handler) {
      revealHandler = undefined;
    }
  };
}

/** A ctrl-clicked path or a Markdown preview's link: main finds it, opens one outside the
 *  repository itself, and says when there is none. */
export function openFile(ref: ProjectRef, filePath: string, markdownPreview = false): void {
  void window.tet.shell.openFile(ref, filePath).then((repoPath) => {
    if (repoPath) {
      revealHandler?.(ref, repoPath, { markdownPreview });
    }
  });
}
