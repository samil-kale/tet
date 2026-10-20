import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLatest } from "../ui/use-latest";
import type { RepositoryState } from "../../shared/types/git";
import type { ProjectRef } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";
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
import { isPlainShell, layoutStorageKey } from "./pane-layout";
import { disposeTerminal, restoreHistory, shellHistory } from "./terminal-views";

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

/** Under the layout's storage, which `dropStoredLayout` clears with the rest: the editor tabs, the
 *  plain shells' ids, and what each shell showed as the window last closed. */
const EDITORS = "editors";
const SHELLS = "shells";
const SHELL_HISTORY = "shell-history";

/** What storage holds under `name`, parsed; `fallback` where nothing or something broken is. */
function readStored(refKey: string, name: string, fallback: unknown): unknown {
  try {
    return JSON.parse(localStorage.getItem(layoutStorageKey(refKey, name)) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

/** Read defensively, as `loadLayout` reads the layout: an entry of the wrong shape is dropped. */
function loadStoredEditors(refKey: string): StoredEditor[] {
  const parsed = readStored(refKey, EDITORS, []);
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
}

/** The plain shells' ids, each with what it showed where that was kept. */
function loadStoredShells(refKey: string): { tabId: string; history?: string }[] {
  const ids = readStored(refKey, SHELLS, []);
  const histories = readStored(refKey, SHELL_HISTORY, {}) as Record<string, unknown>;
  return Array.isArray(ids)
    ? ids
        .filter((tabId): tabId is string => typeof tabId === "string")
        .map((tabId) => {
          const history = histories[tabId];
          return { tabId, history: typeof history === "string" ? history : undefined };
        })
    : [];
}

/** The ids of the plain shells among a repository's or worktree's tabs. */
function plainShellIds(tabs: TabDescriptor[] | undefined): string[] {
  return (tabs ?? []).filter(isPlainShell).map((tab) => tab.tabId);
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

/** Opens the stored editor tabs of `ref` but a file opened meanwhile, which keeps its own tab;
 *  answers them. */
function restoreEditors(ref: ProjectRef, refKey: string, open: EditorTab[]): EditorTab[] {
  const back: EditorTab[] = [];
  for (const entry of loadStoredEditors(refKey)) {
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
  return back;
}

/** Opens the stored shells of `ref`, each showing what it last did ahead of its new process. One
 *  whose id another tab took meanwhile comes back under a new id, without it. */
async function restoreShells(ref: ProjectRef, refKey: string): Promise<void> {
  await Promise.all(
    loadStoredShells(refKey).map(async ({ tabId, history }) => {
      if (history !== undefined) {
        restoreHistory(ref, tabId, history);
      }
      const tab = await window.tet.tabs.restoreShell(ref, tabId).catch(() => undefined);
      if (tab?.tabId !== tabId) {
        disposeTerminal(ref, tabId);
      }
    }),
  );
}

/**
 * The tabs a restart brings back that no agent keeps — editor tabs and plain shells (`isPlainShell`),
 * as VS Code its editors and terminals — by `refKey`, and what is kept of them meanwhile. A
 * repository's or worktree's are brought back once its git state is first there, so it is open
 * in main and its files can be read. A file or commit gone since comes back too, as VS Code keeps
 * it: its tab says so (`FileContent.notFound`). A shell starts anew, where its tab first did, as
 * any tab at its first fit. `restored` holds the ones done: until then nothing is written, and the
 * layout waits for them as for the sessions (`settleLayout`). The editor tabs are App's.
 *
 * Written on every change of the tabs or an editor's state, and as the window goes, which is when
 * an editor's cursor and scroll and a shell's output are last read (`editorViewState`,
 * `shellHistory`).
 */
export function useTabRestore(
  resolvedRefs: Record<string, ResolvedRef>,
  states: Record<string, RepositoryState>,
  tabs: Record<string, TabDescriptor[]>,
  editorTabs: Record<string, EditorTab[]>,
  setEditorTabs: Dispatch<SetStateAction<Record<string, EditorTab[]>>>,
): { restored: Set<string>; forgetRestore: (refKey: string) => void } {
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  /** Read when a repository or worktree is brought back, not a reason to run that again. */
  const editorTabsRef = useLatest(editorTabs);
  /** Begun, so each is brought back once; dropped when it is forgotten. */
  const begun = useRef(new Set<string>());
  /** What was last written, per storage key. */
  const written = useRef<Record<string, string>>({});

  useEffect(() => {
    for (const [refKey, { ref }] of Object.entries(resolvedRefs)) {
      if (!(refKey in states) || begun.current.has(refKey)) {
        continue;
      }
      begun.current.add(refKey);
      const back = restoreEditors(ref, refKey, editorTabsRef.current[refKey] ?? []);
      if (back.length > 0) {
        setEditorTabs((current) => ({ ...current, [refKey]: [...back, ...(current[refKey] ?? [])] }));
      }
      void restoreShells(ref, refKey).then(() => {
        // Closed meanwhile.
        if (begun.current.has(refKey)) {
          setRestored((current) => new Set(current).add(refKey));
        }
      });
    }
  }, [resolvedRefs, states, editorTabsRef, setEditorTabs]);

  /** Writes what changed since it was last written, of a repository or worktree not forgotten: its
   *  editors' disposal must not write back what was dropped. */
  const write = useCallback((refKey: string, name: string, serialized: string): void => {
    const key = layoutStorageKey(refKey, name);
    if (begun.current.has(refKey) && written.current[key] !== serialized) {
      written.current[key] = serialized;
      localStorage.setItem(key, serialized);
    }
  }, []);

  // The editor tabs, on every change of them or of an editor's state.
  useEffect(() => {
    const unsubscribers = [...restored].flatMap((refKey) => {
      const resolved = resolvedRefs[refKey];
      if (!resolved) {
        return [];
      }
      const writeEditors = (): void => write(refKey, EDITORS, serializeEditors(editorTabs[refKey]));
      writeEditors();
      return [subscribeRefEditors(resolved.ref, writeEditors)];
    });
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [restored, editorTabs, resolvedRefs, write]);

  // The plain shells, on every change of the tab list.
  useEffect(() => {
    for (const refKey of restored) {
      write(refKey, SHELLS, JSON.stringify(plainShellIds(tabs[refKey])));
    }
  }, [restored, tabs, write]);

  // As the window goes, what is read only then: the editors' cursor and scroll, each shell's output.
  const latest = useLatest({ restored, tabs, editorTabs, resolvedRefs });
  useEffect(() => {
    const onUnload = (): void => {
      const now = latest.current;
      for (const refKey of now.restored) {
        const ref = now.resolvedRefs[refKey]?.ref;
        if (ref) {
          write(refKey, EDITORS, serializeEditors(now.editorTabs[refKey]));
          const histories = Object.fromEntries(plainShellIds(now.tabs[refKey]).map((tabId) => [tabId, shellHistory(ref, tabId)]));
          write(refKey, SHELL_HISTORY, JSON.stringify(histories));
        }
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [latest, write]);

  /** Lets go of a removed repository or worktree; what is stored of it goes with its layout. */
  const forgetRestore = useCallback((refKey: string) => {
    begun.current.delete(refKey);
    for (const name of [EDITORS, SHELLS, SHELL_HISTORY]) {
      delete written.current[layoutStorageKey(refKey, name)];
    }
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
