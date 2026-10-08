import { isBrowserTabId, type BrowserTabInfo } from "../../shared/types/browser";
import type { TabDescriptor } from "../../shared/types/terminals";
import { isEditorTabId, type EditorTab } from "../editor/editor-tab";

/** What a tab strip holds: a repository's or worktree's terminals, its browser tabs, then its
 *  editor tabs. Told apart by their ids (paneTabKind). */
export type PaneTab = TabDescriptor | BrowserTabInfo | EditorTab;

/** A terminal is an agent's, a shell's or a saved command's — the tabs main runs a process for. */
export type PaneTabKind = "terminal" | "browser" | "editor";

/** A tab with its kind, which a `switch` on `kind` narrows. */
export type KindedTab =
  { kind: "terminal"; tab: TabDescriptor } | { kind: "browser"; tab: BrowserTabInfo } | { kind: "editor"; tab: EditorTab };

/** By its id's prefix, which the browser and editor tabs shape their own way; a terminal's id is
 *  its session's, or main's own before it has one, and has none. */
export function paneTabKind(tabId: string): PaneTabKind {
  return isEditorTabId(tabId) ? "editor" : isBrowserTabId(tabId) ? "browser" : "terminal";
}

export function kindOf(tab: PaneTab): KindedTab {
  return { kind: paneTabKind(tab.tabId), tab } as KindedTab;
}
