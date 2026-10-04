import type { editor as MonacoEditor } from "monaco-editor";
import { refKeyOf } from "../../shared/types/project";
import type { FileContent } from "../../shared/types/files";
import type { ProjectRef } from "../../shared/types/project";
import { PLATFORM } from "../platform";
import { confirmed, confirmedFollowUp } from "../ui/Dialog";
import { layoutFlag } from "../ui/layout-storage";
import { notify } from "../ui/Notices";
import { isMarkdown, languageForPath, subscribeHighlightTheme } from "./diff-highlight";
import { diffEditorOptions, editorOptions, ensureLanguage, loadMonaco, type Monaco } from "./editor";
import { parseKeyCombo, resolveKeybindings } from "./keybindings";
import { createMarkdownPreview, lineAtScroll, renderMarkdown, resolveLink, scrollToLine, type ColoredBlocks } from "./markdown";
import type { EditorReveal, OpenEditor } from "./editor-tab";
import { openFile } from "./editor-tab";
import { editorFontFamily } from "../themes/theme-colors";

/**
 * Each editor tab's editor, outside React like the xterms (`terminal-views.ts`): monaco's
 * element, the diff editor and the file, one set per tab (`editor-tab.ts`), and a Markdown file's
 * preview beside it. The elements follow a tab moved between panes, so an edit survives the move,
 * where React would rebuild the editor.
 *
 * A tab holds two editors, as VS Code has two editor kinds: monaco's diff editor against HEAD, and
 * a plain one for the file alone (`showDiff`). Both are made on the same modified model, so the
 * edit, its undo stack and the dirty mark carry over; each is built the first time its side is
 * shown, and the one off screen keeps its box (`applyMode`).
 */

/** Typing re-renders the Markdown preview once it pauses: each render parses, sanitizes and colors the
 *  whole file. */
const MARKDOWN_PREVIEW_RENDER_DELAY_MS = 150;
/** How long a scroll one side drove is expected to echo back from the other, which must not then
 *  drive it again (VS Code keeps the two in step the same way, by counting the echoes). */
const SCROLL_ECHO_MS = 150;
/** A render while typing shows only images already loaded; a new source, likely half typed
 *  (`https://exa`), is asked for once typing has stopped this long. */
const MARKDOWN_PREVIEW_IMAGE_DELAY_MS = 1000;

/**
 * Whether a Markdown file opens with its Markdown preview beside it: the last answer the user gave,
 * for every tab and the next start. A layout key, like the Markdown preview's width
 * (`markdown-preview`, a key of its own): where the preview shows describes the window, not a
 * repository.
 */
const markdownPreviewByDefault = layoutFlag("markdown-preview.shown");
/** Whether a diff opens side by side, and with its unchanged regions collapsed: as the Markdown preview's,
 *  the last answer, for every tab and the next start. */
const diffDefaults = {
  sideBySide: layoutFlag("diff.side-by-side"),
  unchangedCollapsed: layoutFlag("diff.unchanged-collapsed")
};

/** How a diff is laid out (`setDiffOption`). */
export type DiffOption = keyof typeof diffDefaults;

/** Replaced whole on every change — `useSyncExternalStore` compares identity. */
export interface EditorSnapshot {
  path: string;
  /** Null while the read is in flight. */
  file: FileContent | null;
  loading: boolean;
  /** Monaco, a grammar or the editor loading. */
  building: boolean;
  saving: boolean;
  dirty: boolean;
  /** The tab the next file replaces — until kept, which the first edit does (VS Code). */
  preview: boolean;
  /** The file against HEAD in the diff editor; off shows it in the plain one (`showDiff`). What
   *  is on screen is `diffShown`. */
  diff: boolean;
  /** The rendered file beside the editor, for a Markdown file (VS Code's "Open Preview to the
   *  Side"). As the user last left it, the next Markdown file included (`markdownPreviewByDefault`). */
  markdownPreview: boolean;
  /** The diff in two columns instead of one (`setDiffOption`), as the user last left it. */
  sideBySide: boolean;
  /** The diff's unchanged regions collapsed (`setDiffOption`), as the user last left it. */
  unchangedCollapsed: boolean;
}

type DiffState = Pick<EditorSnapshot, "diff" | "file" | "dirty">;

/** The file differs from HEAD: it has a HEAD side (`FileContent.head`), or unsaved edits. */
export function hasChanges({ file, dirty }: Pick<EditorSnapshot, "file" | "dirty">): boolean {
  return Boolean(file?.head) || dirty;
}

/** The diff on screen: switched on, and the file has changes. Without any the plain editor shows,
 *  the switch kept, so the diff comes back once there are. */
export function diffShown(snapshot: DiffState): boolean {
  return snapshot.diff && hasChanges(snapshot);
}

/** Whether a Markdown preview beside the editor is withheld: a diff shows the changes, not the
 *  result. The preview's own setting stays, so it shows again once the diff is off. */
export function previewWithheld(snapshot: DiffState): boolean {
  return diffShown(snapshot);
}

/** A placeholder, the image view, or the editor. */
type EditorKind = "loading" | "error" | "image" | "binary" | "tooLarge" | "text";

