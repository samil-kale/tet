import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { refKeyOf } from "../../shared/types/project";
import type { RepositoryState } from "../../shared/types/git";
import type { ProjectRef } from "../../shared/types/project";
import { forget, sameList, sameRecord } from "../identity";
import type { EditorTab } from "../editor/editor-tab";
import { activeEditorTab, DEFAULT_LAYOUT, type ProjectLayout } from "./pane-layout";
import { editorContent, setEditorVersion } from "../editor/editor-views";

/** Shared instance, so a repository's or worktree's watched list is stable when empty. */
const NO_PATHS: string[] = [];

/** What an open file is re-read for: HEAD's branch and commit (so a pull or reset counts), the
 *  file's status, and a write on disk (`writes`), which leaves a modified file's status unchanged. */
function diffVersion(state: RepositoryState | undefined, filePath: string, writes: number | undefined): string {
  return `${state?.head}:${state?.headCommit}:${state?.changes.find((change) => change.path === filePath)?.status}:${writes ?? 0}`;
}

/**
 * What App keeps the editors and main in step with, derived from the editor tabs, the layouts and
 * the repository states, each by `refKey`: each repository's or worktree's active editor tab
 * — reported to main for `tet-ctl editor-state`, and answering its content request — the open paths
 * main watches for writes, and each tab's `diffVersion`, which decides a reload. `forgetProjectRef`
 * drops a closed repository's or worktree's write counts; the tabs themselves are App's.
 */
export function useEditorSync(
  editorTabs: Record<string, EditorTab[]>,
  layouts: Record<string, ProjectLayout>,
  states: Record<string, RepositoryState>,
): { activeEditors: Record<string, string>; forgetProjectRef: (refKey: string) => void } {
  /** Per repository or worktree, per watched path: writes on disk — see diffVersion. */
  const [fileWrites, setFileWrites] = useState<Record<string, Record<string, number>>>({});
  const forgetProjectRef = useCallback((refKey: string) => setFileWrites((current) => forget(current, refKey)), []);

  /**
   * Each repository's or worktree's active editor tab (`activeEditorTab`) — the file the Explorer
   * reveals and `tet-ctl editor-state` answers. Derived, not tracked: a tab is activated from many
   * places (a click, next/previous, a drop, a snap). Identity-stable where unchanged.
   */
  const activeEditorsRef = useRef<Record<string, string>>({});
  const activeEditors = useMemo(() => {
    const next: Record<string, string> = {};
    for (const [refKey, editors] of Object.entries(editorTabs)) {
      const tabId = activeEditorTab(
        layouts[refKey] ?? DEFAULT_LAYOUT,
        editors.map((tab) => tab.tabId),
        activeEditorsRef.current[refKey],
      );
      if (tabId !== undefined) {
        next[refKey] = tabId;
      }
    }
    activeEditorsRef.current = sameRecord(activeEditorsRef.current, next);
    return activeEditorsRef.current;
  }, [editorTabs, layouts]);
  useEffect(
    () =>
      window.tet.repository.onEditorContentRequest((ref) => {
        const tabId = activeEditorsRef.current[refKeyOf(ref)];
        return tabId === undefined ? undefined : editorContent(tabId);
      }),
    [],
  );
  // Reported to main as App's `onScreenTabIds` is: only the renderer knows. A repository or worktree whose
  // last editor tab closed reports nothing; main finds no report under the old id.
  const reportedActive = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [refKey, tabId] of Object.entries(activeEditors)) {
      const ref = editorTabs[refKey]?.find((tab) => tab.tabId === tabId)?.ref;
      if (reportedActive.current[refKey] !== tabId && ref) {
        window.tet.repository.reportActiveEditor(ref, tabId);
      }
    }
    reportedActive.current = activeEditors;
  }, [activeEditors, editorTabs]);
  // Each editor tab's file, whose writes the watcher reports (onFileChanged): a repository's or
  // worktree's open paths, sent when they change — with its ref, kept for the empty list after its
  // last tab.
  const watchedFiles = useRef<Record<string, { ref: ProjectRef; paths: string[] }>>({});
  useEffect(() => {
    const previous = watchedFiles.current;
    const next: Record<string, { ref: ProjectRef; paths: string[] }> = {};
    for (const [refKey, editors] of Object.entries(editorTabs)) {
      const [first] = editors;
      if (first) {
        const paths = sameList(
          previous[refKey]?.paths,
          editors
            .filter((tab) => !tab.commit)
            .map((tab) => tab.path)
            .sort(),
          NO_PATHS,
        );
        next[refKey] = { ref: first.ref, paths };
      }
    }
    for (const [refKey, { ref, paths }] of Object.entries(next)) {
      if (previous[refKey]?.paths !== paths) {
        void window.tet.repository.watchFiles(ref, paths);
      }
    }
    for (const [refKey, { ref }] of Object.entries(previous)) {
      if (!(refKey in next)) {
        void window.tet.repository.watchFiles(ref, NO_PATHS);
      }
    }
    watchedFiles.current = next;
  }, [editorTabs]);
  useEffect(
    () =>
      // Only watched paths are reported; a count left by a closed tab is inert.
      window.tet.repository.onFileChanged(({ ref, path }) => {
        const refKey = refKeyOf(ref);
        setFileWrites((current) => ({
          ...current,
          [refKey]: { ...current[refKey], [path]: (current[refKey]?.[path] ?? 0) + 1 },
        }));
      }),
    [],
  );
  // Reloads an open file only when its diffVersion changes, not on every push: a reload re-reads
  // and recolours the whole diff.
  useEffect(() => {
    for (const [refKey, editors] of Object.entries(editorTabs)) {
      for (const { tabId, path } of editors) {
        setEditorVersion(tabId, diffVersion(states[refKey], path, fileWrites[refKey]?.[path]));
      }
    }
  }, [editorTabs, states, fileWrites]);
  return { activeEditors, forgetProjectRef };
}
