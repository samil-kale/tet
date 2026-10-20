import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useLatest } from "../ui/use-latest";
import type { RepositoryState } from "../../shared/types/git";
import type { TabDescriptor } from "../../shared/types/terminals";
import type { ResolvedRef } from "../resolved-ref";
import type { EditorTab } from "../editor/editor-tab";
import { openEditorFile, previewEditorTab } from "../editor/editor-views";
import { isPlainShell, layoutStorageKey, loadPersisted } from "./pane-layout";
import { restoreHistory, shellHistory } from "./terminal-views";

/** Each plain shell's output as the window last closed, by tab id: beside the layout's record,
 *  written only then, as VS Code keeps its terminals' buffers. */
const SHELL_HISTORY = "shell-history";

function loadShellHistory(refKey: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(layoutStorageKey(refKey, SHELL_HISTORY)) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The window's half of a restart, as VS Code's window brings back its editors and terminals: by
 * `refKey`, once its git state is first there (it is open in main, its files can be read), the
 * editor tabs and plain shells of its record (`loadPersisted`) come back. An editor tab opens as it
 * was left; a file gone since comes back too, its tab saying so (`FileContent.notFound`). A shell's
 * output is laid ahead of its new process, and main is told which shells to bring back
 * (`tabs.restore`), which ends the start phase it holds until then. The editor tabs are App's;
 * the record itself is the layout's to write (`persistLayouts`), the shells' output this hook's,
 * as the window goes.
 */
export function useTabRestore(
  resolvedRefs: Record<string, ResolvedRef>,
  states: Record<string, RepositoryState>,
  tabs: Record<string, TabDescriptor[]>,
  editorTabs: Record<string, EditorTab[]>,
  setEditorTabs: Dispatch<SetStateAction<Record<string, EditorTab[]>>>,
): (refKey: string) => void {
  /** Brought back, so each is once; dropped when it is forgotten. */
  const begun = useRef(new Set<string>());
  const latest = useLatest({ resolvedRefs, tabs, editorTabs });

  useEffect(() => {
    for (const [refKey, { ref }] of Object.entries(resolvedRefs)) {
      if (!(refKey in states) || begun.current.has(refKey)) {
        continue;
      }
      begun.current.add(refKey);
      const history = loadShellHistory(refKey);
      // A file is open in one tab at most: one opened meanwhile keeps its own.
      const open = latest.current.editorTabs[refKey] ?? [];
      const editors: EditorTab[] = [];
      const shellIds: string[] = [];
      for (const { id, kind, editor } of loadPersisted(refKey).tabs) {
        if (kind === "editor" && editor && !open.some((tab) => tab.path === editor.path && tab.commit?.sha === editor.commit?.sha)) {
          // One preview tab: a file opened meanwhile may have taken it.
          openEditorFile(ref, id, editor.path, editor.preview && previewEditorTab(ref) === undefined, {
            diff: editor.diff,
            commit: editor.commit,
            restored: editor,
          });
          editors.push({ tabId: id, ref, path: editor.path, commit: editor.commit });
        } else if (kind === "shell") {
          const shown = history[id];
          if (typeof shown === "string") {
            restoreHistory(ref, id, shown);
          }
          shellIds.push(id);
        }
      }
      if (editors.length > 0) {
        setEditorTabs((current) => ({ ...current, [refKey]: [...editors, ...(current[refKey] ?? [])] }));
      }
      window.tet.tabs.restore(ref, shellIds);
    }
  }, [resolvedRefs, states, latest, setEditorTabs]);

  // As the window goes: each plain shell's output, read only then.
  useEffect(() => {
    const onUnload = (): void => {
      for (const [refKey, { ref }] of Object.entries(latest.current.resolvedRefs)) {
        if (begun.current.has(refKey)) {
          const shells = (latest.current.tabs[refKey] ?? []).filter(isPlainShell);
          const history = Object.fromEntries(shells.map((tab) => [tab.tabId, shellHistory(ref, tab.tabId)]));
          localStorage.setItem(layoutStorageKey(refKey, SHELL_HISTORY), JSON.stringify(history));
        }
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [latest]);

  /** Lets go of a removed repository or worktree, so one added again under its key comes back
   *  anew; what is stored of it goes with its layout (`dropStoredLayout`). */
  return useCallback((refKey: string) => {
    begun.current.delete(refKey);
  }, []);
}