/** A Markdown file's preview (`markdown.ts`), made the first time it is shown. */
interface MarkdownPreviewView {
  /** Moved between containers like the editor's host, never rendered by React. */
  scroller: HTMLDivElement;
  /** In the scroller's shadow root; what a render replaces. */
  body: HTMLDivElement;
  /** The images the file shows, by repository path or URL, until the file or its version changes.
   *  A source that loaded nothing is not kept: it may be there next time. */
  images: Map<string, Promise<string | undefined>>;
  /** Its last render's code blocks, handed to the next (`ColoredBlocks`). */
  colored: ColoredBlocks;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every render: one overtaken is dropped. */
  renderSeq: number;
  /** Which side last set a scroll position, and when (`echoing`). */
  scrolledBy: { side: "editor" | "preview"; at: number } | undefined;
}

interface EditorView {
  ref: ProjectRef;
  tabId: string;
  /** The diff editor's element and the plain editor's, stacked in the tab's frame and moved
   *  between containers together; never rendered by React. */
  host: HTMLDivElement;
  plainHost: HTMLDivElement;
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  plainEditor: MonacoEditor.IStandaloneCodeEditor | null;
  /** Shared by every file opened while that editor builds. */
  buildingDiff: Promise<MonacoEditor.IStandaloneDiffEditor | null> | null;
  buildingPlain: Promise<MonacoEditor.IStandaloneCodeEditor | null> | null;
  models: { original: MonacoEditor.ITextModel; modified: MonacoEditor.ITextModel } | null;
  /** The modified model's version at the last load or save; anything else is dirty. */
  savedVersionId: number;
  /** An outside change is being folded in: its content event is no edit. */
  reloading: boolean;
  markdownView: MarkdownPreviewView | null;
  /** Bumped by every open (and a re-read that builds the models): a read overtaken is dropped. */
  readSeq: number;
  /** Bumped by every save that reached disk: an older re-read must not restore the replaced text
   *  and mtime as clean. */
  saves: number;
  /** A newer read of the file than the tab holds, kept while its edits keep it out: what a save
   *  asks before overwriting, and what the tab shows once undone to clean (`foldIn`). */
  onDisk: FileContent | undefined;
  /** HEAD and status as App last reported them, once acted on. */
  version: string | undefined;
  /** A report that came while the open's read was in flight, applied when it lands. */
  pendingVersion: string | undefined;
  /** A match to select, kept until there is a model to select it in (`applyReveal`). */
  pendingReveal: EditorReveal | undefined;
  snapshot: EditorSnapshot;
}

/** By tab id. */
const views = new Map<string, EditorView>();
/** By tab: a host subscribes before its file was read. */
const tabListeners = new Map<string, Set<() => void>>();
/** By project: a pane's progress bar is about every editor tab it holds. */
const refListeners = new Map<string, Set<() => void>>();

/** A tab with no editor yet — one instance, so it compares equal. */
const CLOSED: EditorSnapshot = {
  path: "",
  file: null,
  loading: false,
  building: false,
  saving: false,
  dirty: false,
  preview: false,
  diff: true,
  markdownPreview: false,
  sideBySide: false,
  unchangedCollapsed: false
};

// Shiki's colors are fixed at render.
subscribeHighlightTheme(() => views.forEach((view) => renderMarkdownPreview(view, 0)));

export function editorKind(file: FileContent | null): EditorKind {
  if (!file) {
    return "loading";
  }
  if (file.error) {
    return "error";
  }
  if (file.image || file.head?.image) {
    return "image";
  }
  if (file.binary || file.head?.binary) {
    return "binary";
  }
  return file.tooLarge ? "tooLarge" : "text";
}

/** Nothing to save: a file that is gone, or one there is no editor for. */
export function isReadOnly(file: FileContent | null): boolean {
  return Boolean(file?.deleted || file?.binary || file?.extracted || file?.tooLarge || file?.error);
}

function subscribe(map: Map<string, Set<() => void>>, key: string, listener: () => void): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

export function subscribeEditor(tabId: string, listener: () => void): () => void {
  return subscribe(tabListeners, tabId, listener);
}

/** Fires for any of the repository's or worktree's editor tabs. */
export function subscribeRefEditors(ref: ProjectRef, listener: () => void): () => void {
  return subscribe(refListeners, refKeyOf(ref), listener);
}

/** The code editor on screen: the diff editor's modified side, or the plain one. Null until the
 *  side in the snapshot has been built. */
function activeEditor(view: EditorView): MonacoEditor.IStandaloneCodeEditor | null {
  return (diffShown(view.snapshot) ? view.diffEditor?.getModifiedEditor() : view.plainEditor) ?? null;
}

/** Shows the editor the tab's snapshot asks for and hides the other, both keeping their box. */
function applyMode(view: EditorView): void {
  const shown = diffShown(view.snapshot);
  view.host.classList.toggle("hidden", !shown);
  view.plainHost.classList.toggle("hidden", shown);
}

