import { memo, useEffect, useRef, useState } from "react";
import type { ExplorerListing, FileChange, FileContent, FileDiff, Project } from "../../shared/types";
import { ChangesList, confirmDiscard, type FileAct } from "./ChangesList";
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
} from "./icons";
import { confirm } from "./Dialog";
import { notify } from "./Notices";
import { useEscape } from "./use-escape";
import { ProgressBar } from "./ProgressBar";
import { MIN_CONTENT_WIDTH, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, Sash, usePaneSize } from "./Sash";

interface DiffDialogProps {
  project: Project;
  /** Repository-relative path of the file being looked at; null only for a project whose dialog
   *  has never had one — "Browse files" itself reopens whatever this project last showed
   *  (`App`'s `lastDiffPathKey`), so this is null in practice only before that first file. */
  path: string | null;
  /** What the diff depends on besides the file — a change to it reloads while the dialog is open. */
  version: string;
  /** The repository's changed files — the list beside the diff and its header's discard-all. */
  changes: FileChange[];
  /** The list's own choice of file — the same call the git pane's list makes. */
  onOpenDiff: (projectId: string, path: string) => void;
  onClose: () => void;
}

/** Asks before losing an edit that hasn't reached disk — the same wording wherever it's asked. */
async function confirmDiscardEdit(path: string): Promise<boolean> {
  const answer = await confirm({
    title: "Unsaved changes",
    message: `Discard unsaved changes to ${path}?`,
    confirmLabel: "Discard changes"
  });
  return answer.confirmed;
}

/**
 * One file, over the whole window — a diff, or (see CLAUDE.md) an editor for the same file when
 * it has none, or the user asked for one anyway. A dialog rather than a pane for the same reason
 * as always: the git view has no room for it, and looking at (or briefly fixing) a file is
 * something you come out of again, unlike the branch list next to it. EXPLORER over LOCAL CHANGES
 * on the left mirrors the git pane's own BRANCHES-over-LOCAL-CHANGES shape — a browser for any
 * file above the changed ones, with GitHub Desktop's own file actions and VS Code's
 * new/rename/delete (see `Explorer`); still no ↑/↓ of its own — that stays with `ChangesList` — and a single click
 * opens rather than needing a double one.
 *
 * Not part of Dialog.tsx: that file puts *questions* (confirm, prompt) and is built around a
 * form with two buttons. This asks nothing itself — it delegates the one question it does need
 * (discard unsaved changes?) to that file, same as everything else that asks one.
 */
