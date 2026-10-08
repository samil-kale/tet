import { isBrowserTabId, type BrowserTabInfo } from "../../shared/types/browser";
import type { TabDescriptor } from "../../shared/types/terminals";
import { isEditorTabId, type EditorTab } from "../editor/editor-tab";

/** What a tab strip holds: a repository's or worktree's terminals, its browser tabs, then its
 *  editor tabs. Told apart by their ids, which each kind shapes its own way. */
export type PaneTab = TabDescriptor | BrowserTabInfo | EditorTab;

export function isEditorTab(tab: PaneTab): tab is EditorTab {
  return isEditorTabId(tab.tabId);
}

export function isBrowserTab(tab: PaneTab): tab is BrowserTabInfo {
  return isBrowserTabId(tab.tabId);
}

/** A terminal: an agent's, a shell's or a saved command's — the tabs main runs a process for. */
export function isTerminalTab(tab: PaneTab): tab is TabDescriptor {
  return isTerminalTabId(tab.tabId);
}

export function isTerminalTabId(tabId: string): boolean {
  return !isEditorTabId(tabId) && !isBrowserTabId(tabId);
}