/** Both editors carry the tab's models, so the one off screen is ready for the switch. */
function setModels(view: EditorView, models: EditorView["models"]): void {
  view.diffEditor?.setModel(models);
  view.plainEditor?.setModel(models?.modified ?? null);
}

/** Selects the match a search result opened the file at, once its model is in an editor. Centred
 *  only where it is off screen, as monaco goes to a find match. */
function applyReveal(view: EditorView): void {
  const reveal = view.pendingReveal;
  const editor = activeEditor(view);
  if (!reveal || !editor) {
    return;
  }
  view.pendingReveal = undefined;
  editor.setSelection({
    startLineNumber: reveal.line,
    startColumn: reveal.column,
    endLineNumber: reveal.line,
    endColumn: reveal.column + reveal.length
  });
  editor.revealLineInCenterIfOutsideViewport(reveal.line);
}

/** A match in a tab already open (`App.openEditor`), which needs no new read. */
export function revealEditorMatch(tabId: string, reveal: EditorReveal): void {
  const view = views.get(tabId);
  if (!view) {
    return;
  }
  view.pendingReveal = reveal;
  applyReveal(view);
}

function setReadOnly(view: EditorView, readOnly: boolean): void {
  view.diffEditor?.updateOptions({ readOnly });
  view.plainEditor?.updateOptions({ readOnly });
}

/** Switches the tab's diff on or off (`diffShown` says whether it is on screen). */
export function showDiff(tabId: string, shown: boolean): void {
  const view = views.get(tabId);
  if (view && view.snapshot.diff !== shown) {
    publish(view, { diff: shown });
  }
}

/**
 * Moves the tab between the diff editor and the plain one once `diffShown` flipped, carrying the
 * cursor and the scroll over from `leaving`. The models stay as they are, HEAD's included, so
 * switching back shows the diff against a HEAD kept current meanwhile (`setEditorVersion`).
 */
function switchEditor(view: EditorView, leaving: MonacoEditor.IStandaloneCodeEditor | null): void {
  const shown = diffShown(view.snapshot);
  const state = leaving?.saveViewState() ?? null;
  const focused = leaving?.hasTextFocus() ?? false;
  // Shown once the other editor is there, or the switch would uncover an empty frame while it builds.
  void ensureEditor(view).then((built) => {
    if (views.get(view.tabId) !== view || !built || diffShown(view.snapshot) !== shown) {
      return;
    }
    applyMode(view);
    const editor = activeEditor(view);
    if (state) {
      editor?.restoreViewState(state);
    }
    if (focused) {
      editor?.focus();
    }
  });
}

/**
 * Shows or hides the Markdown preview beside the tab's editor; a file of another kind has none.
 * The answer is the default every Markdown file opened afterwards takes. A tab withholding its
 * preview (`previewWithheld`) takes no answer.
 */
export function showMarkdownPreview(tabId: string, shown: boolean): void {
  const view = views.get(tabId);
  if (!view || !isMarkdown(view.snapshot.path) || previewWithheld(view.snapshot)) {
    return;
  }
  markdownPreviewByDefault.set(shown);
  if (view.snapshot.markdownPreview !== shown) {
    publish(view, { markdownPreview: shown });
  }
}

/** The diff editor laid out as the tab's snapshot says. */
function applyDiffOptions(view: EditorView): void {
  const { sideBySide, unchangedCollapsed } = view.snapshot;
  view.diffEditor?.updateOptions({ renderSideBySide: sideBySide, hideUnchangedRegions: { enabled: unchangedCollapsed } });
}

/** Lays the tab's diff out side by side or inline, its unchanged regions collapsed or expanded; the
 *  answer is the default every diff opened afterwards takes. */
export function setDiffOption(tabId: string, option: DiffOption, on: boolean): void {
  const view = views.get(tabId);
  if (!view) {
    return;
  }
  diffDefaults[option].set(on);
  publish(view, { [option]: on });
  applyDiffOptions(view);
}

export function getEditorSnapshot(tabId: string): EditorSnapshot {
  return views.get(tabId)?.snapshot ?? CLOSED;
}

/** Whether opening `path` with its Markdown preview would land in a tab withholding it: one opened with
 *  its diff if `diff`, else the tab already showing it with its own. */
export function previewWithheldAt(ref: ProjectRef, path: string, diff: boolean): boolean {
  const open = refViews(ref).find((view) => view.snapshot.path === path);
  return diff || (open ? previewWithheld(open.snapshot) : false);
}

function refViews(ref: ProjectRef): EditorView[] {
  const refKey = refKeyOf(ref);
  return [...views.values()].filter((view) => refKeyOf(view.ref) === refKey);
}

/** The repository's or worktree's preview tab, if it has one. */
export function previewEditorTab(ref: ProjectRef): string | undefined {
  return refViews(ref).find((view) => view.snapshot.preview)?.tabId;
}

function emit(view: EditorView): void {
  tabListeners.get(view.tabId)?.forEach((listener) => listener());
  refListeners.get(refKeyOf(view.ref))?.forEach((listener) => listener());
}

/** Dropped for a view disposed meanwhile. A tab without models yet takes its editor from
 *  `showText`. */
