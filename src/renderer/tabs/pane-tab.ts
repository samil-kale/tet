import type { TabDescriptor } from "../../shared/types/terminals";
import { isEditorTabId, type EditorTab } from "../editor/editor-tab";

/** What a tab strip holds: a repository's or worktree's terminals, then its
 *  editor tabs. Told apart by their ids (paneTabKind). */
export type PaneTab = TabDescriptor | EditorTab;

/** A terminal is an agent's, a shell's or a saved command's — the tabs main runs a process for. */
export type PaneTabKind = "terminal" | "editor";

/** A tab with its kind, which a `switch` on `kind` narrows. */
export type KindedTab = { kind: "terminal"; tab: TabDescriptor } | { kind: "editor"; tab: EditorTab };

/** By the editor's id prefix; a terminal's id is
 *  its session's, or main's own before it has one, and has none. */
export function paneTabKind(tabId: string): PaneTabKind {
  return isEditorTabId(tabId) ? "editor" : "terminal";
}

export function kindOf(tab: PaneTab): KindedTab {
  return { kind: paneTabKind(tab.tabId), tab } as KindedTab;
}
