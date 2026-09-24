import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RepositoryState } from "../../shared/types";
import { forget, sameList, sameRecord } from "../identity";
import type { EditorTab } from "../terminal/editor-tab";
import { activeEditorTab, defaultLayout, type ProjectLayout } from "../terminal/pane-layout";
import { editorContent, setEditorVersion } from "./editor-views";

/** Shared instance, so a project's watched list is stable when empty. */
const NO_PATHS: string[] = [];

const DEFAULT_LAYOUT = defaultLayout();

/** What an open file is re-read for: HEAD's branch and commit (so a pull or reset counts), the
 *  file's status, and a write on disk (`writes`), which leaves a modified file's status unchanged. */
function diffVersion(state: RepositoryState | undefined, filePath: string, writes: number | undefined): string {
  return `${state?.head}:${state?.headCommit}:${state?.changes.find((change) => change.path === filePath)?.status}:${writes ?? 0}`;
}

/**
 * What App keeps the editors and main in step with, derived from the editor tabs, the layouts
 * and the repository states: each project's active editor tab — reported to main for
 * `tet-ctl editor-state`, and answering its content request — the open paths main watches for
 * writes, and each tab's `diffVersion`, which decides a reload. `forgetProject` drops a closed
 * project's write counts; the tabs themselves are App's.
 */
export function useEditorSync(
  editorTabs: Record<string, EditorTab[]>,
  layouts: Record<string, ProjectLayout>,
  states: Record<string, RepositoryState>
): { activeEditors: Record<string, string>; forgetProject: (projectId: string) => void } {
  /** Per project, per watched path: writes on disk — see diffVersion. */
  const [fileWrites, setFileWrites] = useState<Record<string, Record<string, number>>>({});
  const forgetProject = useCallback((projectId: string) => setFileWrites((current) => forget(current, projectId)), []);

  /**
   * Each project's active editor tab (`activeEditorTab`) — the file the Explorer reveals and
   * `tet-ctl editor-state` answers. Derived, not tracked: a tab is activated from many places (a
   * click, next/previous, a drop, a snap). Identity-stable where unchanged.
   */
  const activeEditorsRef = useRef<Record<string, string>>({});
  const activeEditors = useMemo(() => {
    const next: Record<string, string> = {};
    for (const [projectId, editors] of Object.entries(editorTabs)) {
      const tabId = activeEditorTab(
        layouts[projectId] ?? DEFAULT_LAYOUT,
        editors.map((tab) => tab.tabId),
        activeEditorsRef.current[projectId]
      );
      if (tabId !== undefined) {
        next[projectId] = tabId;
      }
    }
    activeEditorsRef.current = sameRecord(activeEditorsRef.current, next);
    return activeEditorsRef.current;
  }, [editorTabs, layouts]);
  useEffect(
    () =>
      window.tet.repository.onEditorContentRequest((projectId) => {
        const tabId = activeEditorsRef.current[projectId];
        return tabId === undefined ? undefined : editorContent(tabId);
      }),
    []
  );
  // Reported to main as App's `inFront` is: only the renderer knows. A project whose last editor
  // tab closed reports nothing; main finds no report under the old id.
  const reportedActive = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [projectId, tabId] of Object.entries(activeEditors)) {
      if (reportedActive.current[projectId] !== tabId) {
        window.tet.repository.reportActiveEditor(projectId, tabId);
      }
    }
    reportedActive.current = activeEditors;
  }, [activeEditors]);
  // Each editor tab's file, whose writes the watcher reports (onFileChanged): a project's open
  // paths, sent when they change.
  const watchedFiles = useRef<Record<string, string[]>>({});
  useEffect(() => {
    const previous = watchedFiles.current;
    const next: Record<string, string[]> = {};
    for (const [projectId, editors] of Object.entries(editorTabs)) {
      next[projectId] = sameList(previous[projectId], editors.map((tab) => tab.path).sort(), NO_PATHS);
    }
    for (const [projectId, paths] of Object.entries(next)) {
      if (previous[projectId] !== paths) {
        void window.tet.repository.watchFiles(projectId, paths);
      }
    }
    for (const projectId of Object.keys(previous)) {
      if (!(projectId in next)) {
        void window.tet.repository.watchFiles(projectId, NO_PATHS);
      }
    }
    watchedFiles.current = next;
  }, [editorTabs]);
  useEffect(
    () =>
      // Only watched paths are reported; a count left by a closed tab is inert.
      window.tet.repository.onFileChanged(({ projectId, path }) => {
        setFileWrites((current) => ({
          ...current,
          [projectId]: { ...current[projectId], [path]: (current[projectId]?.[path] ?? 0) + 1 }
        }));
      }),
    []
  );
  // Reloads an open file only when its diffVersion changes, not on every push: a reload re-reads
  // and recolours the whole diff, hundreds of ms for a long file.
  useEffect(() => {
    for (const [projectId, editors] of Object.entries(editorTabs)) {
      for (const { tabId, path } of editors) {
        setEditorVersion(tabId, diffVersion(states[projectId], path, fileWrites[projectId]?.[path]));
      }
    }
  }, [editorTabs, states, fileWrites]);
  return { activeEditors, forgetProject };
}