function publish(view: EditorView, patch: Partial<EditorSnapshot>): void {
  if (views.get(view.tabId) !== view) {
    return;
  }
  const leaving = activeEditor(view);
  const shown = diffShown(view.snapshot);
  view.snapshot = { ...view.snapshot, ...patch };
  emit(view);
  report(view);
  if (view.models && diffShown(view.snapshot) !== shown) {
    switchEditor(view, leaving);
  }
}

/** The snapshot for `tet-ctl editor-state` and `editor-list` — see EditorReport. */
function report(view: EditorView): void {
  const { path, file, loading, dirty, preview } = view.snapshot;
  window.tet.repository.reportEditor(view.ref, view.tabId, {
    path,
    loading,
    dirty,
    readOnly: isReadOnly(file),
    error: file?.error,
    preview
  });
}

/** "Keep Open": the tab is no longer the one the next file replaces. */
export function keepEditor(tabId: string): void {
  const view = views.get(tabId);
  if (view?.snapshot.preview) {
    publish(view, { preview: false });
  }
}

/** The tab's edited side, for `tet-ctl editor-state`. Undefined unless a text file is open. */
export function editorContent(tabId: string): string | undefined {
  const view = views.get(tabId);
  if (!view || editorKind(view.snapshot.file) !== "text") {
    return undefined;
  }
  return view.models?.modified.getValue() ?? view.snapshot.file?.content;
}

/**
 * Reads `path` afresh into the tab, making its editor on the first call, on the side and with the
 * preview `how` asks for, selecting its match once the text is there (`openEditor`,
 * use-editor-opening.ts). `preview` is whether the tab is the project's preview tab, which is
 * `openEditor`'s to decide. The caller has made sure nothing unsaved is lost, and calls this
 * before the tab is drawn, whose host attaches the element made here.
 */
export function openEditorFile(ref: ProjectRef, tabId: string, path: string, preview: boolean, how: OpenEditor): void {
  let view = views.get(tabId);
  if (!view) {
    const host = document.createElement("div");
    host.className = "editor-host";
    const plainHost = document.createElement("div");
    plainHost.className = "editor-host";
    view = {
      ref,
      tabId,
      host,
      plainHost,
      diffEditor: null,
      plainEditor: null,
      buildingDiff: null,
      buildingPlain: null,
      models: null,
      savedVersionId: 0,
      reloading: false,
      markdownView: null,
      readSeq: 0,
      saves: 0,
      onDisk: undefined,
      version: undefined,
      pendingVersion: undefined,
      pendingReveal: undefined,
      snapshot: CLOSED
    };
    views.set(tabId, view);
  }
  // "Open Markdown Preview" is the same answer as the toggle, whether or not the file was already open.
  if (how.markdownPreview === true && isMarkdown(path)) {
    markdownPreviewByDefault.set(true);
  }
  const seq = ++view.readSeq;
  // Now, or the editor shows the previous file under the new path until the read lands.
  clearModels(view);
  clearMarkdownPreview(view);
  view.version = undefined;
  view.pendingVersion = undefined;
  view.onDisk = undefined;
  view.pendingReveal = how.reveal;
  publish(view, {
    path,
    file: null,
    loading: true,
    building: false,
    saving: false,
    dirty: false,
    preview,
    diff: how.diff === true,
    markdownPreview: markdownPreviewByDefault.get() && isMarkdown(path),
    sideBySide: diffDefaults.sideBySide.get(),
    unchangedCollapsed: diffDefaults.unchangedCollapsed.get()
  });
  applyMode(view);
  // The diff editor is the tab's for every file it opens.
  applyDiffOptions(view);
  const current = view;
  void window.tet.repository.readFile(ref, path).then((file) => {
    if (views.get(tabId) !== current || current.readSeq !== seq) {
      return;
    }
    if (file.error) {
      notify("error", `${file.path}: ${file.error}`);
    }
    const text = editorKind(file) === "text";
    publish(current, { file, loading: false, building: text });
    if (text) {
      void showText(current, seq, file);
    }
    const pending = current.pendingVersion;
    current.pendingVersion = undefined;
    if (pending !== undefined) {
      setEditorVersion(tabId, pending);
    }
  });
}

/**
 * Folds outside changes into the open file on a HEAD or status change. The edited side only while
 * clean, in place so undo and cursor survive — a dirty tab keeps the read as `onDisk`; HEAD's side
 * always, since a commit or checkout moves what the marks are against. The first report after an
 * open is the baseline. A file that failed to read is read again, so a tab opened before its file
 * existed recovers.
 */
