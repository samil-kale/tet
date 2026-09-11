import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ExplorerListing, FileChange, FileContent, FileDiff, Project, RepositoryState } from "../../shared/types";
import { ChangesList, confirmDiscard, type FileAct } from "../git/ChangesList";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { DiffView } from "./DiffView";
import { Explorer, type ExplorerHandle } from "./Explorer";
import {
  CloseIcon,
  CollapseAllIcon,
  DiscardIcon,
  NewFileIcon,
  NewFolderIcon,
  PencilIcon,
  SaveIcon,
  WhitespaceIcon
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

/** One file over the whole window: a diff, or an editor for it. EXPLORER over LOCAL CHANGES on
 *  the left mirrors the git pane's shape. Its one question goes through `Dialog.tsx`. */
export const DiffDialog = memo(function DiffDialog({ project, path, version, state, onOpenDiff, onClose }: DiffDialogProps) {
  useCoversWindow();
  const { changes } = state;
  const change = path ? changes.find((entry) => entry.path === path) : undefined;
  const diffable = change !== undefined;

  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  /** `DiffView`'s two waits: reading the diff and colouring it. */
  const [diffBusy, setDiffBusy] = useState(false);
  /** A file action started from the list beside the diff — that pane's own bar. */
  const [acting, setActing] = useState(false);

  /** The user's Diff/Edit choice, reset on a `path` change only: a save can flip `diffable` from
   *  false to true without the file leaving Edit mode. */
  const [mode, setMode] = useState<"diff" | "edit">(diffable ? "diff" : "edit");
  const [modeForPath, setModeForPath] = useState(path);
  if (modeForPath !== path) {
    setModeForPath(path);
    setMode(diffable ? "diff" : "edit");
  }

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const editorRef = useRef<CodeEditorHandle>(null);
  const explorerRef = useRef<ExplorerHandle>(null);

  /** Bumped after a successful save: `Repository.emit` only pushes a changed state, and
   *  modified→modified isn't one, so the watcher alone would not reload the diff. */
  const [savedAt, setSavedAt] = useState(0);

  const [treeHeight, setTreeHeight] = usePaneSize("diff-explorer", 300, MIN_PANE_HEIGHT);
  const [filesWidth, setFilesWidth] = usePaneSize("diff-files", 260, MIN_PANE_WIDTH);
  const root = useRef<HTMLDivElement>(null);

  const { diff, loading } = useDiff(project.id, path, diffable, ignoreWhitespace, version, savedAt);
  // The file is read when there is nothing to diff or the user switched to Edit.
  const wantsFile = path !== null && (!diffable || mode === "edit");
  const { file, setFile, loading: fileLoading } = useFileContent(project.id, path, wantsFile);

  const canEdit = diffable ? change?.status !== "deleted" && !diff?.binary : !file?.binary && !file?.tooLarge;
  const effective: "diff" | "edit" = diffable ? (canEdit ? mode : "diff") : "edit";

  // An outside edit while the file sits clean in the editor, folded into the model in place so
  // undo history and the cursor survive. Left alone while dirty; keyed on `version` alone.
  useEffect(() => {
    if (!path || effective !== "edit" || dirty || !file || file.error) {
      return;
    }
    let cancelled = false;
    void window.tet.repository.readFile(project.id, path).then((result) => {
      if (cancelled || result.error || result.mtimeMs === file.mtimeMs) {
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

  // Back from Edit to Diff: refocus the root so ↑/↓ reach `ChangesList` again.
  useEffect(() => {
    if (effective === "diff") {
      root.current?.focus();
    }
  }, [effective]);

  const guardDirty = async (): Promise<boolean> => !dirty || (path !== null && (await confirmDiscardEdit(path)));

  const requestOpen = async (next: string): Promise<void> => {
    if (!(await guardDirty())) {
      return;
    }
    setDirty(false);
    onOpenDiff(project.id, next);
  };

  const requestToggle = async (): Promise<void> => {
    if (!(await guardDirty())) {
      return;
    }
    setDirty(false);
    setMode((current) => (current === "edit" ? "diff" : "edit"));
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
      setSavedAt((count) => count + 1);
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

  const busy = diffBusy || fileLoading || editorLoading || saving;

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
            {effective === "diff" && diff && !diff.binary && (
              <button
                className={`icon-button${ignoreWhitespace ? " active" : ""}`}
                title={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
                onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
              >
                <WhitespaceIcon />
              </button>
            )}
            {diffable && canEdit && (
              <button
                className={`icon-button${effective === "edit" ? " active" : ""}`}
                title={effective === "edit" ? "Show diff" : "Edit file"}
                onClick={() => void requestToggle()}
              >
                <PencilIcon />
              </button>
            )}
            {path !== null && effective === "edit" && (
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
          ) : effective === "diff" ? (
            <DiffView
              projectId={project.id}
              diff={diff}
              loading={loading}
              onBusy={setDiffBusy}
              ignoreWhitespace={ignoreWhitespace}
            />
          ) : !file || file.path !== path ? null : file.error ? (
            <div className="placeholder">{file.error}</div>
          ) : file.image ? (
            <div className="image-diff">
              <figure>
                <img src={file.image} alt="" />
              </figure>
            </div>
          ) : file.binary ? (
            <div className="placeholder">Binary file.</div>
          ) : file.tooLarge ? (
            <div className="placeholder">File too large to edit.</div>
          ) : (
            // Mounted only once `file` belongs to `path`: mounting before the fetch lands would seed a
            // fresh model with the previous file's text under the new file's path.
            <CodeEditor
              ref={editorRef}
              path={path}
              content={file.content}
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
 * The file's diff, reloaded on the file, the repository state, the whitespace switch or a save.
 * A file with nothing to diff costs no git process just for being looked at.
 */
function useDiff(
  projectId: string,
  path: string | null,
  diffable: boolean,
  ignoreWhitespace: boolean,
  version: string,
  savedAt: number
): { diff: FileDiff | null; loading: boolean } {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!path || !diffable) {
      setDiff(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.tet.repository.diff(projectId, path, { ignoreWhitespace }).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.error) {
        notify("error", `${result.path}: ${result.error}`);
      }
      setDiff(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, version, ignoreWhitespace, diffable, savedAt]);
  return { diff, loading };
}

/**
 * The file as it is on disk, read only while `wanted`. Not keyed on the repository state: a change
 * from outside is folded into the open editor model in place, and a save updates what is held
 * here — hence `setFile`.
 */
function useFileContent(
  projectId: string,
  path: string | null,
  wanted: boolean
): { file: FileContent | null; setFile: Dispatch<SetStateAction<FileContent | null>>; loading: boolean } {
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path || !wanted) {
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
  }, [projectId, path, wanted]);
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
