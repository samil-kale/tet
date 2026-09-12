import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ExplorerListing, FileChange, FileContent, Project, RepositoryState } from "../../shared/types";
import { ChangesList, confirmDiscard, type FileAct } from "../git/ChangesList";
import { DiffEditor, type DiffEditorHandle } from "./DiffEditor";
import { ImageView } from "./ImageView";
import { Explorer, type ExplorerHandle } from "./Explorer";
import {
  CloseIcon,
  CollapseAllIcon,
  DiscardIcon,
  NewFileIcon,
  NewFolderIcon,
  SaveIcon
} from "../ui/icons";
import { confirm } from "../ui/Dialog";
import { notify } from "../ui/Notices";
import { useEscape } from "../ui/use-escape";
import { useCoversWindow } from "../ui/window-covered";
import { ProgressBar } from "../ui/ProgressBar";
import { MIN_CONTENT_WIDTH, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, Sash, usePaneSize } from "../ui/Sash";

interface DiffDialogProps {
  project: Project;
  /** Repository-relative path of the file shown; null only before this project's dialog has ever
   *  had one ("Browse files" reopens the last, `App`'s `lastDiffPathKey`). */
  path: string | null;
  /** What the diff depends on besides the file — a change to it reloads while the dialog is open. */
  version: string;
  /** The repository — its changed files are the list beside the diff and its header's discard-all. */
  state: RepositoryState;
  /** The list's own choice of file — the same call the git pane's list makes. */
  onOpenDiff: (projectId: string, path: string) => void;
  onClose: () => void;
}

/** Asks before losing an edit that hasn't reached disk. */
async function confirmDiscardEdit(path: string): Promise<boolean> {
  const answer = await confirm({
    title: "Unsaved changes",
    message: `Discard unsaved changes to ${path}?`,
    confirmLabel: "Discard changes"
  });
  return answer.confirmed;
}

/** One file over the whole window, in the one widget that shows its changes and edits them.
 *  EXPLORER over LOCAL CHANGES on the left mirrors the git pane's shape. Its one question goes
 *  through `Dialog.tsx`. */