export function setEditorVersion(tabId: string, version: string): void {
  const view = views.get(tabId);
  if (!view) {
    return;
  }
  const { path, file, loading } = view.snapshot;
  if (view.version === undefined) {
    view.version = version;
    return;
  }
  if (!file || loading) {
    // Not recorded as seen: the read in flight may predate the change.
    view.pendingVersion = version;
    return;
  }
  if (view.version === version) {
    return;
  }
  view.version = version;
  // A pull or checkout may have changed the images too, and the text may not have.
  view.markdownView?.images.clear();
  renderMarkdownPreview(view, 0);
  const seq = view.readSeq;
  const saves = view.saves;
  void window.tet.repository.readFile(view.ref, path).then((result) => {
    if (views.get(tabId) !== view || view.readSeq !== seq || result.error) {
      return;
    }
    const held = view.snapshot.file;
    if (!held) {
      return;
    }
    // No HEAD side means its own original — after a commit, so the marks go.
    const original = result.head?.content ?? result.content;
    if (view.models && view.models.original.getValue() !== original) {
      // Same text again would make the worker recompute an identical diff, on every refresh.
      view.models.original.setValue(original);
    }
    if (view.snapshot.dirty || view.saves !== saves || (result.mtimeMs === held.mtimeMs && !held.error)) {
      // The edited side stays; HEAD's is carried in anyway, or binary, image and original are
      // decided off a stale HEAD.
      if (view.snapshot.dirty && view.saves === saves && result.mtimeMs !== held.mtimeMs) {
        view.onDisk = result;
      }
      publish(view, { file: { ...held, head: result.head } });
      return;
    }
    foldIn(view, result);
  });
}

/** A read of the file taken into a clean tab: in place so undo and cursor survive, or as a new
 *  generation where the kind changed or the models are still building. */
function foldIn(view: EditorView, result: FileContent): void {
  view.onDisk = undefined;
  const text = editorKind(result) === "text";
  publish(view, { file: result, building: text && !view.models });
  if (!text) {
    clearModels(view);
  } else if (view.models) {
    const model = view.models.modified;
    // monaco strips a BOM only when building a buffer: pushed as an edit it becomes text, and the
    // save writes it twice. A BOM that came or went on disk needs a new buffer.
    const bom = result.content.startsWith("\uFEFF");
    const modelBom = model.getValueLength(undefined, true) !== model.getValueLength();
    // Monaco reports the change synchronously, before the new version is saved: read as an edit,
    // it would keep a preview tab.
    view.reloading = true;
    try {
      if (bom === modelBom) {
        const text = bom ? result.content.slice(1) : result.content;
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      } else {
        model.setValue(result.content);
      }
    } finally {
      view.reloading = false;
    }
    view.savedVersionId = model.getAlternativeVersionId();
    // As in `showText`: deleted under the tab means read-only, restored means editable.
    setReadOnly(view, isReadOnly(result));
    publish(view, { dirty: false });
  } else {
    // A new generation: the open may still be building models, and both would create the same two.
    void showText(view, ++view.readSeq, result);
  }
}

/** Writes the edited side, guarded by the mtime it was read at (`Repository.writeFile`). */
export async function saveEditorFile(tabId: string): Promise<void> {
  const view = views.get(tabId);
  const model = view?.models?.modified;
  if (!view || !model || !view.snapshot.file || !view.snapshot.dirty || view.snapshot.saving) {
    return;
  }
  const { path, file } = view.snapshot;
  const seq = view.readSeq;
  publish(view, { saving: true });
  // BOM kept (`Repository.writeFile`). The version is taken with the text, so a keystroke during
  // the write stays unsaved.
  const content = model.getValue(undefined, true);
  const versionId = model.getAlternativeVersionId();
  let result = await window.tet.repository.writeFile(view.ref, path, content, file.mtimeMs);
  if (views.get(tabId) !== view || view.readSeq !== seq) {
    return;
  }
  // Changed on disk meanwhile (an agent wrote it): overwritten only once asked — the other version
  // is gone then. With another question up, told instead. Not saving while asked: the bar shows
  // TET working, never TET waiting on the user (AGENTS.md).
  if (!result.ok && result.diskMtimeMs !== undefined) {
    publish(view, { saving: false });
    const overwrite = await confirmedFollowUp(
      {
        title: "File changed on disk",
        message: `${path} changed on disk since it was opened. Overwrite it with your changes?`,
        confirmLabel: "Overwrite"
      },
      result.error ?? "Could not save the file"
    );
    if (views.get(tabId) !== view || view.readSeq !== seq) {
      return;
    }
    if (!overwrite) {
      return;
    }
    publish(view, { saving: true });
    result = await window.tet.repository.writeFile(view.ref, path, content, result.diskMtimeMs);
    if (views.get(tabId) !== view || view.readSeq !== seq) {
      return;
    }
  }
  if (!result.ok) {
    notify("error", result.error ?? "Could not save the file");
    publish(view, { saving: false });
    return;
  }
  view.savedVersionId = versionId;
  view.saves++;
  view.onDisk = undefined;
  const held = view.snapshot.file;
  // An unchanged file saved with edits differs from HEAD before the next report says so: its own
  // original is HEAD's, so the diff stays on screen meanwhile.
  const original = view.models?.original.getValue();
  const head =
    held?.head ?? (original !== undefined && original !== model.getValue() ? { content: original, binary: false, missing: false } : undefined);
  publish(view, {
    file: held ? { ...held, content, mtimeMs: result.mtimeMs ?? held.mtimeMs, head } : held,
    dirty: model.getAlternativeVersionId() !== versionId,
    saving: false
  });
}

