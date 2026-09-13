import type { editor as MonacoEditor } from "monaco-editor";
import type { FileContent } from "../../shared/types";
import { confirm } from "../ui/Dialog";
import { notify } from "../ui/Notices";
import { languageForPath } from "./diff-highlight";
import { diffEditorOptions, editorOptions, ensureLanguage, loadMonaco } from "./editor";
import { parseKeyCombo, resolveKeybindings } from "./keybindings";

/**
 * Each project's editor tab, outside React as the xterms are (`terminal-views.ts`): the element
 * monaco lives in, the diff editor, and the file it shows. A tab moved into another pane gets a
 * new container and this element follows it, so an edit survives the move — React would have
 * rebuilt the editor. One per project, since a project has one editor tab.
 */

/** What the tab draws, replaced whole on every change — `useSyncExternalStore` compares identity. */
export interface EditorSnapshot {
  path: string;
  /** The read of `path`; null while it is in flight. */
  file: FileContent | null;
  loading: boolean;
  /** Monaco loading, a grammar being fetched, the editor being built. */
  building: boolean;
  saving: boolean;
  dirty: boolean;
}

/** How a read file is shown: a placeholder, the image view, or the editor. */
export type EditorKind = "loading" | "error" | "image" | "binary" | "tooLarge" | "text";

interface EditorView {
  /** Created here and moved between containers, never rendered by React. */
  host: HTMLDivElement;
  editor: MonacoEditor.IStandaloneDiffEditor | null;
  /** The editor being built, shared by every file opened while it is. */
  building: Promise<MonacoEditor.IStandaloneDiffEditor | null> | null;
  models: { original: MonacoEditor.ITextModel; modified: MonacoEditor.ITextModel } | null;
  /** The modified model's version at the last load or save; anything else is dirty. */
  savedVersionId: number;
  /** Bumped by every open, so a read that lands after the next one began is dropped. */
  readSeq: number;
  /** What App last reported the file depends on — HEAD and its status. */
  version: string | undefined;
  snapshot: EditorSnapshot;
}

const views = new Map<string, EditorView>();
/** By project rather than on the view: a pane subscribes before any file was opened. */
const listeners = new Map<string, Set<() => void>>();

/** The snapshot of a project with no editor tab — one instance, so it compares equal. */
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

/** A change to what the tab draws; dropped for a view that has been disposed meanwhile. */
function publish(projectId: string, view: EditorView, patch: Partial<EditorSnapshot>): void {
  if (views.get(projectId) !== view) {
    return;
  }
  view.snapshot = { ...view.snapshot, ...patch };
  emit(projectId);
}

/**
 * Shows `path` in the project's editor tab, reading it afresh. The caller has asked about an
 * unsaved edit already (`canDiscardEdit`), and calls this before the tab is drawn: the tab's
 * host attaches the element made here.
 */
export function openEditorFile(projectId: string, path: string): void {
  let view = views.get(projectId);
  if (!view) {
    const host = document.createElement("div");
    host.className = "editor-host";
    view = { host, editor: null, building: null, models: null, savedVersionId: 0, readSeq: 0, version: undefined, snapshot: CLOSED };
    views.set(projectId, view);
  }
  const seq = ++view.readSeq;
  // The previous file's models go at once: kept until the read lands, the editor would show them
  // under the new path.
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
 * Folds what changed outside into the open file, on a HEAD or status change (`version`). The
 * edited side only while it is clean, in place so undo history and the cursor survive; HEAD's side
 * always, because a commit or a checkout under an open edit moves what the marks are against.
 * The first report after an open is the baseline, not a change.
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
  void window.tet.repository.readFile(projectId, path).then((result) => {
    if (views.get(projectId) !== view || view.readSeq !== seq || result.error) {
      return;
    }
    const held = view.snapshot.file;
    if (!held) {
      return;
    }
    // Without a HEAD side the file is its own original — and that is the case a commit under the
    // open file lands in, where git stops reporting a change and the marks have to go.
    const original = result.head?.content ?? result.content;
    if (view.models && view.models.original.getValue() !== original) {
      // Asked on every refresh, so the no-op is here: setting the same text again would throw
      // the computed diff away and have the worker rebuild the identical one.
      view.models.original.setValue(original);
    }
    if (view.snapshot.dirty || result.mtimeMs === held.mtimeMs) {
      // The edited side stays as it is; what HEAD has of it is carried in regardless, or the tab
      // keeps deciding binary, image and original off the side already replaced.
      publish(projectId, view, { file: { ...held, head: result.head } });
      return;
    }
    const text = editorKind(result) === "text";
    publish(projectId, view, { file: result, building: text && !view.models });
    if (!text) {
      clearModels(view);
    } else if (view.models) {
      const model = view.models.modified;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: result.content }], () => null);
      view.savedVersionId = model.getAlternativeVersionId();
      publish(projectId, view, { dirty: false });
    } else {
      void showText(projectId, view, seq, result);
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
  // BOM preserved — see `Repository.writeFile`. The version is taken with the text, so a keystroke
  // landing while the write runs still counts as unsaved.
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

/**
 * Moves the element into `container` — the tab's host, which is a new one after a move between
 * panes. Nothing is rebuilt: monaco measures itself again (`automaticLayout`).
 */
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
}

/**
 * The editor first, then both models: disposing a model the editor still holds throws, and a
 * model left behind holds its URI against the next open of the same file.
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

/** Hands a text file to the editor, building the editor first if this project has none yet. */
async function showText(projectId: string, view: EditorView, seq: number, file: FileContent): Promise<void> {
  const editor = await ensureEditor(projectId, view);
  const monaco = await loadMonaco();
  // Only a grammar diff-highlight.ts bundles gets colors; anything else is "plaintext".
  const language = languageForPath(file.path) ?? null;
  await ensureLanguage(monaco, language);
  if (!editor || views.get(projectId) !== view || view.readSeq !== seq) {
    return;
  }
  // Two models mean two URIs: the model service holds one instance per URI and throws on a
  // second. The project is the authority, since two projects can show the same path at once.
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

/** The project's diff editor, built once and kept for every file after. */
function ensureEditor(projectId: string, view: EditorView): Promise<MonacoEditor.IStandaloneDiffEditor | null> {
  view.building ??= (async () => {
    const monaco = await loadMonaco();
    // The first call defines the theme, which must exist before the editor does, or it paints
    // once in monaco's own colors (see ensureLanguage).
    await ensureLanguage(monaco, null);
    const { editorKeybindingPreset } = await window.tet.settings.get();
    if (views.get(projectId) !== view) {
      return null;
    }
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim();
    const editor = monaco.editor.createDiffEditor(view.host, { ...editorOptions(fontFamily), ...diffEditorOptions() });
    view.editor = editor;
    // No keybinding here; it comes from the resolved keybindings below.
    editor.addAction({ id: "tet.save", label: "Save", run: () => void saveEditorFile(projectId) });
    // Monaco's find/find-replace actions declare no context menu group; added as one here.
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
    // An unknown combo is skipped at parse time, an unknown command id silently at run time.
    // `addCommand` and `addAction` on a diff editor both reach its modified side, which is where
    // every one of these commands belongs.
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