export const DiffDialog = memo(function DiffDialog({ project, path, version, state, onOpenDiff, onClose }: DiffDialogProps) {
  useCoversWindow();
  const { changes } = state;

  /** A file action started from the list beside the diff — that pane's own bar. */
  const [acting, setActing] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const editorRef = useRef<DiffEditorHandle>(null);
  const explorerRef = useRef<ExplorerHandle>(null);

  const [treeHeight, setTreeHeight] = usePaneSize("diff-explorer", 300, MIN_PANE_HEIGHT);
  const [filesWidth, setFilesWidth] = usePaneSize("diff-files", 260, MIN_PANE_WIDTH);
  const root = useRef<HTMLDivElement>(null);

  const { file, setFile, loading: fileLoading } = useFileContent(project.id, path);

  /** Nothing to save: a file that is gone, or one there is no editor for. */
  const readOnly = Boolean(file?.deleted || file?.binary || file?.tooLarge || file?.error);

  // What changed outside, folded in on a HEAD or status change. The edited side only while it is
  // clean, in place so undo history and the cursor survive; HEAD's side always, because a commit
  // or a checkout under an open edit moves what the marks are against.
  useEffect(() => {
    if (!path || !file || file.error) {
      return;
    }
    let cancelled = false;
    void window.tet.repository.readFile(project.id, path).then((result) => {
      if (cancelled || result.error) {
        return;
      }
      const head = result.head;
      if (head && head.content !== file.head?.content) {
        editorRef.current?.setOriginal(head.content);
        // Held here too, even while dirty: otherwise every later refresh compares against the
        // side this one already replaced and writes it again.
        setFile((current) => (current ? { ...current, head } : current));
      }
      if (dirty || result.mtimeMs === file.mtimeMs) {
        return;
      }
      setFile(result);
      editorRef.current?.setContent(result.content);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const { explorerListing, listing, refreshExplorer } = useExplorerListing(project.id, changes);

  // Takes the keyboard while it is up and hands it back: xterm swallows every key it is given,
  // arrows first of all, so a terminal left focused would eat ↑/↓.
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);

  const guardDirty = async (): Promise<boolean> => !dirty || (path !== null && (await confirmDiscardEdit(path)));

  const requestOpen = async (next: string): Promise<void> => {
    if (!(await guardDirty())) {
      return;
    }
    setDirty(false);
    onOpenDiff(project.id, next);
  };

  const requestClose = async (): Promise<void> => {
    if (!(await guardDirty())) {
      return;
    }
    onClose();
  };

  useEscape(() => void requestClose(), { deferWithin: ".monaco-editor" });

  const save = async (): Promise<void> => {
    if (!path || !dirty || !file || !editorRef.current) {
      return;
    }
    setSaving(true);
    const content = editorRef.current.getValue();
    const result = await window.tet.repository.writeFile(project.id, path, content, file.mtimeMs);
    if (result.ok) {
      setFile((current) => (current ? { ...current, content, mtimeMs: result.mtimeMs ?? current.mtimeMs } : current));
      editorRef.current.markSaved();
    } else {
      notify("error", result.error ?? "Could not save the file");
    }
    setSaving(false);
  };

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Reaches here only when nothing inside claimed the key, so the editor's own Ctrl+S never
    // gets this far and there is no double save.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  const act: FileAct = (action) => {
    setActing(true);
    void action()
      .then((result) => {
        if (!result.ok) {
          notify("error", result.error ?? "Git command failed");
        }
      })
      .finally(() => setActing(false));
  };

  const busy = fileLoading || editorLoading || saving;

  return (
    <div className="diff-dialog-overlay">
      <div className="diff-dialog" ref={root} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <div className="diff-dialog-files" style={{ width: filesWidth }}>
          <div className="section" style={{ height: treeHeight }}>
            <div className="section-header">
              <span>
                EXPLORER <span className="count-badge">({explorerListing?.files.length ?? 0})</span>
              </span>
              <span className="section-header-actions">
                <button
                  className="icon-button"
                  title="New File..."
                  disabled={acting || !explorerListing}
                  onClick={() => explorerRef.current?.newFile()}
                >
                  <NewFileIcon />
                </button>
                <button
                  className="icon-button"
                  title="New Folder..."
                  disabled={acting || !explorerListing}
                  onClick={() => explorerRef.current?.newFolder()}
                >
                  <NewFolderIcon />
                </button>
                <button
                  className="icon-button"
                  title="Collapse Folders in Explorer"
                  disabled={!explorerListing}
                  onClick={() => explorerRef.current?.collapseAll()}
                >
                  <CollapseAllIcon />
                </button>
              </span>
              {listing && <ProgressBar />}
            </div>
            <Explorer
              ref={explorerRef}
              project={project}
              files={explorerListing}
              selected={path}
              onOpen={(next) => void requestOpen(next)}
              act={act}
              onExplorerChanged={refreshExplorer}
            />
          </div>
          <Sash orientation="horizontal" size={treeHeight} min={MIN_PANE_HEIGHT} minOther={MIN_PANE_HEIGHT} onResize={setTreeHeight} />
          <div className="section grows">
            <div className="section-header">
              <span>
                LOCAL CHANGES <span className="count-badge">({changes.length})</span>
              </span>
              {/* Only "Discard all" here: commit and stash act on the repository, which reads oddly in a
                  dialog about one file. Gated on `acting` alone, no BRANCHES section being reachable. */}
              <span className="section-header-actions">
                <button
                  className="icon-button"
                  title="Discard all changes"
                  disabled={acting || changes.length === 0}
                  onClick={() => void confirmDiscard(project.id, changes.map((entry) => entry.path), act)}
                >
                  <DiscardIcon />
                </button>
              </span>
              {acting && <ProgressBar />}
            </div>
            <ChangesList
              project={project}
              state={state}
              act={act}
              onOpenDiff={(next) => void requestOpen(next)}
              active={path}
            />
          </div>
        </div>
        <Sash
          orientation="vertical"
          size={filesWidth}
          min={MIN_PANE_WIDTH}
          minOther={MIN_CONTENT_WIDTH}
          onResize={setFilesWidth}
        />
        <div className="diff-dialog-main">
          <div className="diff-dialog-bar">
            {dirty && <span className="diff-dialog-dirty">●</span>}
            <span className="diff-dialog-path">{path ?? "No file open"}</span>
            {path !== null && !readOnly && (
              <button
                className="icon-button"
                title="Save (Ctrl+S)"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                <SaveIcon />
              </button>
            )}
            <button className="icon-button" title="Close" onClick={() => void requestClose()}>
              <CloseIcon />
            </button>
            {busy && <ProgressBar />}
          </div>
          {path === null ? (
            <div className="placeholder">Select a file.</div>
          ) : !file || file.path !== path ? null : file.error ? (
            <div className="placeholder">{file.error}</div>
          ) : file.image || file.head?.image ? (
            <ImageView image={{ before: file.head?.image, after: file.image }} />
          ) : file.binary || file.head?.binary ? (
            <div className="placeholder">Binary file.</div>
          ) : file.tooLarge ? (
            <div className="placeholder">File too large to edit.</div>
          ) : (
            // Mounted only once `file` belongs to `path`: mounting before the fetch lands would seed a
            // fresh model with the previous file's text under the new file's path. With no HEAD side
            // the file is its own original, which leaves nothing marked — a plain editor.
            <DiffEditor
              ref={editorRef}
              path={path}
              content={file.content}
              original={file.head?.content ?? file.content}
              readOnly={readOnly}
              onDirty={setDirty}
              onSave={() => void save()}
              onBusy={setEditorLoading}
            />
          )}
        </div>
      </div>
    </div>
  );
});


/**
 * The file as it is on disk and as HEAD has it — the diff editor's two sides, in one read. Not
 * keyed on the repository state: a change from outside is folded into the open models in place,
 * and a save updates what is held here — hence `setFile`.
 */
function useFileContent(
  projectId: string,
  path: string | null
): { file: FileContent | null; setFile: Dispatch<SetStateAction<FileContent | null>>; loading: boolean } {
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path) {
      setFile(null);
      return;
    }
    let cancelled = false;
    // Cleared before every read: switching A→B and back fast enough lands here with `file` still
    // holding A's earlier read, and an editor mounted from that copy but handed the fresh read's
    // mtime would save stale text right past the mtime guard.
    setFile(null);
    setLoading(true);
    void window.tet.repository.readFile(projectId, path).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.error) {
        notify("error", `${result.path}: ${result.error}`);
      }
      setFile(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);
  return { file, setFile, loading };
}

