import type { editor as MonacoEditor } from "monaco-editor";
import type { FileContent } from "../../shared/types";
import { confirm } from "../ui/Dialog";
import { notify } from "../ui/Notices";
import { isMarkdown, languageForPath, subscribeHighlightTheme } from "./diff-highlight";
import { diffEditorOptions, editorOptions, ensureLanguage, loadMonaco } from "./editor";
import { parseKeyCombo, resolveKeybindings } from "./keybindings";
import { createPreview, renderMarkdown, resolveLink, scrollToLine } from "./markdown";
import { openFile } from "../terminal/terminal-views";

/**
 * Each editor tab's editor, outside React like the xterms (`terminal-views.ts`): monaco's
 * element, the diff editor and the file, one set per tab (`editor-tab.ts`), and a Markdown file's
 * preview beside it. The elements follow a tab moved between panes, so an edit survives the move,
 * where React would rebuild the editor.
 */

/** Typing re-renders the preview once it pauses: each render parses, sanitizes and colors the
 *  whole file. */
const PREVIEW_RENDER_DELAY_MS = 150;
/** A render while typing shows only images already loaded; a new source, likely half typed
 *  (`https://exa`), is asked for once typing has stopped this long. */
const PREVIEW_IMAGE_DELAY_MS = 1000;

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
  /** The rendered file beside the editor, for a Markdown file (VS Code's "Open Preview to the
   *  Side"). Off again for the next file. */
  markdownPreview: boolean;
}

/** A placeholder, the image view, or the editor. */
export type EditorKind = "loading" | "error" | "image" | "binary" | "tooLarge" | "text";

/** A Markdown file's preview (`markdown.ts`), made the first time it is shown. */
interface PreviewView {
  /** Moved between containers like the editor's host, never rendered by React. */
  scroller: HTMLDivElement;
  /** In the scroller's shadow root; what a render replaces. */
  body: HTMLDivElement;
  /** The images the file shows, by repository path or URL, until the file or its version changes.
   *  A source that loaded nothing is not kept: it may be there next time. */
  images: Map<string, Promise<string | undefined>>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every render: one overtaken is dropped. */
  renderSeq: number;
}

interface EditorView {
  projectId: string;
  tabId: string;
  /** Moved between containers, never rendered by React. */
  host: HTMLDivElement;
  editor: MonacoEditor.IStandaloneDiffEditor | null;
  /** Shared by every file opened while the editor builds. */
  building: Promise<MonacoEditor.IStandaloneDiffEditor | null> | null;
  models: { original: MonacoEditor.ITextModel; modified: MonacoEditor.ITextModel } | null;
  /** The modified model's version at the last load or save; anything else is dirty. */
  savedVersionId: number;
  /** An outside change is being folded in: its content event is no edit. */
  reloading: boolean;
  preview: PreviewView | null;
  /** Bumped by every open (and a re-read that builds the models): a read overtaken is dropped. */
  readSeq: number;
  /** Bumped by every save that reached disk: an older re-read must not restore the replaced text
   *  and mtime as clean. */
  saves: number;
  /** HEAD and status as App last reported them, once acted on. */
  version: string | undefined;
  /** A report that came while the open's read was in flight, applied when it lands. */
  pendingVersion: string | undefined;
  snapshot: EditorSnapshot;
}

/** By tab id. */
const views = new Map<string, EditorView>();
/** By tab: a host subscribes before its file was read. */
const tabListeners = new Map<string, Set<() => void>>();
/** By project: a pane's progress bar is about every editor tab it holds. */
const projectListeners = new Map<string, Set<() => void>>();

/** A tab with no editor yet — one instance, so it compares equal. */
const CLOSED: EditorSnapshot = {
  path: "",
  file: null,
  loading: false,
  building: false,
  saving: false,
  dirty: false,
  preview: false,
  markdownPreview: false
};

// Shiki's colors are fixed at render.
subscribeHighlightTheme(() => views.forEach((view) => renderPreview(view, 0)));

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

/** Fires for any of the project's editor tabs. */
export function subscribeProjectEditors(projectId: string, listener: () => void): () => void {
  return subscribe(projectListeners, projectId, listener);
}