/**
 * Asks before losing edits that haven't reached disk; true when there are none. One question for
 * all of them: `Dialog.tsx` answers a second question as cancelled while one is up.
 */
export async function canDiscardEdits(tabIds: string[]): Promise<boolean> {
  const paths = tabIds.map(getEditorSnapshot).filter((snapshot) => snapshot.dirty).map((snapshot) => snapshot.path);
  if (paths.length === 0) {
    return true;
  }
  return confirmed({
    title: "Unsaved changes",
    message: `Discard unsaved changes to ${paths.join(", ")}?`,
    confirmLabel: "Discard changes"
  });
}

/** `canDiscardEdits` over every editor tab of the repositories and worktrees. */
export function canDiscardRefEdits(...refs: ProjectRef[]): Promise<boolean> {
  return canDiscardEdits(refs.flatMap((ref) => refViews(ref).map((view) => view.tabId)));
}

/** Moves the Markdown preview's scroller into the tab's frame beside the editor, and renders it. */
export function attachMarkdownPreview(tabId: string, container: HTMLElement): void {
  const view = views.get(tabId);
  if (!view) {
    return;
  }
  view.markdownView ??= makeMarkdownPreview(view);
  if (view.markdownView.scroller.parentElement !== container) {
    container.appendChild(view.markdownView.scroller);
  }
  renderMarkdownPreview(view, 0);
}

/** Moves both elements into the tab's frame, new after a pane move; monaco remeasures
 *  (`automaticLayout`). */
export function attachEditor(tabId: string, container: HTMLElement): void {
  const view = views.get(tabId);
  if (view && view.host.parentElement !== container) {
    container.append(view.host, view.plainHost);
  }
}

export function focusEditor(tabId: string): void {
  const view = views.get(tabId);
  if (view) {
    activeEditor(view)?.focus();
  }
}

/** The editor tab closed. */
export function disposeEditor(tabId: string): void {
  const view = views.get(tabId);
  if (!view) {
    return;
  }
  views.delete(tabId);
  clearModels(view);
  clearMarkdownPreview(view);
  view.diffEditor?.dispose();
  view.plainEditor?.dispose();
  view.host.remove();
  view.plainHost.remove();
  view.markdownView?.scroller.remove();
  emit(view);
  // Safe here, not in an unsubscribe: ids are never reused, so nobody subscribes to this one again.
  tabListeners.delete(tabId);
  window.tet.repository.reportEditor(view.ref, tabId, null);
}

/** The repository or worktree closed. */
export function disposeRefEditors(ref: ProjectRef): void {
  for (const view of refViews(ref)) {
    disposeEditor(view.tabId);
  }
}

/**
 * Editors first: disposing a model one still holds throws. A model left behind blocks its URI for
 * the next open of the same file.
 */
function clearModels(view: EditorView): void {
  if (!view.models) {
    return;
  }
  setModels(view, null);
  view.models.original.dispose();
  view.models.modified.dispose();
  view.models = null;
}

/** Hands a text file to the tab's editors, building the one on screen first if needed. */
async function showText(view: EditorView, seq: number, file: FileContent): Promise<void> {
  const built = await ensureEditor(view);
  const monaco = await loadMonaco();
  // A grammar diff-highlight.ts doesn't bundle is "plaintext".
  const language = languageForPath(file.path) ?? null;
  await ensureLanguage(monaco, language);
  if (!built || views.get(view.tabId) !== view || view.readSeq !== seq) {
    return;
  }
  // One model per URI or monaco throws; the repository or worktree is the authority, as two can
  // show one path. Within a repository or worktree a path is open in one tab at most
  // (use-editor-opening.ts's openEditor), and the previous models are cleared before the next open.
  const uri = (scheme: string): ReturnType<typeof monaco.Uri.from> =>
    monaco.Uri.from({ scheme, authority: refKeyOf(view.ref), path: `/${file.path}` });
  const models = {
    original: monaco.editor.createModel(file.head?.content ?? file.content, language ?? "plaintext", uri("tet-head")),
    modified: monaco.editor.createModel(file.content, language ?? "plaintext", uri("tet"))
  };
  view.savedVersionId = models.modified.getAlternativeVersionId();
  models.modified.onDidChangeContent(() => {
    renderMarkdownPreview(view, MARKDOWN_PREVIEW_RENDER_DELAY_MS);
    if (view.reloading) {
      return;
    }
    const dirty = models.modified.getAlternativeVersionId() !== view.savedVersionId;
    if (dirty !== view.snapshot.dirty) {
      // An edit keeps a preview, in the same step: nothing can replace the tab in between.
      publish(view, { dirty, preview: view.snapshot.preview && !dirty });
    }
    // Undone to clean over a file that changed on disk meanwhile: what a clean tab would have
    // shown. After this event, as monaco is still inside the edit.
    const onDisk = view.onDisk;
    if (!dirty && onDisk) {
      queueMicrotask(() => {
        if (view.models === models && !view.snapshot.dirty && view.onDisk === onDisk) {
          foldIn(view, onDisk);
        }
      });
    }
  });
  setReadOnly(view, isReadOnly(file));
  setModels(view, models);
  view.models = models;
  applyMode(view);
  applyReveal(view);
  renderMarkdownPreview(view, 0);
  publish(view, { building: false });
}

