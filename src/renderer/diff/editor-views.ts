import type { editor as MonacoEditor } from "monaco-editor";
import type { FileContent } from "../../shared/types";
import { confirm } from "../ui/Dialog";
import { notify } from "../ui/Notices";
import { languageForPath } from "./diff-highlight";
import { diffEditorOptions, editorOptions, ensureLanguage, loadMonaco } from "./editor";
import { parseKeyCombo, resolveKeybindings } from "./keybindings";

/**
 * Each project's one editor tab, outside React like the xterms (`terminal-views.ts`): monaco's
 * element, the diff editor and the file. The element follows a tab moved between panes, so an edit
 * survives the move, where React would rebuild the editor.
 */

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
}

/** A placeholder, the image view, or the editor. */
export type EditorKind = "loading" | "error" | "image" | "binary" | "tooLarge" | "text";

interface EditorView {
  /** Moved between containers, never rendered by React. */
  host: HTMLDivElement;
  editor: MonacoEditor.IStandaloneDiffEditor | null;
  /** Shared by every file opened while the editor builds. */
  building: Promise<MonacoEditor.IStandaloneDiffEditor | null> | null;
  models: { original: MonacoEditor.ITextModel; modified: MonacoEditor.ITextModel } | null;
  /** The modified model's version at the last load or save; anything else is dirty. */
  savedVersionId: number;
  /** Bumped by every open (and a re-read that builds the models): a read overtaken is dropped. */
  readSeq: number;
  /** Bumped by every save that reached disk: an older re-read must not restore the replaced text
   *  and mtime as clean. */
  saves: number;
  /** HEAD and status as App last reported them. */
  version: string | undefined;
  snapshot: EditorSnapshot;
}

const views = new Map<string, EditorView>();
/** By project: a pane subscribes before any file was opened. */
const listeners = new Map<string, Set<() => void>>();

/** A project with no editor tab — one instance, so it compares equal. */
const CLOSED: EditorSnapshot = { path: "", file: null, loading: false, building: false, saving: false, dirty: false };

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
  return Boolean(file?.deleted || file?.binary || file?.tooLarge || file?.error);
}

