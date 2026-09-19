import type { FileContent } from "../../shared/types";
import { notify } from "../ui/Notices";
import { languageForPath } from "./diff-highlight";

/**
 * Each Markdown preview tab's file (`editor-tab.ts`), outside React like the editors
 * (`editor-views.ts`): read on open, read again when App reports a change. A file open in an editor
 * tab is previewed from there instead, unsaved edits included (`MarkdownHost`).
 */

/** Replaced whole on every change — `useSyncExternalStore` compares identity. */
export interface MarkdownSnapshot {
  path: string;
  /** Null while the read is in flight. */
  file: FileContent | null;
}

interface MarkdownView {
  projectId: string;
  tabId: string;
  /** Bumped by every read: a read overtaken is dropped. */
  readSeq: number;
  /** HEAD and status as App last reported them. */
  version: string | undefined;
  /** The repository's images the file shows, by path, until the file changes. */
  images: Map<string, Promise<string | undefined>>;
  snapshot: MarkdownSnapshot;
}

/** By tab id. */
const views = new Map<string, MarkdownView>();
const listeners = new Map<string, Set<() => void>>();
/** By project: App's `openDiff` and `openPreview`, for the preview's links and the editor tab. */
const openHandlers = new Map<string, (path: string, preview: boolean) => void>();

const CLOSED: MarkdownSnapshot = { path: "", file: null };

export function isMarkdown(path: string): boolean {
  return languageForPath(path) === "markdown";
}

export function setOpenHandler(projectId: string, handler: (path: string, preview: boolean) => void): () => void {
  openHandlers.set(projectId, handler);
  return () => openHandlers.delete(projectId);
}

/** In an editor tab, or as a Markdown preview. */
export function openFile(projectId: string, path: string, preview: boolean): void {
  openHandlers.get(projectId)?.(path, preview);
}

export function subscribeMarkdown(tabId: string, listener: () => void): () => void {
  let set = listeners.get(tabId);
  if (!set) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

export function getMarkdownSnapshot(tabId: string): MarkdownSnapshot {
  return views.get(tabId)?.snapshot ?? CLOSED;
}

/** Dropped for a view disposed meanwhile. */
function publish(view: MarkdownView, patch: Partial<MarkdownSnapshot>): void {
  if (views.get(view.tabId) !== view) {
    return;
  }
  view.snapshot = { ...view.snapshot, ...patch };
  listeners.get(view.tabId)?.forEach((listener) => listener());
}

/** Reads `path` into a new preview tab, before the tab is drawn. */
export function openMarkdownFile(projectId: string, tabId: string, path: string): void {
  const view: MarkdownView = {
    projectId,
    tabId,
    readSeq: 0,
    version: undefined,
    images: new Map(),
    snapshot: { path, file: null }
  };
  views.set(tabId, view);
  read(view, true);
}

function read(view: MarkdownView, opening: boolean): void {
  const seq = ++view.readSeq;
  view.images.clear();
  void window.tet.repository.readFile(view.projectId, view.snapshot.path).then((file) => {
    if (views.get(view.tabId) !== view || view.readSeq !== seq) {
      return;
    }
    if (opening && file.error) {
      notify("error", `${file.path}: ${file.error}`);
    }
    publish(view, { file });
  });
}

/** Reads the file again on a HEAD, status or disk change; the first report after the open is the
 *  baseline. */
export function setMarkdownVersion(tabId: string, version: string): void {
  const view = views.get(tabId);
  if (!view || view.version === version) {
    return;
  }
  const baseline = view.version === undefined;
  view.version = version;
  if (!baseline) {
    read(view, false);
  }
}

/** A repository image the file shows, as a data URL; undefined when it is none. */
export function loadMarkdownImage(tabId: string, path: string): Promise<string | undefined> {
  const view = views.get(tabId);
  if (!view) {
    return Promise.resolve(undefined);
  }
  let image = view.images.get(path);
  if (!image) {
    image = window.tet.repository.readFile(view.projectId, path).then((file) => file.image);
    view.images.set(path, image);
  }
  return image;
}

/** After a theme switch: the code blocks' colors are shiki's, fixed at render. */
export function rethemeMarkdown(): void {
  for (const view of views.values()) {
    publish(view, {});
  }
}

/** The preview tab closed. */
export function disposeMarkdown(tabId: string): void {
  if (views.delete(tabId)) {
    // Safe here, as in `disposeEditor`: ids are never reused.
    listeners.delete(tabId);
  }
}

/** The project closed. */
export function disposeProjectMarkdown(projectId: string): void {
  for (const view of [...views.values()]) {
    if (view.projectId === projectId) {
      disposeMarkdown(view.tabId);
    }
  }
}