/**
 * The Explorer tree's listing, which carries the `folders`, `exclude` and sort settings with it.
 * Re-read whenever a file starts or stops existing, when tet.json changed, and through
 * `refreshExplorer` after the tree's own create/rename/delete — an empty new folder never touches
 * git status, and a plain edit leaves `changes` at "modified", so neither shows up there.
 */
function useExplorerListing(
  projectId: string,
  changes: FileChange[]
): { explorerListing: ExplorerListing | undefined; listing: boolean; refreshExplorer: () => void } {
  const [explorerListing, setExplorerListing] = useState<ExplorerListing | undefined>(undefined);
  const [listing, setListing] = useState(false);
  const [explorerVersion, setExplorerVersion] = useState(0);
  const refreshExplorer = useCallback(() => setExplorerVersion((count) => count + 1), []);
  useEffect(
    () =>
      window.tet.commands.onChanged((payload) => {
        if (payload.projectId === projectId) {
          setExplorerVersion((count) => count + 1);
        }
      }),
    [projectId]
  );
  const changesKey = useMemo(
    () =>
      changes
        .filter((entry) => entry.status !== "modified")
        .map((entry) => entry.path)
        .join("\n"),
    [changes]
  );
  useEffect(() => {
    let cancelled = false;
    setListing(true);
    void window.tet.repository.listExplorer(projectId).then((result) => {
      if (!cancelled) {
        setExplorerListing(result);
        setListing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, changesKey, explorerVersion]);
  return { explorerListing, listing, refreshExplorer };
}