function makeMarkdownPreview(view: EditorView): MarkdownPreviewView {
  const { scroller, body } = createMarkdownPreview();
  // Every link is taken here. A path goes where a ctrl-clicked one in a terminal does, a Markdown
  // file with its Markdown preview; a URL to main, which opens only web and mail links. Main keeps the
  // window from following anything itself.
  scroller.addEventListener("click", (event) => {
    const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (!link) {
      return;
    }
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    const target = resolveLink(view.snapshot.path, href);
    if (target !== undefined) {
      openFile(view.ref, target, isMarkdown(target));
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      void window.tet.shell.openUrl(href);
    }
  });
  scroller.addEventListener("scroll", () => followMarkdownPreview(view));
  return { scroller, body, images: new Map(), colored: new Map(), timer: undefined, renderSeq: 0, scrolledBy: undefined };
}

/**
 * Renders the edited text into the Markdown preview after `delay`, if it is shown. A render while typing
 * (`delay` above 0) loads no new image; if it skipped one, a render that does follows once typing
 * has stopped a while.
 */
function renderMarkdownPreview(view: EditorView, delay: number): void {
  const preview = view.markdownView;
  if (!preview || !view.snapshot.markdownPreview || previewWithheld(view.snapshot)) {
    return;
  }
  const typing = delay > 0;
  clearTimeout(preview.timer);
  preview.timer = setTimeout(() => {
    const text = view.models?.modified.getValue();
    if (text === undefined) {
      return;
    }
    const seq = ++preview.renderSeq;
    let skipped = false;
    const loadImage = (source: string): Promise<string | undefined> => {
      let image = preview.images.get(source);
      if (!image && typing) {
        skipped = true;
        return Promise.resolve(undefined);
      }
      if (!image) {
        const loading = /^https:/i.test(source)
          ? window.tet.shell.fetchImage(source).then((url) => url ?? undefined)
          : window.tet.repository.readFile(view.ref, source).then((file) => file.image);
        void loading.then((url) => {
          if (url === undefined && preview.images.get(source) === loading) {
            preview.images.delete(source);
          }
        });
        image = loading;
        preview.images.set(source, image);
      }
      return image;
    };
    renderMarkdown(text, view.snapshot.path, loadImage, preview.colored).then(
      ({ doc, colored }) => {
        preview.colored = colored;
        if (views.get(view.tabId) === view && preview.renderSeq === seq) {
          preview.body.replaceChildren(...doc.body.childNodes);
          followEditor(view);
          if (skipped) {
            preview.timer = setTimeout(() => renderMarkdownPreview(view, 0), MARKDOWN_PREVIEW_IMAGE_DELAY_MS);
          }
        }
      },
      // The last render stays: a file that fails once fails on every keystroke, no notice for each.
      (error: unknown) => console.warn("[TET] Markdown preview failed to render:", error)
    );
  }, delay);
}

/** The file changed under the Markdown preview: nothing of the last one shows or loads. */
function clearMarkdownPreview(view: EditorView): void {
  if (view.markdownView) {
    clearTimeout(view.markdownView.timer);
    view.markdownView.renderSeq++;
    view.markdownView.body.replaceChildren();
    view.markdownView.images.clear();
  }
}

/** Still the answer to the scroll the other side was given: that one must not drive it back. */
function echoing(preview: MarkdownPreviewView, side: "editor" | "preview"): boolean {
  return preview.scrolledBy !== undefined && preview.scrolledBy.side !== side && performance.now() - preview.scrolledBy.at < SCROLL_ECHO_MS;
}

/** Scrolls the Markdown preview to the editor's first visible line, the share of it scrolled past included. */
function followEditor(view: EditorView): void {
  const editor = activeEditor(view);
  const line = editor?.getVisibleRanges()[0]?.startLineNumber;
  if (!view.markdownView || !view.snapshot.markdownPreview || !editor || line === undefined || echoing(view.markdownView, "editor")) {
    return;
  }
  const top = editor.getTopForLineNumber(line);
  const height = editor.getTopForLineNumber(line + 1) - top;
  const share = height > 0 ? Math.min(1, Math.max(0, (editor.getScrollTop() - top) / height)) : 0;
  view.markdownView.scrolledBy = { side: "editor", at: performance.now() };
  scrollToLine(view.markdownView.scroller, view.markdownView.body, line - 1 + share);
}

/** And back: the editor scrolls to the line at the top of the Markdown preview (VS Code's
 *  `scrollEditorWithPreview`). */
function followMarkdownPreview(view: EditorView): void {
  const preview = view.markdownView;
  const editor = activeEditor(view);
  if (!preview || !editor || echoing(preview, "preview")) {
    return;
  }
  const line = lineAtScroll(preview.scroller, preview.body);
  if (line === undefined) {
    return;
  }
  const whole = Math.floor(line);
  const top = editor.getTopForLineNumber(whole + 1);
  const height = editor.getTopForLineNumber(whole + 2) - top;
  preview.scrolledBy = { side: "preview", at: performance.now() };
  editor.setScrollTop(top + (height > 0 ? (line - whole) * height : 0));
}

