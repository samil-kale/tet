import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectRefKey } from "../../shared/types";
import type { ProjectRef, RepositoryState } from "../../shared/types";
import { forget, sameList, sameRecord } from "../identity";
import type { EditorTab } from "../terminal/editor-tab";
import { activeEditorTab, defaultLayout, type ProjectLayout } from "../terminal/pane-layout";
import { editorContent, setEditorVersion } from "./editor-views";

/** Shared instance, so a repository's or worktree's watched list is stable when empty. */
const NO_PATHS: string[] = [];

const DEFAULT_LAYOUT = defaultLayout();

/** What an open file is re-read for: HEAD's branch and commit (so a pull or reset counts), the
 *  file's status, and a write on disk (`writes`), which leaves a modified file's status unchanged. */
function diffVersion(state: RepositoryState | undefined, filePath: string, writes: number | undefined): string {
  return `${state?.head}:${state?.headCommit}:${state?.changes.find((change) => change.path === filePath)?.status}:${writes ?? 0}`;
}

/**
 * What App keeps the editors and main in step with, derived from the editor tabs, the layouts and
 * the repository states, each by `projectRefKey`: each repository's or worktree's active editor tab
 * — reported to main for `tet-ctl editor-state`, and answering its content request — the open paths
 * main watches for writes, and each tab's `diffVersion`, which decides a reload. `forgetProjectRef`
 * drops a closed repository's or worktree's write counts; the tabs themselves are App's.
 */
export function useEditorSync(
  editorTabs: Record<string, EditorTab[]>,
  layouts: Record<string, ProjectLayout>,
  states: Record<string, RepositoryState>
): { activeEditors: Record<string, string>; forgetProjectRef: (key: string) => void } {
  /** Per repository or worktree, per watched path: writes on disk — see diffVersion. */
  const [fileWrites, setFileWrites] = useState<Record<string, Record<string, number>>>({});
  const forgetProjectRef = useCallback((key: string) => setFileWrites((current) => forget(current, key)), []);

  /**
   * Each repository's or worktree's active editor tab (`activeEditorTab`) — the file the Explorer
   * reveals and `tet-ctl editor-state` answers. Derived, not tracked: a tab is activated from many
   * places (a click, next/previous, a drop, a snap). Identity-stable where unchanged.
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
      window.tet.repository.onEditorContentRequest((ref) => {
        const tabId = activeEditorsRef.current[projectRefKey(ref)];
        return tabId === undefined ? undefined : editorContent(tabId);
      }),
    []
  );
  // Reported to main as App's `inFront` is: only the renderer knows. A repository or worktree whose
  // last editor tab closed reports nothing; main finds no report under the old id.
  const reportedActive = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [key, tabId] of Object.entries(activeEditors)) {
      const ref = editorTabs[key]?.find((tab) => tab.tabId === tabId)?.ref;
      if (reportedActive.current[key] !== tabId && ref) {
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
    for (const [key, editors] of Object.entries(editorTabs)) {
      const [first] = editors;
      if (first) {
        const paths = sameList(previous[key]?.paths, editors.map((tab) => tab.path).sort(), NO_PATHS);
        next[key] = { ref: first.ref, paths };
      }
    }
    for (const [key, { ref, paths }] of Object.entries(next)) {
      if (previous[key]?.paths !== paths) {
        void window.tet.repository.watchFiles(ref, paths);
      }
    }
    for (const [key, { ref }] of Object.entries(previous)) {
      if (!(key in next)) {
        void window.tet.repository.watchFiles(ref, NO_PATHS);
      }
    }
    watchedFiles.current = next;
  }, [editorTabs]);
  useEffect(
    () =>
      // Only watched paths are reported; a count left by a closed tab is inert.
      window.tet.repository.onFileChanged(({ ref, path }) => {
        const key = projectRefKey(ref);
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
  return { activeEditors, forgetProjectRef };
}
