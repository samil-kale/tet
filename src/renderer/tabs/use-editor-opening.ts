import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { projectRefKey } from "../../shared/types/project";
import type { ProjectRef } from "../../shared/types/project";
import { forget } from "../identity";
import { nextEditorTabId, setRevealHandler, type EditorTab, type OpenEditor } from "../editor/editor-tab";
import {
  canDiscardEdits,
  disposeEditor,
  keepEditor,
  openEditorFile,
  previewEditorTab,
  revealEditorMatch,
  showDiff,
  showMarkdownPreview
} from "../editor/editor-views";
import type { PaneId } from "./pane-layout";

/**
 * Opening and closing editor tabs. The tabs themselves (`editorTabs`) are the caller's, since its
 * layout reads them before this can run; `activateTab` is that layout's, `select` brings a
 * repository or worktree to front, `activeRef` is the one in front.
 */
export function useEditorOpening(
  editorTabsRef: RefObject<Record<string, EditorTab[]>>,
  setEditorTabs: Dispatch<SetStateAction<Record<string, EditorTab[]>>>,
  activateTab: (key: string, tabId: string, paneId?: PaneId) => void,
  select: (key: string) => void,
  activeRef: ProjectRef | null
) {
  /**
   * Shows a file in an editor tab (the preview rule: `editor-tab.ts`), the way `how` asks for
   * (`OpenEditor`). A path already open is brought to front, kept if asked; else the preview tab
   * takes it, unless `keep`; else a new tab.
   * The editor is told before the tab draws, since the tab attaches what it made; the tab is
   * activated before it appears in the strip, as a new terminal tab is — both in one handler, so
   * the layout and the list agree on the first render.
   *
   * A tab already open only ever has its diff switched on, never off, so opening a file again
   * leaves what the user chose there (`showDiff`).
   *
   * Handed as is to every way in but the changes list (`openActiveDiff`) — the Explorer, its
   * search, a path ctrl-clicked in a terminal, a Markdown preview's link: the file itself, in the
   * repository or worktree the view names.
   */
  const openEditor = useCallback(
    (ref: ProjectRef, path: string, how: OpenEditor = {}) => {
      const key = projectRefKey(ref);
      const open = editorTabsRef.current[key]?.find((tab) => tab.path === path);
      const preview = how.keep ? undefined : previewEditorTab(ref);
      let tabId: string;
      if (open) {
        tabId = open.tabId;
        if (how.keep) {
          keepEditor(tabId);
        }
        if (how.markdownPreview) {
          showMarkdownPreview(tabId, true);
        }
        if (how.diff) {
          showDiff(tabId, true);
        }
        if (how.reveal) {
          revealEditorMatch(tabId, how.reveal);
        }
      } else if (preview !== undefined) {
        tabId = preview;
        openEditorFile(ref, tabId, path, true, how);
        setEditorTabs((current) => ({
          ...current,
          [key]: (current[key] ?? []).map((tab) => (tab.tabId === tabId ? { ...tab, path } : tab))
        }));
      } else {
        tabId = nextEditorTabId();
        openEditorFile(ref, tabId, path, how.keep !== true, how);
        setEditorTabs((current) => ({ ...current, [key]: [...(current[key] ?? []), { tabId, ref, path }] }));
      }
      activateTab(key, tabId);
    },
    [activateTab, editorTabsRef, setEditorTabs]
  );

  // A file the control channel asked for, brought to front.
  useEffect(
    () =>
      window.tet.repository.onOpenEditor(({ ref, path, keep }) => {
        select(projectRefKey(ref));
        openEditor(ref, path, { keep });
      }),
    [openEditor, select]
  );
  // A path ctrl-clicked in a terminal, or linked from a Markdown preview.
  useEffect(() => setRevealHandler(openEditor), [openEditor]);

  /** The changes list's, the one view that opens a file against HEAD. */
  const openActiveDiff = useCallback(
    (path: string, how?: OpenEditor) => {
      if (activeRef) {
        openEditor(activeRef, path, { ...how, diff: true });
      }
    },
    [activeRef, openEditor]
  );

  /** Disposes the editors; the layout collapses a pane left empty. By `projectRefKey`. */
  const closeEditors = useCallback(
    (key: string, tabIds: string[]) => {
      void canDiscardEdits(tabIds).then((discard) => {
        if (!discard) {
          return;
        }
        setEditorTabs((current) => {
          const rest = (current[key] ?? []).filter((tab) => !tabIds.includes(tab.tabId));
          return rest.length > 0 ? { ...current, [key]: rest } : forget(current, key);
        });
        for (const tabId of tabIds) {
          disposeEditor(tabId);
        }
      });
    },
    [setEditorTabs]
  );

  return { openEditor, openActiveDiff, closeEditors };
}