/** What both of a tab's editors are made and configured with. */
interface EditorSetup {
  monaco: Monaco;
  options: Record<string, unknown>;
  keybindings: Record<string, string>;
}

/** Null for a tab closed while this was awaited. */
async function editorSetup(view: EditorView): Promise<EditorSetup | null> {
  const monaco = await loadMonaco();
  // Defines the theme before the editor exists, or it paints once in monaco's colors.
  await ensureLanguage(monaco, null);
  const { editorKeybindingPreset } = (await window.tet.settings.get()).files;
  if (views.get(view.tabId) !== view) {
    return null;
  }
  return { monaco, options: editorOptions(editorFontFamily()), keybindings: resolveKeybindings(editorKeybindingPreset) };
}

/**
 * The actions, keybindings and listeners a tab's editor carries. Given a diff editor's modified
 * side, which is where its `addAction` and `addCommand` put them anyway, so the plain editor is
 * configured by the same call.
 */
function configureEditor(view: EditorView, setup: EditorSetup, editor: MonacoEditor.IStandaloneCodeEditor): void {
  // Bound through the resolved keybindings below.
  editor.addAction({ id: "tet.save", label: "Save", run: () => void saveEditorFile(view.tabId) });
  // VS Code's "Markdown: Open Preview to the Side", as a toggle.
  editor.addAction({
    id: "tet.markdownPreview",
    label: "Show/Hide Markdown Preview",
    run: () => showMarkdownPreview(view.tabId, !view.snapshot.markdownPreview)
  });
  editor.onDidScrollChange((event) => {
    if (event.scrollTopChanged) {
      followEditor(view);
    }
  });
  // Monaco's find action declares no context menu group. Replace is left out of the widget
  // (styles.css hides its toggle), so it gets no entry of its own.
  editor.addAction({
    id: "tet.find",
    label: "Find",
    contextMenuGroupId: "1_find",
    contextMenuOrder: 1,
    run: (instance) => void instance.getAction("actions.find")?.run()
  });
  // Unknown combos are skipped at parse, unknown command ids silently at run. A command's keybinding
  // is page-wide and the last registered wins, so each is scoped to this editor the way `addAction`
  // scopes its own — the tab's other editor included, which has its own id.
  const scope = `editorId == '${editor.getId()}'`;
  // Replace is the one monaco action TET doesn't offer, and monaco binds it itself: its key does
  // nothing here. Before the preset below, which may claim the same combo for something of its own.
  const replaceCombo = parseKeyCombo(setup.monaco, PLATFORM.replaceKey);
  if (replaceCombo !== undefined) {
    editor.addCommand(replaceCombo, () => {}, scope);
  }
  for (const [combo, commandId] of Object.entries(setup.keybindings)) {
    const parsed = parseKeyCombo(setup.monaco, combo);
    // Elsewhere Ctrl+Shift+V pastes as plain text: VS Code binds its preview for Markdown alone.
    const when = commandId === "tet.markdownPreview" ? `${scope} && editorLangId == 'markdown'` : scope;
    if (parsed !== undefined) {
      editor.addCommand(parsed, () => editor.getAction(commandId)?.run(), when);
    }
  }
}

/**
 * What both editors need once monaco has made one, in the order they need it. The file is already
 * open whenever the tab is switched from one to the other, so each starts on the models it finds.
 */
function adoptEditor(view: EditorView, setup: EditorSetup, code: MonacoEditor.IStandaloneCodeEditor): void {
  configureEditor(view, setup, code);
  setReadOnly(view, isReadOnly(view.snapshot.file));
  setModels(view, view.models);
}

/** Built once per tab, kept for every file after (the preview tab's change). */
function ensureDiffEditor(view: EditorView): Promise<MonacoEditor.IStandaloneDiffEditor | null> {
  view.buildingDiff ??= (async () => {
    const setup = await editorSetup(view);
    if (!setup) {
      return null;
    }
    const editor = setup.monaco.editor.createDiffEditor(view.host, { ...setup.options, ...diffEditorOptions() });
    view.diffEditor = editor;
    applyDiffOptions(view);
    adoptEditor(view, setup, editor.getModifiedEditor());
    return editor;
  })();
  return view.buildingDiff;
}

/** Built the first time the tab's diff is switched off, on the same models as the diff editor. */
function ensurePlainEditor(view: EditorView): Promise<MonacoEditor.IStandaloneCodeEditor | null> {
  view.buildingPlain ??= (async () => {
    const setup = await editorSetup(view);
    if (!setup) {
      return null;
    }
    const editor = setup.monaco.editor.create(view.plainHost, setup.options);
    view.plainEditor = editor;
    adoptEditor(view, setup, editor);
    return editor;
  })();
  return view.buildingPlain;
}

/** Builds the editor the tab's side needs; false for a tab closed while it built. */
async function ensureEditor(view: EditorView): Promise<boolean> {
  return Boolean(diffShown(view.snapshot) ? await ensureDiffEditor(view) : await ensurePlainEditor(view));
}
