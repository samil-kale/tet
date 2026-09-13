import type { TerminalDescriptor } from "../../shared/types";

/**
 * The one tab in a strip that is not a terminal: a project's file, shown and edited in monaco —
 * VS Code's preview editor, one per project, reused by every file opened after it. It lives in
 * the renderer alone: no pty, no session, nothing the main process knows of, never persisted
 * (the layout writes only tabs with a session id, see `serializeLayout`).
 *
 * The id is shaped unlike any session id, which `loadLayout` hands back as tab ids.
 */
export const EDITOR_TAB_ID = "tet:editor";

export interface EditorTab {
  tabId: typeof EDITOR_TAB_ID;
  projectId: string;
  /** Repository-relative path of the file shown. */
  path: string;
}

/** What a tab strip holds: a project's terminals, and its editor tab once a file is open. */
export type PaneTab = TerminalDescriptor | EditorTab;

export function isEditorTab(tab: PaneTab): tab is EditorTab {
  return tab.tabId === EDITOR_TAB_ID;
}