/** Shows or hides the Markdown preview beside the tab's editor; a file of another kind has none. */
export function showMarkdownPreview(tabId: string, shown: boolean): void {
  const view = views.get(tabId);
  if (view && isMarkdown(view.snapshot.path) && view.snapshot.markdownPreview !== shown) {
    publish(view, { markdownPreview: shown });
  }
}

export function getEditorSnapshot(tabId: string): EditorSnapshot {
  return views.get(tabId)?.snapshot ?? CLOSED;
}

function projectViews(projectId: string): EditorView[] {
  return [...views.values()].filter((view) => view.projectId === projectId);
}

/** The project's preview tab, if it has one. */
export function previewEditorTab(projectId: string): string | undefined {
  return projectViews(projectId).find((view) => view.snapshot.preview)?.tabId;
}

function emit(view: EditorView): void {
  tabListeners.get(view.tabId)?.forEach((listener) => listener());
  projectListeners.get(view.projectId)?.forEach((listener) => listener());
}

/** Dropped for a view disposed meanwhile. */
function publish(view: EditorView, patch: Partial<EditorSnapshot>): void {
  if (views.get(view.tabId) !== view) {
    return;
  }
  view.snapshot = { ...view.snapshot, ...patch };
  emit(view);
  report(view);
}

/** The snapshot for `tet-ctl editor-state` and `editor-list` — see EditorReport. */
function report(view: EditorView): void {
  const { path, file, loading, dirty, preview } = view.snapshot;
  window.tet.repository.reportEditor(view.projectId, view.tabId, {
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
 * Reads `path` afresh into the tab, making its editor on the first call; a Markdown file with its
 * preview if `markdownPreview`. The caller has made sure nothing unsaved is lost, and calls this
 * before the tab is drawn, whose host attaches the element made here.
 */
export function openEditorFile(
  projectId: string,
  tabId: string,
  path: string,
  preview: boolean,
  markdownPreview: boolean
): void {
  let view = views.get(tabId);
  if (!view) {
    const host = document.createElement("div");
    host.className = "editor-host";
    view = {
      projectId,
      tabId,
      host,
      editor: null,
      building: null,
      models: null,
      savedVersionId: 0,
      reloading: false,
      preview: null,
      readSeq: 0,
      saves: 0,
      version: undefined,
      pendingVersion: undefined,
      snapshot: CLOSED
    };
    views.set(tabId, view);
  }
  const seq = ++view.readSeq;
  // Now, or the editor shows the previous file under the new path until the read lands.
  clearModels(view);
  clearPreview(view);
  view.version = undefined;
  view.pendingVersion = undefined;
  publish(view, {
    path,
    file: null,
    loading: true,
    building: false,
    saving: false,
    dirty: false,
    preview,
    markdownPreview: markdownPreview && isMarkdown(path)
  });
  const current = view;
  void window.tet.repository.readFile(projectId, path).then((file) => {
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
 * clean, in place so undo and cursor survive; HEAD's side always, since a commit or checkout moves
 * what the marks are against. The first report after an open is the baseline. A file that failed to
 * read is read again, so a tab opened before its file existed recovers.
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
  view.preview?.images.clear();
  renderPreview(view, 0);
  const seq = view.readSeq;
  const saves = view.saves;
  void window.tet.repository.readFile(view.projectId, path).then((result) => {
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
      publish(view, { file: { ...held, head: result.head } });
      return;
    }
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
      view.editor?.updateOptions({ readOnly: isReadOnly(result) });
      publish(view, { dirty: false });
    } else {
      // A new generation: the open may still be building models, and both would create the same two.
      void showText(view, ++view.readSeq, result);
    }
  });
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
  const result = await window.tet.repository.writeFile(view.projectId, path, content, file.mtimeMs);
  if (views.get(tabId) !== view || view.readSeq !== seq) {
    return;
  }
  if (!result.ok) {
    notify("error", result.error ?? "Could not save the file");
    publish(view, { saving: false });
    return;
  }
  view.savedVersionId = versionId;
  view.saves++;
  const held = view.snapshot.file;
  publish(view, {
    file: held ? { ...held, content, mtimeMs: result.mtimeMs ?? held.mtimeMs } : held,
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
  const answer = await confirm({
    title: "Unsaved changes",
    message: `Discard unsaved changes to ${paths.join(", ")}?`,
    confirmLabel: "Discard changes"
  });
  return answer.confirmed;
}

/** `canDiscardEdits` over every editor tab of the project. */
export function canDiscardProjectEdits(projectId: string): Promise<boolean> {
  return canDiscardEdits(projectViews(projectId).map((view) => view.tabId));
}

/** Moves the preview's scroller into the tab's frame beside the editor, and renders it. */
export function attachMarkdownPreview(tabId: string, container: HTMLElement): void {
  const view = views.get(tabId);
  if (!view) {
    return;
  }
  view.preview ??= makePreview(view);
  if (view.preview.scroller.parentElement !== container) {
    container.appendChild(view.preview.scroller);
  }
  renderPreview(view, 0);
}

/** Moves the element into the tab's host, new after a pane move; monaco remeasures (`automaticLayout`). */
export function attachEditor(tabId: string, container: HTMLElement): void {
  const view = views.get(tabId);
  if (view && view.host.parentElement !== container) {
    container.appendChild(view.host);
  }
}

export function focusEditor(tabId: string): void {
  views.get(tabId)?.editor?.getModifiedEditor().focus();
}

/** The editor tab closed. */
export function disposeEditor(tabId: string): void {
  const view = views.get(tabId);
  if (!view) {
    return;
  }
  views.delete(tabId);
  clearModels(view);
  clearPreview(view);
  view.editor?.dispose();
  view.host.remove();
  view.preview?.scroller.remove();
  emit(view);
  // Safe here, not in an unsubscribe: ids are never reused, so nobody subscribes to this one again.
  tabListeners.delete(tabId);
  window.tet.repository.reportEditor(view.projectId, tabId, null);
}

/** The project closed. */
export function disposeProjectEditors(projectId: string): void {
  for (const view of projectViews(projectId)) {
    disposeEditor(view.tabId);
  }
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
async function showText(view: EditorView, seq: number, file: FileContent): Promise<void> {
  const editor = await ensureEditor(view);
  const monaco = await loadMonaco();
  // A grammar diff-highlight.ts doesn't bundle is "plaintext".
  const language = languageForPath(file.path) ?? null;
  await ensureLanguage(monaco, language);
  if (!editor || views.get(view.tabId) !== view || view.readSeq !== seq) {
    return;
  }
  // One model per URI or monaco throws; the project is the authority, as two can show one path.
  // Within a project a path is open in one tab at most (App.openDiff), and the previous models
  // are cleared before the next open.
  const uri = (scheme: string): ReturnType<typeof monaco.Uri.from> =>
    monaco.Uri.from({ scheme, authority: view.projectId, path: `/${file.path}` });
  const models = {
    original: monaco.editor.createModel(file.head?.content ?? file.content, language ?? "plaintext", uri("tet-head")),
    modified: monaco.editor.createModel(file.content, language ?? "plaintext", uri("tet"))
  };
  view.savedVersionId = models.modified.getAlternativeVersionId();
  models.modified.onDidChangeContent(() => {
    renderPreview(view, PREVIEW_RENDER_DELAY_MS);
    if (view.reloading) {
      return;
    }
    const dirty = models.modified.getAlternativeVersionId() !== view.savedVersionId;
    if (dirty !== view.snapshot.dirty) {
      // An edit keeps a preview, in the same step: nothing can replace the tab in between.
      publish(view, { dirty, preview: view.snapshot.preview && !dirty });
    }
  });
  editor.updateOptions({ readOnly: isReadOnly(file) });
  editor.setModel(models);
  view.models = models;
  renderPreview(view, 0);
  publish(view, { building: false });
}

function makePreview(view: EditorView): PreviewView {
  const { scroller, body } = createPreview();
  // Every link is taken here. A path goes where a ctrl-clicked one in a terminal does, a Markdown
  // file with its preview; a URL to main, which opens only web and mail links. Main keeps the
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
      openFile(view.projectId, target, isMarkdown(target));
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      void window.tet.shell.openUrl(href);
    }
  });
  return { scroller, body, images: new Map(), timer: undefined, renderSeq: 0 };
}

/**
 * Renders the edited text into the preview after `delay`, if it is shown. A render while typing
 * (`delay` above 0) loads no new image; if it skipped one, a render that does follows once typing
 * has stopped a while.
 */
function renderPreview(view: EditorView, delay: number): void {
  const preview = view.preview;
  if (!preview || !view.snapshot.markdownPreview) {
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
          : window.tet.repository.readFile(view.projectId, source).then((file) => file.image);
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
    renderMarkdown(text, view.snapshot.path, loadImage).then(
      (doc) => {
        if (views.get(view.tabId) === view && preview.renderSeq === seq) {
          preview.body.replaceChildren(...doc.body.childNodes);
          followEditor(view);
          if (skipped) {
            preview.timer = setTimeout(() => renderPreview(view, 0), PREVIEW_IMAGE_DELAY_MS);
          }
        }
      },
      // The last render stays: a file that fails once fails on every keystroke, no notice for each.
      (error: unknown) => console.warn("[tet] Markdown preview failed to render:", error)
    );
  }, delay);
}

/** The file changed under the preview: nothing of the last one shows or loads. */
function clearPreview(view: EditorView): void {
  if (view.preview) {
    clearTimeout(view.preview.timer);
    view.preview.renderSeq++;
    view.preview.body.replaceChildren();
    view.preview.images.clear();
  }
}

/** Scrolls the preview to the editor's first visible line, the share of it scrolled past included. */
function followEditor(view: EditorView): void {
  const editor = view.editor?.getModifiedEditor();
  const line = editor?.getVisibleRanges()[0]?.startLineNumber;
  if (!view.preview || !view.snapshot.markdownPreview || !editor || line === undefined) {
    return;
  }
  const top = editor.getTopForLineNumber(line);
  const height = editor.getTopForLineNumber(line + 1) - top;
  const share = height > 0 ? Math.min(1, Math.max(0, (editor.getScrollTop() - top) / height)) : 0;
  scrollToLine(view.preview.scroller, view.preview.body, line - 1 + share);
}

/** Built once per tab, kept for every file after (the preview tab's change). */
function ensureEditor(view: EditorView): Promise<MonacoEditor.IStandaloneDiffEditor | null> {
  view.building ??= (async () => {
    const monaco = await loadMonaco();
    // Defines the theme before the editor exists, or it paints once in monaco's colors.
    await ensureLanguage(monaco, null);
    const { editorKeybindingPreset } = await window.tet.settings.get();
    if (views.get(view.tabId) !== view) {
      return null;
    }
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim();
    const editor = monaco.editor.createDiffEditor(view.host, { ...editorOptions(fontFamily), ...diffEditorOptions() });
    view.editor = editor;
    // Bound through the resolved keybindings below.
    editor.addAction({ id: "tet.save", label: "Save", run: () => void saveEditorFile(view.tabId) });
    // VS Code's "Markdown: Open Preview to the Side", as a toggle.
    editor.addAction({
      id: "tet.markdownPreview",
      label: "Toggle Preview",
      run: () => showMarkdownPreview(view.tabId, !view.snapshot.markdownPreview)
    });
    editor.getModifiedEditor().onDidScrollChange((event) => {
      if (event.scrollTopChanged) {
        followEditor(view);
      }
    });
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
    // `addCommand` and `addAction` reach the modified side, where these belong. A command's keybinding
    // is page-wide and the last registered wins, so each is scoped to this editor the way `addAction`
    // scopes its own.
    const scope = `editorId == '${editor.getModifiedEditor().getId()}'`;
    for (const [combo, commandId] of Object.entries(resolveKeybindings(editorKeybindingPreset))) {
      const parsed = parseKeyCombo(monaco, combo);
      // Elsewhere Ctrl+Shift+V pastes as plain text: VS Code binds its preview for Markdown alone.
      const when = commandId === "tet.markdownPreview" ? `${scope} && editorLangId == 'markdown'` : scope;
      if (parsed !== undefined) {
        editor.addCommand(parsed, () => editor.getModifiedEditor().getAction(commandId)?.run(), when);
      }
    }
    return editor;
  })();
  return view.building;
}