export function subscribeEditor(projectId: string, listener: () => void): () => void {
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

export function getEditorSnapshot(projectId: string): EditorSnapshot {
  return views.get(projectId)?.snapshot ?? CLOSED;
}

function emit(projectId: string): void {
  listeners.get(projectId)?.forEach((listener) => listener());
}

/** Dropped for a view disposed meanwhile. */
function publish(projectId: string, view: EditorView, patch: Partial<EditorSnapshot>): void {
  if (views.get(projectId) !== view) {
    return;
  }
  view.snapshot = { ...view.snapshot, ...patch };
  emit(projectId);
  report(projectId, view);
}

/** The snapshot for `tet-ctl editor-state` — see EditorReport. */
function report(projectId: string, view: EditorView): void {
  const { path, file, loading, dirty } = view.snapshot;
  window.tet.repository.reportEditor(projectId, { path, loading, dirty, readOnly: isReadOnly(file), error: file?.error });
}

/** The edited side's current text, for `tet-ctl editor-state`. Undefined unless a text file is open. */
export function editorContent(projectId: string): string | undefined {
  const view = views.get(projectId);
  if (!view || editorKind(view.snapshot.file) !== "text") {
    return undefined;
  }
  return view.models?.modified.getValue() ?? view.snapshot.file?.content;
}

/**
 * Reads `path` afresh into the editor tab. The caller has already asked `canDiscardEdit`, and calls
 * this before the tab is drawn, whose host attaches the element made here.
 */
export function openEditorFile(projectId: string, path: string): void {
  let view = views.get(projectId);
  if (!view) {
    const host = document.createElement("div");
    host.className = "editor-host";
    view = { host, editor: null, building: null, models: null, savedVersionId: 0, readSeq: 0, saves: 0, version: undefined, snapshot: CLOSED };
    views.set(projectId, view);
  }
  const seq = ++view.readSeq;
  // Now, or the editor shows the previous file under the new path until the read lands.
  clearModels(view);
  view.version = undefined;
  publish(projectId, view, { path, file: null, loading: true, building: false, saving: false, dirty: false });
  const current = view;
  void window.tet.repository.readFile(projectId, path).then((file) => {
    if (views.get(projectId) !== current || current.readSeq !== seq) {
      return;
    }
    if (file.error) {
      notify("error", `${file.path}: ${file.error}`);
    }
    const text = editorKind(file) === "text";
    publish(projectId, current, { file, loading: false, building: text });
    if (text) {
      void showText(projectId, current, seq, file);
    }
  });
}

/**
 * Folds outside changes into the open file on a HEAD or status change. The edited side only while
 * clean, in place so undo and cursor survive; HEAD's side always, since a commit or checkout moves
 * what the marks are against. The first report after an open is the baseline.
 */
export function setEditorVersion(projectId: string, version: string): void {
  const view = views.get(projectId);
  if (!view) {
    return;
  }
  const previous = view.version;
  view.version = version;
  const { path, file, loading } = view.snapshot;
  if (previous === undefined || previous === version || !file || file.error || loading) {
    return;
  }
  const seq = view.readSeq;
  const saves = view.saves;
  void window.tet.repository.readFile(projectId, path).then((result) => {
    if (views.get(projectId) !== view || view.readSeq !== seq || result.error) {
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
    if (view.snapshot.dirty || view.saves !== saves || result.mtimeMs === held.mtimeMs) {
      // The edited side stays; HEAD's is carried in anyway, or binary, image and original are
      // decided off a stale HEAD.
      publish(projectId, view, { file: { ...held, head: result.head } });
      return;
    }
    const text = editorKind(result) === "text";
    publish(projectId, view, { file: result, building: text && !view.models });
    if (!text) {
      clearModels(view);
    } else if (view.models) {
      const model = view.models.modified;
      // monaco strips a BOM only when building a buffer: pushed as an edit it becomes text, and the
      // save writes it twice. A BOM that came or went on disk needs a new buffer.
      const bom = result.content.startsWith("\uFEFF");
      const modelBom = model.getValueLength(undefined, true) !== model.getValueLength();
      if (bom === modelBom) {
        const text = bom ? result.content.slice(1) : result.content;
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      } else {
        model.setValue(result.content);
      }
      view.savedVersionId = model.getAlternativeVersionId();
      // As in `showText`: deleted under the tab means read-only, restored means editable.
      view.editor?.updateOptions({ readOnly: isReadOnly(result) });
      publish(projectId, view, { dirty: false });
    } else {
      // A new generation: the open may still be building models, and both would create the same two.
      void showText(projectId, view, ++view.readSeq, result);
    }
  });
}

/** Writes the edited side, guarded by the mtime it was read at (`Repository.writeFile`). */
export async function saveEditorFile(projectId: string): Promise<void> {
  const view = views.get(projectId);
  const model = view?.models?.modified;
  if (!view || !model || !view.snapshot.file || !view.snapshot.dirty || view.snapshot.saving) {
    return;
  }
  const { path, file } = view.snapshot;
  const seq = view.readSeq;
  publish(projectId, view, { saving: true });
  // BOM kept (`Repository.writeFile`). The version is taken with the text, so a keystroke during
  // the write stays unsaved.
  const content = model.getValue(undefined, true);
  const versionId = model.getAlternativeVersionId();
  const result = await window.tet.repository.writeFile(projectId, path, content, file.mtimeMs);
  if (views.get(projectId) !== view || view.readSeq !== seq) {
    return;
  }
  if (!result.ok) {
    notify("error", result.error ?? "Could not save the file");
    publish(projectId, view, { saving: false });
    return;
  }
  view.savedVersionId = versionId;
  view.saves++;
  const held = view.snapshot.file;
  publish(projectId, view, {
    file: held ? { ...held, content, mtimeMs: result.mtimeMs ?? held.mtimeMs } : held,
    dirty: model.getAlternativeVersionId() !== versionId,
    saving: false
  });
}

/** Asks before losing an edit that hasn't reached disk; true when there is none. */
export async function canDiscardEdit(projectId: string): Promise<boolean> {
  const { dirty, path } = getEditorSnapshot(projectId);
  if (!dirty) {
    return true;
  }
  const answer = await confirm({
    title: "Unsaved changes",
    message: `Discard unsaved changes to ${path}?`,
    confirmLabel: "Discard changes"
  });
  return answer.confirmed;
}

/** Moves the element into the tab's host, new after a pane move; monaco remeasures (`automaticLayout`). */
export function attachEditor(projectId: string, container: HTMLElement): void {
  const view = views.get(projectId);
  if (view && view.host.parentElement !== container) {
    container.appendChild(view.host);
  }
}

export function focusEditor(projectId: string): void {
  views.get(projectId)?.editor?.getModifiedEditor().focus();
}

/** The editor tab closed, or its project did. */
export function disposeEditor(projectId: string): void {
  const view = views.get(projectId);
  if (!view) {
    return;
  }
  views.delete(projectId);
  clearModels(view);
  view.editor?.dispose();
  view.host.remove();
  emit(projectId);
  window.tet.repository.reportEditor(projectId, null);
}

/**
 * Editor first: disposing a model it still holds throws. A model left behind blocks its URI for the
 * next open of the same file.
 */
function clearModels(view: EditorView): void {
  if (!view.models) {
    return;
  }
  view.editor?.setModel(null);
  view.models.original.dispose();
  view.models.modified.dispose();
  view.models = null;
}

/** Hands a text file to the editor, building it first if needed. */
async function showText(projectId: string, view: EditorView, seq: number, file: FileContent): Promise<void> {
  const editor = await ensureEditor(projectId, view);
  const monaco = await loadMonaco();
  // A grammar diff-highlight.ts doesn't bundle is "plaintext".
  const language = languageForPath(file.path) ?? null;
  await ensureLanguage(monaco, language);
  if (!editor || views.get(projectId) !== view || view.readSeq !== seq) {
    return;
  }
  // One model per URI or monaco throws; the project is the authority, as two can show one path.
  const uri = (scheme: string): ReturnType<typeof monaco.Uri.from> =>
    monaco.Uri.from({ scheme, authority: projectId, path: `/${file.path}` });
  const models = {
    original: monaco.editor.createModel(file.head?.content ?? file.content, language ?? "plaintext", uri("tet-head")),
    modified: monaco.editor.createModel(file.content, language ?? "plaintext", uri("tet"))
  };
  view.savedVersionId = models.modified.getAlternativeVersionId();
  models.modified.onDidChangeContent(() => {
    const dirty = models.modified.getAlternativeVersionId() !== view.savedVersionId;
    if (dirty !== view.snapshot.dirty) {
      publish(projectId, view, { dirty });
    }
  });
  editor.updateOptions({ readOnly: isReadOnly(file) });
  editor.setModel(models);
  view.models = models;
  publish(projectId, view, { building: false });
}

/** Built once per project, kept for every file after. */
function ensureEditor(projectId: string, view: EditorView): Promise<MonacoEditor.IStandaloneDiffEditor | null> {
  view.building ??= (async () => {
    const monaco = await loadMonaco();
    // Defines the theme before the editor exists, or it paints once in monaco's colors.
    await ensureLanguage(monaco, null);
    const { editorKeybindingPreset } = await window.tet.settings.get();
    if (views.get(projectId) !== view) {
      return null;
    }
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim();
    const editor = monaco.editor.createDiffEditor(view.host, { ...editorOptions(fontFamily), ...diffEditorOptions() });
    view.editor = editor;
    // Bound through the resolved keybindings below.
    editor.addAction({ id: "tet.save", label: "Save", run: () => void saveEditorFile(projectId) });
    // Monaco's find actions declare no context menu group.
    editor.addAction({
      id: "tet.find",
      label: "Find",
      contextMenuGroupId: "1_find",
      contextMenuOrder: 1,
      run: (instance) => void instance.getAction("actions.find")?.run()
    });
    editor.addAction({
      id: "tet.findReplace",
      label: "Find and Replace",
      contextMenuGroupId: "1_find",
      contextMenuOrder: 2,
      run: (instance) => void instance.getAction("editor.action.startFindReplaceAction")?.run()
    });
    // Unknown combos are skipped at parse, unknown command ids silently at run. On a diff editor,
    // `addCommand` and `addAction` reach the modified side, where these belong.
    for (const [combo, commandId] of Object.entries(resolveKeybindings(editorKeybindingPreset))) {
      const parsed = parseKeyCombo(monaco, combo);
      if (parsed !== undefined) {
        editor.addCommand(parsed, () => editor.getModifiedEditor().getAction(commandId)?.run());
      }
    }
    return editor;
  })();
  return view.building;
}
