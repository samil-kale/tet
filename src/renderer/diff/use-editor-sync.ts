import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkoutKey } from "../../shared/types";
import type { CheckoutRef, RepositoryState } from "../../shared/types";
import { forget, sameList, sameRecord } from "../identity";
import type { EditorTab } from "../terminal/editor-tab";
import { activeEditorTab, defaultLayout, type ProjectLayout } from "../terminal/pane-layout";
import { editorContent, setEditorVersion } from "./editor-views";

/** Shared instance, so a checkout's watched list is stable when empty. */
const NO_PATHS: string[] = [];

const DEFAULT_LAYOUT = defaultLayout();

/** What an open file is re-read for: HEAD's branch and commit (so a pull or reset counts), the
 *  file's status, and a write on disk (`writes`), which leaves a modified file's status unchanged. */
function diffVersion(state: RepositoryState | undefined, filePath: string, writes: number | undefined): string {
  return `${state?.head}:${state?.headCommit}:${state?.changes.find((change) => change.path === filePath)?.status}:${writes ?? 0}`;
}

/**
 * What App keeps the editors and main in step with, derived from the editor tabs, the layouts
 * and the repository states, each by checkout key: each checkout's active editor tab — reported to
 * main for `tet-ctl editor-state`, and answering its content request — the open paths main watches
 * for writes, and each tab's `diffVersion`, which decides a reload. `forgetCheckout` drops a closed
 * checkout's write counts; the tabs themselves are App's.
 */
export function useEditorSync(
  editorTabs: Record<string, EditorTab[]>,
  layouts: Record<string, ProjectLayout>,
  states: Record<string, RepositoryState>
): { activeEditors: Record<string, string>; forgetCheckout: (key: string) => void } {
  /** Per checkout, per watched path: writes on disk — see diffVersion. */
  const [fileWrites, setFileWrites] = useState<Record<string, Record<string, number>>>({});
  const forgetCheckout = useCallback((key: string) => setFileWrites((current) => forget(current, key)), []);

  /**
   * Each checkout's active editor tab (`activeEditorTab`) — the file the Explorer reveals and
   * `tet-ctl editor-state` answers. Derived, not tracked: a tab is activated from many places (a
   * click, next/previous, a drop, a snap). Identity-stable where unchanged.
   */
  const activeEditorsRef = useRef<Record<string, string>>({});
  const activeEditors = useMemo(() => {
    const next: Record<string, string> = {};
    for (const [key, editors] of Object.entries(editorTabs)) {
      const tabId = activeEditorTab(
        layouts[key] ?? DEFAULT_LAYOUT,
        editors.map((tab) => tab.tabId),
        activeEditorsRef.current[key]
      );
      if (tabId !== undefined) {
        next[key] = tabId;
      }
    }
    activeEditorsRef.current = sameRecord(activeEditorsRef.current, next);
    return activeEditorsRef.current;
  }, [editorTabs, layouts]);
  useEffect(
    () =>
      window.tet.repository.onEditorContentRequest((checkout) => {
        const tabId = activeEditorsRef.current[checkoutKey(checkout)];
        return tabId === undefined ? undefined : editorContent(tabId);
      }),
    []
  );
  // Reported to main as App's `inFront` is: only the renderer knows. A checkout whose last editor
  // tab closed reports nothing; main finds no report under the old id.
  const reportedActive = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [key, tabId] of Object.entries(activeEditors)) {
      const checkout = editorTabs[key]?.find((tab) => tab.tabId === tabId)?.checkout;
      if (reportedActive.current[key] !== tabId && checkout) {
        window.tet.repository.reportActiveEditor(checkout, tabId);
      }
    }
    reportedActive.current = activeEditors;
  }, [activeEditors, editorTabs]);
  // Each editor tab's file, whose writes the watcher reports (onFileChanged): a checkout's open
  // paths, sent when they change — with its ref, kept for the empty list after its last tab.
  const watchedFiles = useRef<Record<string, { checkout: CheckoutRef; paths: string[] }>>({});
  useEffect(() => {
    const previous = watchedFiles.current;
    const next: Record<string, { checkout: CheckoutRef; paths: string[] }> = {};
    for (const [key, editors] of Object.entries(editorTabs)) {
      const [first] = editors;
      if (first) {
        const paths = sameList(previous[key]?.paths, editors.map((tab) => tab.path).sort(), NO_PATHS);
        next[key] = { checkout: first.checkout, paths };
      }
    }
    for (const [key, { checkout, paths }] of Object.entries(next)) {
      if (previous[key]?.paths !== paths) {
        void window.tet.repository.watchFiles(checkout, paths);
      }
    }
    for (const [key, { checkout }] of Object.entries(previous)) {
      if (!(key in next)) {
        void window.tet.repository.watchFiles(checkout, NO_PATHS);
      }
    }
    watchedFiles.current = next;
  }, [editorTabs]);
  useEffect(
    () =>
      // Only watched paths are reported; a count left by a closed tab is inert.
      window.tet.repository.onFileChanged(({ checkout, path }) => {
        const key = checkoutKey(checkout);
        setFileWrites((current) => ({
          ...current,
          [key]: { ...current[key], [path]: (current[key]?.[path] ?? 0) + 1 }
        }));
      }),
    []
  );
  // Reloads an open file only when its diffVersion changes, not on every push: a reload re-reads
  // and recolours the whole diff, hundreds of ms for a long file.
  useEffect(() => {
    for (const [key, editors] of Object.entries(editorTabs)) {
      for (const { tabId, path } of editors) {
        setEditorVersion(tabId, diffVersion(states[key], path, fileWrites[key]?.[path]));
      }
    }
  }, [editorTabs, states, fileWrites]);
  return { activeEditors, forgetCheckout };
}
