import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { RepositoryState } from "../../shared/types/git";
import type { ResolvedRef } from "../resolved-ref";
import type { CommitSide, EditorTab } from "../editor/editor-tab";
import {
  editorViewState,
  getEditorSnapshot,
  MARKDOWN_PREVIEW_MODES,
  openEditorFile,
  previewEditorTab,
  subscribeRefEditors,
  type MarkdownPreviewMode,
} from "../editor/editor-views";
import { layoutStorageKey } from "./pane-layout";

/** What a restart brings back of an editor tab: its file, and the editor as it was left. Its pane
 *  and place are the layout's, under the same id (`serializeLayout`). */
interface StoredEditor {
  tabId: string;
  path: string;
  commit?: CommitSide;
  preview: boolean;
  diff: boolean;
  markdownPreview: MarkdownPreviewMode;
  /** monaco's own shape (`editorViewState`), handed back as it was read. */
  viewState?: unknown;
}

function storageKey(refKey: string): string {
  return layoutStorageKey(refKey, "editors");
}

/** Read defensively, as `loadLayout` reads the layout: an entry of the wrong shape is dropped. */
function loadStoredEditors(refKey: string): StoredEditor[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(refKey)) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry: unknown): StoredEditor[] => {
      const { tabId, path, commit, preview, diff, markdownPreview, viewState } = (entry ?? {}) as Record<string, unknown>;
      if (typeof tabId !== "string" || typeof path !== "string") {
        return [];
      }
      const { sha, parent, origPath } = (commit ?? {}) as Record<string, unknown>;
      return [
        {
          tabId,
          path,
          commit:
            typeof sha === "string"
              ? {
                  sha,
                  parent: typeof parent === "string" ? parent : undefined,
                  origPath: typeof origPath === "string" ? origPath : undefined,
                }
              : undefined,
          preview: preview === true,
          diff: diff === true,
          markdownPreview: MARKDOWN_PREVIEW_MODES.find((mode) => mode === markdownPreview) ?? "off",
          viewState: viewState !== null && typeof viewState === "object" ? viewState : undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** The repository's or worktree's editor tabs as `StoredEditor`s, serialized. */
function serializeEditors(editors: EditorTab[] | undefined): string {
  return JSON.stringify(
    (editors ?? []).map(({ tabId, path, commit }): StoredEditor => {
      const { preview, diff, markdownPreview } = getEditorSnapshot(tabId);
      return { tabId, path, commit, preview, diff, markdownPreview, viewState: editorViewState(tabId) };
    }),
  );
}

/**
 * The editor tabs a restart brings back, by `refKey`, and what is kept of them meanwhile — under
 * the layout's storage, which `dropStoredLayout` clears with the rest. A repository's or worktree's
 * are brought back once its git state is first there, so its files can be read. A file or commit
 * gone since comes back too, as VS Code keeps it: its tab says so (`FileContent.notFound`).
 * `restored` holds the ones done: until then nothing is written, and the layout waits for them as
 * for the sessions (`settleLayout`). The tabs are App's.
 *
 * Written on every change of the tabs or an editor's state, and as the window goes, which is when
 * the cursor and scroll are last read (`editorViewState`).
 */
export function useEditorRestore(
  resolvedRefs: Record<string, ResolvedRef>,
  states: Record<string, RepositoryState>,
  editorTabs: Record<string, EditorTab[]>,
  editorTabsRef: RefObject<Record<string, EditorTab[]>>,
  setEditorTabs: Dispatch<SetStateAction<Record<string, EditorTab[]>>>,
): { restored: Set<string>; forgetRestore: (refKey: string) => void } {
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  /** Begun, so each is brought back once; dropped when it is forgotten. */
  const begun = useRef(new Set<string>());
  /** What was last written, per repository or worktree. */
  const written = useRef<Record<string, string>>({});

  useEffect(() => {
    const done: string[] = [];
    for (const [refKey, { ref }] of Object.entries(resolvedRefs)) {
      if (!(refKey in states) || begun.current.has(refKey)) {
        continue;
      }
      begun.current.add(refKey);
      done.push(refKey);
      const open = editorTabsRef.current[refKey] ?? [];
      const back: EditorTab[] = [];
      for (const entry of loadStoredEditors(refKey)) {
        // A file opened meanwhile keeps its own tab.
        if (open.some((tab) => tab.path === entry.path && tab.commit?.sha === entry.commit?.sha)) {
          continue;
        }
        // One preview tab: a file opened meanwhile may have taken it.
        const preview = entry.preview && previewEditorTab(ref) === undefined;
        openEditorFile(ref, entry.tabId, entry.path, preview, {
          diff: entry.diff,
          commit: entry.commit,
          restored: { markdownPreview: entry.markdownPreview, viewState: entry.viewState },
        });
        back.push({ tabId: entry.tabId, ref, path: entry.path, commit: entry.commit });
      }
      if (back.length > 0) {
        setEditorTabs((current) => ({ ...current, [refKey]: [...back, ...(current[refKey] ?? [])] }));
      }
    }
    if (done.length > 0) {
      setRestored((current) => new Set([...current, ...done]));
    }
  }, [resolvedRefs, states, editorTabsRef, setEditorTabs]);

  useEffect(() => {
    const write = (refKey: string): void => {
      // Forgotten: its editors' disposal must not write back what was dropped.
      if (!begun.current.has(refKey)) {
        return;
      }
      const serialized = serializeEditors(editorTabs[refKey]);
      if (written.current[refKey] !== serialized) {
        written.current[refKey] = serialized;
        localStorage.setItem(storageKey(refKey), serialized);
      }
    };
    const writeAll = (): void => restored.forEach(write);
    const unsubscribers: (() => void)[] = [];
    for (const refKey of restored) {
      const resolved = resolvedRefs[refKey];
      if (resolved) {
        write(refKey);
        unsubscribers.push(subscribeRefEditors(resolved.ref, () => write(refKey)));
      }
    }
    window.addEventListener("beforeunload", writeAll);
    return () => {
      window.removeEventListener("beforeunload", writeAll);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [restored, editorTabs, resolvedRefs]);

  /** Lets go of a removed repository or worktree; what is stored of it goes with its layout. */
  const forgetRestore = useCallback((refKey: string) => {
    begun.current.delete(refKey);
    delete written.current[refKey];
    setRestored((current) => {
      if (!current.has(refKey)) {
        return current;
      }
      const next = new Set(current);
      next.delete(refKey);
      return next;
    });
  }, []);

  return { restored, forgetRestore };
}
