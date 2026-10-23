import type { AgentInfo } from "../../shared/types/agents";
import type { TabDescriptor } from "../../shared/types/terminals";
import { isEditorTabId, type EditorTab } from "../editor/editor-tab";
import { keepEditor } from "../editor/editor-views";
import { baseName } from "../paths";
import { agentInfo, agentName } from "../ui/use-agents";

/** What a tab strip holds: a repository's or worktree's terminals, then its
 *  editor tabs. Told apart by their ids (paneTabKind). */
export type PaneTab = TabDescriptor | EditorTab;

/** A terminal is an agent's, a shell's or a saved command's — the tabs main runs a process for. */
export type PaneTabKind = "terminal" | "editor";

/** A tab with its kind, which a `switch` on `kind` narrows. */
export type KindedTab = { kind: "terminal"; tab: TabDescriptor } | { kind: "editor"; tab: EditorTab };

/** By the editor's id prefix, which a terminal's id never has: it is its session's, or main's own
 *  before it has one. */
export function paneTabKind(tabId: string): PaneTabKind {
  return isEditorTabId(tabId) ? "editor" : "terminal";
}

export function kindOf(tab: PaneTab): KindedTab {
  return { kind: paneTabKind(tab.tabId), tab } as KindedTab;
}

/** An editor tab's name: its file, with the short commit id for a commit's file. */
export function editorLabel({ path, commit }: EditorTab): string {
  return baseName(path) + (commit ? ` (${commit.sha.slice(0, 7)})` : "");
}

/** A terminal's name: the session title; a session-less agent's name, else a placeholder. */
export function terminalLabel(terminal: TabDescriptor, agents: readonly AgentInfo[]): string {
  return terminal.title || (agentInfo(agents, terminal.agentId)?.hasSessions === false ? agentName(agents, terminal.agentId) : "New session");
}

/** A moved editor tab is no longer the preview, as VS Code pins every editor it moves. */
export function keepMoved(tabId: string): void {
  if (paneTabKind(tabId) === "editor") {
    keepEditor(tabId);
  }
}