export const DiffDialog = memo(function DiffDialog({ project, path, version, changes, onOpenDiff, onClose }: DiffDialogProps) {
  const change = path ? changes.find((entry) => entry.path === path) : undefined;
  const diffable = change !== undefined;

  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  /** Reading the diff and colouring it, `DiffView`'s own two waits. */
  const [diffBusy, setDiffBusy] = useState(false);
  /** A file action started from the list beside the diff — that pane's own bar. */
  const [acting, setActing] = useState(false);

  /** The user's own Diff/Edit choice — reset below whenever `path` changes, not on every render:
   *  a save can flip `diffable` from false to true without the file leaving Edit mode. */
  const [mode, setMode] = useState<"diff" | "edit">(diffable ? "diff" : "edit");
  const [modeForPath, setModeForPath] = useState(path);
  if (modeForPath !== path) {
    setModeForPath(path);
    setMode(diffable ? "diff" : "edit");
  }

  const [file, setFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const editorRef = useRef<CodeEditorHandle>(null);
  const explorerRef = useRef<ExplorerHandle>(null);

  /** Bumped after a successful save so the diff reloads even when the watcher's own push does
   *  not — `Repository.emit` only pushes a changed *state*, and modified→modified isn't one. */
  const [savedAt, setSavedAt] = useState(0);

  const [explorerListing, setExplorerListing] = useState<ExplorerListing | undefined>(undefined);
  const [listing, setListing] = useState(false);
  /** Bumped by the Explorer tree's own create/rename/delete — the only kind of change to the
   *  listing `changesKey` below never catches, since an empty new folder never touches git
   *  status the way a new file does. */
  const [explorerVersion, setExplorerVersion] = useState(0);
  const [treeHeight, setTreeHeight] = usePaneSize("diff-explorer", 300, MIN_PANE_HEIGHT);
  const [filesWidth, setFilesWidth] = usePaneSize("diff-files", 260, MIN_PANE_WIDTH);
  const root = useRef<HTMLDivElement>(null);

  const canEdit = diffable ? change?.status !== "deleted" && !diff?.binary : !file?.binary && !file?.tooLarge;
  const effective: "diff" | "edit" = diffable ? (canEdit ? mode : "diff") : "edit";

  // Reloads whenever the file, the repository state, the whitespace switch or a save changes it.
  // Not run at all for a file with nothing to diff — a tree file the changes list never named
  // costs no git process just for being looked at.
  useEffect(() => {
    if (!path || !diffable) {
      setDiff(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.tet.repository.diff(project.id, path, { ignoreWhitespace }).then((result) => {
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
  }, [project.id, path, version, ignoreWhitespace, diffable, savedAt]);

  // The file's content — read whenever there's nothing to diff (Edit is the only mode there is)
  // or the user has switched to Edit for a file that also has one. Not on `version`/`savedAt`: a
  // change from outside is instead folded into the open model in place, below, so it never
  // clobbers what's being typed.
  const wantsFile = path !== null && (!diffable || mode === "edit");
  useEffect(() => {
    if (!path || !wantsFile) {
      setFile(null);
      return;
    }
    let cancelled = false;
    // Cleared before every read, not only when nothing wants a file: switching A→B and back
    // fast enough lands here with `file` still holding A's *earlier* read — and an editor
    // mounted from that copy, handed the fresh read's mtime, would save stale text right past
    // the mtime guard.
    setFile(null);
    setFileLoading(true);
    void window.tet.repository.readFile(project.id, path).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.error) {
        notify("error", `${result.path}: ${result.error}`);
      }
      setFile(result);
      setFileLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, path, wantsFile]);

  // An outside edit (an agent, a terminal) changing the open file while it sits clean in the
  // editor — folded into the model in place rather than remounting it, so undo history and the
  // cursor survive. Left alone while dirty: the user's own unsaved edit wins until they act on
  // it themselves (switch away, or save over a stale file and hit the mtime guard).
  // Deliberately keyed on `version` alone — see the file read above for why not `file` itself.
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

  // The Explorer tree — read on open, again whenever a file starts or stops existing (added,
  // removed, renamed, untracked), again after the tree's own create/rename/delete, and again
  // when the project's tet.json changed, since the listing carries that file's `folders`,
  // `exclude` and sort settings — whoever wrote it, the tree's own menu, an editor or an agent.
  // A plain edit leaves `changes` at "modified" for a path already in the tree, so it alone
  // does not re-list.
  useEffect(
    () =>
      window.tet.commands.onChanged((payload) => {
        if (payload.projectId === project.id) {
          setExplorerVersion((count) => count + 1);
        }
      }),
    [project.id]
  );
  const changesKey = changes
    .filter((entry) => entry.status !== "modified")
    .map((entry) => entry.path)
    .join("\n");
  useEffect(() => {
    let cancelled = false;
    setListing(true);
    void window.tet.repository.listExplorer(project.id).then((result) => {
      if (!cancelled) {
        setExplorerListing(result);
        setListing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, changesKey, explorerVersion]);

  // Takes the keyboard while it is up and hands it back on the way out: ↑/↓ step through the
  // files, and the terminal a path was ctrl-clicked in would otherwise still be the one
  // getting them — xterm swallows every key it is given, arrows first of all.
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, []);

  // Back from Edit to Diff (a toggle, a file that stops being edit-only) — refocus the root so
  // ↑/↓ reach `ChangesList` again rather than whatever the editor left focused.
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
    // Reaches here only when nothing inside — the editor included — already claimed the key: a
    // save from the editor's own Ctrl+S never gets this far, so there is no double save.
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
              {/* VS Code's own trio, in its order — "Refresh Explorer" is left out: the watcher
                  already keeps this tree current on its own (see `onExplorerChanged`). */}
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
              onExplorerChanged={() => setExplorerVersion((count) => count + 1)}
            />
          </div>
          <Sash orientation="horizontal" size={treeHeight} min={MIN_PANE_HEIGHT} minOther={MIN_PANE_HEIGHT} onResize={setTreeHeight} />
          <div className="section grows">
            <div className="section-header">
              <span>
                LOCAL CHANGES <span className="count-badge">({changes.length})</span>
              </span>
              {/* Only "Discard all" here, unlike the git pane's three — commit and stash both
                  name what they do to the *repository* (a message, a stash entry), which reads
                  oddly next to a dialog that is otherwise about one file. Narrower than "all of
                  it" is the list's own context menu, shared with that pane's list too. Gated on
                  `acting` alone, not a `branch.busy` as well: unlike that pane, nothing here sits
                  next to a BRANCHES section a fetch/pull/push could be run from while this dialog
                  is up — it covers the whole window. */}
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
              changes={changes}
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
            // Mounted only once `file` actually belongs to `path` — the fetch a path change
            // starts is async, and rendering the editor before it lands would seed a fresh
            // model with the *previous* file's text under the new file's path.
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
