import type { TerminalDescriptor } from "../../shared/types";

/**
 * The non-terminal tabs: a project's files in monaco, VS Code's preview semantics. One preview
 * tab per project, replaced by the next file opened; it is kept (no longer replaced) by an edit,
 * "Keep Open" or an Explorer double-click, and the next file gets a new preview tab. Which tab is
 * the preview is the editor's own state (`editor-views.ts`), decided where an edit lands. A path
 * is open in at most one tab per project. Renderer-only: no pty, no session, never persisted
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

/**
 * How a file is opened, named rather than passed as a row of booleans: every view that opens one
 * says the same thing, and the rule for its own kind of click lives at that one call.
 */
/** Where a search result opens its file: the match, 1-based as the editor counts. */
export interface EditorReveal {
  line: number;
  column: number;
  length: number;
}

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
}

export interface EditorTab {
  tabId: string;
  projectId: string;
  /** Repository-relative path of the file shown. */
  path: string;
}

/** What a tab strip holds: a project's terminals, then its editor tabs. */
export type PaneTab = TerminalDescriptor | EditorTab;

export function isEditorTabId(tabId: string): boolean {
  return tabId.startsWith(EDITOR_TAB_PREFIX);
}

export function isEditorTab(tab: PaneTab): tab is EditorTab {
  return isEditorTabId(tab.tabId);
}
