import type { TerminalDescriptor } from "../../shared/types";

/**
 * The non-terminal tabs: a project's files in monaco, VS Code's preview semantics. One preview
 * tab per project, replaced by the next file opened; it is kept (no longer replaced) by an edit,
 * "Keep Open" or an Explorer double-click, and the next file gets a new preview tab. Which tab is
 * the preview is the editor's own state (`editor-views.ts`), decided where an edit lands. A path
 * is open in at most one tab per project, and in at most one Markdown preview (`markdown`), which
 * is always kept — VS Code's "Open Preview", not a preview tab. Renderer-only: no pty, no session, never persisted
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

export interface EditorTab {
  tabId: string;
  projectId: string;
  /** Repository-relative path of the file shown. */
  path: string;
  /** The file rendered (`MarkdownHost`), not in an editor. */
  markdown?: boolean;
}

/** What a tab strip holds: a project's terminals, then its editor tabs. */
export type PaneTab = TerminalDescriptor | EditorTab;

export function isEditorTabId(tabId: string): boolean {
  return tabId.startsWith(EDITOR_TAB_PREFIX);
}

export function isEditorTab(tab: PaneTab): tab is EditorTab {
  return isEditorTabId(tab.tabId);
}
