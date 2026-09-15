import type { TerminalDescriptor } from "../../shared/types";

/**
 * The one non-terminal tab: a project's file in monaco — VS Code's preview editor, one per project,
 * reused by the next file. Renderer-only: no pty, no session, never persisted (`serializeLayout`
 * writes only tabs with a session id).
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
