import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { AgentInfo } from "../../shared/types";
import { createFileLinkProvider } from "./links/file-links";
import type { WrappedUrlResolver } from "./links/link-provider";
import { createUrlLinkProvider } from "./links/url-links";
import { isLinux, isMac, isModifierHeld } from "../platform";
import { reportSlow } from "../slow-report";
import { buildXtermTheme } from "./theme";
import { isSoftwareRenderer, WebglPool } from "./webgl-pool";

interface TerminalView {
  term: Terminal;
  fit: FitAddon;
  /** What its theme is built for — see `buildXtermTheme`. */
  agent: AgentInfo;
  /** The size last reported to the pty, so a fit that changed nothing does not report again. */
  sent?: { cols: number; rows: number };
  /** Its WebGL renderer, while it holds a context; without one xterm draws through the DOM. */
  webgl?: WebglAddon;
}

/**
 * xterm instances live outside React: output is written straight to them instead of going
 * through component state. Tab ids are only unique within their project, so views are keyed by
 * both.
 */
const views = new Map<string, TerminalView>();

/**
 * Per project, what to do when a ctrl-clicked file turns out to lie inside the repository: the
 * project's editor tab opens on it. Registered by the pane.
 */
const revealHandlers = new Map<string, (path: string) => void>();

function viewKey(projectId: string, tabId: string): string {
  return `${projectId} ${tabId}`;
}

/**
 * What the output path has done since the last `takeOutputStats`: how many writes, into how many
 * distinct terminals, and how many of those were hidden tabs — a hidden tab's xterm parses and
 * draws every batch the same as a visible one, whichever renderer it has. Read by the long-task
 * report in main.tsx. Counting only: this runs for every batch, and nothing in it may cost more
 * than the write it counts.
 */
let outputWrites = 0;
/** The longest single write, in characters: xterm parses one write in a piece, so a single huge
 *  one can hold the thread where many small ones would not. */
let largestWrite = 0;
const writingTabs = new Set<string>();
const writingHiddenTabs = new Set<string>();

export function takeOutputStats(): { writes: number; tabs: number; hidden: number; largest: number } {
  const stats = { writes: outputWrites, tabs: writingTabs.size, hidden: writingHiddenTabs.size, largest: largestWrite };
  outputWrites = 0;
  largestWrite = 0;
  writingTabs.clear();
  writingHiddenTabs.clear();
  return stats;
}

/**
 * Output that arrives before a tab's view exists — a saved command's process starts at the same
 * moment as its tab, and can write (a fast `echo` ahead of the command itself) before React has
 * mounted the container that makes attachTerminal build the xterm. Held here and replayed once,
 * in createView. Capped per tab so one that is never attached (removed before ever being shown)
 * cannot grow this without bound.
 */
const earlyOutput = new Map<string, string>();
const MAX_EARLY_OUTPUT = 64 * 1024;

// One batch per flush, in the order the main process collected it.
window.tet.terminals.onOutput((batch) => {
  for (const { projectId, tabId, data } of batch) {
    const key = viewKey(projectId, tabId);
    const view = views.get(key);
    if (!view) {
      earlyOutput.set(key, ((earlyOutput.get(key) ?? "") + data).slice(-MAX_EARLY_OUTPUT));
      continue;
    }
    outputWrites += 1;
    largestWrite = Math.max(largestWrite, data.length);
    writingTabs.add(key);
    if (view.term.element?.parentElement?.classList.contains("hidden")) {
      writingHiddenTabs.add(key);
    }
    view.term.write(data);
  }
});

export function setRevealHandler(projectId: string, handler: (path: string) => void): () => void {
  revealHandlers.set(projectId, handler);
  return () => revealHandlers.delete(projectId);
}

/** What VS Code's own `terminal.integrated.fontSize` defaults to, per platform. */
function defaultFontSize(): number {
  return isMac() ? 12 : 14;
}

function openUrl(url: string): void {
  void window.tet.shell.openUrl(url);
}

function openFile(projectId: string, filePath: string): void {
  void window.tet.shell.openFile(projectId, filePath).then((repoPath) => {
    if (repoPath) {
      revealHandlers.get(projectId)?.(repoPath);
    }
  });
}

/**
 * How long a "the agent knows no such url" answer is trusted. Not forever: the url may not have
 * been persisted yet when it was first asked about. Kept short because a retry is cheap — it
 * only fires while the pointer sits on that link, and the in-flight set folds the per-render
 * calls into one request.
 */
const NEGATIVE_TTL_MS = 2000;

/**
 * Answers to resolveUrl, keyed by the tab and fragment asked about; null means the host has no
 * url for it and it must not be asked again. Only grows by one entry per distinct url the user
 * holds the modifier over, so it needs no eviction.
 */
const resolvedUrls = new Map<string, string | null>();
const negativeAnswers = new Map<string, number>();
const pendingUrlRequests = new Set<string>();

/**
 * Forgets every url answer belonging to a terminal that is gone — one tab's, or a whole
 * project's. Keys start with the view they were asked for, so the prefix is all it takes.
 */
function forgetUrls(prefix: string): void {
  const caches: { keys(): Iterable<string>; delete(key: string): unknown }[] = [
    resolvedUrls,
    negativeAnswers,
    pendingUrlRequests
  ];
  for (const cache of caches) {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }
}

function createWrappedUrlResolver(projectId: string, tabId: string): WrappedUrlResolver {
  const cacheKey = (fragment: string): string => `${viewKey(projectId, tabId)} ${fragment}`;
  return {
    lookup: (fragment) => {
      const key = cacheKey(fragment);
      const answeredNoAt = negativeAnswers.get(key);
      if (answeredNoAt !== undefined && Date.now() - answeredNoAt > NEGATIVE_TTL_MS) {
        negativeAnswers.delete(key);
        resolvedUrls.delete(key);
      }
      return resolvedUrls.get(key);
    },
    request: (fragment) => {
      // provideLinks runs per render, so this is called until the answer lands; the in-flight
      // set keeps that down to a single request.
      const key = cacheKey(fragment);
      if (pendingUrlRequests.has(key)) {
        return;
      }
      pendingUrlRequests.add(key);
      void window.tet.terminals.resolveUrl(projectId, tabId, fragment).then((url) => {
        // Gone while in flight means the terminal was closed (see forgetUrls); the answer must
        // not put an entry back.
        if (!pendingUrlRequests.delete(key)) {
          return;
        }
        resolvedUrls.set(key, url);
        if (url === null) {
          negativeAnswers.set(key, Date.now());
        }
      });
    }
  };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * A path as one word: one holding a space would otherwise reach the shell or the agent as two.
 * Double quotes, which bash, zsh, PowerShell and cmd.exe all read the same way; a path without
 * whitespace is left bare, as it always was.
 */
function quotePath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

/**
 * Types the dropped files' paths. A file dragged in from the filesystem has a real path; one
 * dragged out of a browser carries only its content and is saved to a temp file first.
 */
async function pasteDroppedFiles(term: Terminal, files: File[]): Promise<void> {
  const paths: string[] = [];
  for (const file of files) {
    const existing = window.tet.files.pathOf(file);
    if (existing) {
      paths.push(existing);
      continue;
    }
    paths.push(await window.tet.files.writeTemp(file.name, toBase64(await file.arrayBuffer())));
  }
  if (paths.length > 0) {
    // Through term.paste, like clipboard text: whatever input mode the CLI is in cannot misread
    // it as individual keystrokes (vim-mode commands, say).
    term.paste(`${paths.map(quotePath).join(" ")} `);
  }
}

/** A copied screenshot has no path either — same temp-file trick, from the clipboard. */
async function pasteClipboardImage(term: Terminal): Promise<boolean> {
  const file = await window.tet.files.clipboardImage();
  if (file === null) {
    return false;
  }
  // The temp directory sits under the user's profile, whose name can hold a space.
  term.paste(`${quotePath(file)} `);
  return true;
}

async function pasteClipboard(term: Terminal): Promise<void> {
  if (!(await pasteClipboardImage(term))) {
    term.paste(await navigator.clipboard.readText());
  }
}

/**
 * Terminals draw through WebGL where it is there and fast; the DOM renderer is the fallback, never
 * a failure. Which terminals may hold a context is webgl-pool.ts's; the size of the budget is
 * main.ts's `max-active-webgl-contexts`.
 */
const webglPool = new WebglPool();

/** The terminals in front of the user, as `showTerminal` and `hideTerminal` report them. */
const inFront = new Set<string>();

/** Decided once, on the first terminal; a failed attach anywhere turns it off for the session. */
let webglAllowed: boolean | undefined;

/**
 * Orca's policy, not measured here. On Linux WebGL stays off under Wayland, where creating a
 * context was reported to wedge terminal input (stablyai/orca#5319), and wherever the renderer is
 * missing, unnamed or software rasterizing — slower than the DOM, and with glyph corruption that
 * never reports a lost context.
 */
function decideWebgl(): boolean {
  if (!isLinux()) {
    return true;
  }
  if (window.tet.waylandSession) {
    return false;
  }
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    if (!gl || !info) {
      return false;
    }
    const identity = `${gl.getParameter(info.UNMASKED_VENDOR_WEBGL)} ${gl.getParameter(info.UNMASKED_RENDERER_WEBGL)}`;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return identity.trim() !== "" && !isSoftwareRenderer(identity);
  } catch {
    return false;
  }
}

/** The addon's private renderer, reached into only to hand its context back early. */
interface WebglAddonInternals {
  _renderer?: { _gl?: WebGL2RenderingContext; _canvas?: HTMLCanvasElement };
}

function releaseWebgl(view: TerminalView): void {
  const addon = view.webgl;
  if (!addon) {
    return;
  }
  view.webgl = undefined;
  try {
    // xterm drops the canvas on dispose, but ANGLE on Windows can keep the driver's context alive
    // long enough for quick tab switches to run into the context budget (Orca, #6874). Losing it
    // explicitly and emptying the canvas returns it at once.
    const renderer = (addon as unknown as WebglAddonInternals)._renderer;
    renderer?._gl?.getExtension("WEBGL_lose_context")?.loseContext();
    if (renderer?._canvas) {
      renderer._canvas.width = 0;
      renderer._canvas.height = 0;
    }
  } catch {
    // Nothing here may keep the terminal from falling back to the DOM renderer.
  }
  try {
    addon.dispose();
  } catch {
    // A context already lost can throw on the way out; the DOM renderer is back either way.
  }
}

/**
 * Puts the terminal on WebGL if it may be. Called before a fit measures it: WebGL floors the cell
 * width to whole device pixels, so the renderer decides the column count, and a renderer changed
 * after the fit would resize the pty a second time.
 */
function acquireWebgl(projectId: string, tabId: string, view: TerminalView): void {
  const key = viewKey(projectId, tabId);
  if (view.webgl || !view.term.element || !webglPool.mayRetry(key, Date.now())) {
    return;
  }
  webglAllowed ??= decideWebgl();
  if (!webglAllowed) {
    return;
  }
  let addon: WebglAddon | undefined;
  try {
    addon = new WebglAddon();
    const attached = addon;
    // Fired once the addon has waited a few seconds for the context to come back.
    attached.onContextLoss(() => {
      if (view.webgl !== attached) {
        return;
      }
      webglPool.recordLoss(key, Date.now());
      webglPool.lost(key);
      releaseWebgl(view);
      // Back on the DOM renderer the cells measure differently; a terminal on screen is refitted
      // for them, the next frame so the addon has finished tearing down. A hidden one is fitted
      // when it is shown again, after `showTerminal` has tried WebGL once more.
      if (inFront.has(key)) {
        requestAnimationFrame(() => fitTerminal(projectId, tabId));
      }
    });
    view.term.loadAddon(attached);
    view.webgl = attached;
    // A new canvas starts empty; without this it stays blank until the next output.
    view.term.refresh(0, view.term.rows - 1);
  } catch (error) {
    console.warn("[tet] WebGL unavailable, terminals draw through the DOM:", error);
    webglAllowed = false;
    try {
      addon?.dispose();
    } catch {
      // A half-constructed addon may throw on dispose.
    }
  }
}

function createView(projectId: string, tabId: string, agent: AgentInfo): TerminalView {
  const fontFamily =
    getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim() || "monospace";

  const term = new Terminal({
    fontFamily,
    fontSize: defaultFontSize(),
    theme: buildXtermTheme(agent),
    scrollback: 4000,
    // The scrollbar is hidden in CSS, but FitAddon's column math still reserves pixel width for
    // it through `options.overviewRuler?.width || 14`. `0` won't work (`0 || 14` is 14), so 1px
    // is the smallest reservation there is. Asking for a ruler also makes xterm *draw* one,
    // outlined in `overviewRulerBorder` whether or not anything is marked in it — which
    // `theme.ts` makes invisible.
    overviewRuler: { width: 1 },
    // Governs OSC 8 hyperlinks the CLI itself emits (plain URL text is the url link provider
    // below). Without this, xterm's built-in OSC 8 handling wins priority over our own link
    // providers and opens links with window.open. Unlike ILinkProvider's ILink, xterm's
    // ILinkHandler has no `decorations` to gate the hover underline behind a modifier — xterm
    // always underlines an OSC 8 link on hover, so activation matches: a plain click opens it.
    linkHandler: {
      activate(_event, text) {
        openUrl(text);
      }
    }
  });

  // The palette is the theme's: OSC 4 *sets* are dropped, queries (`n;?`) still answered. What
  // sends one is ConPTY, forwarding the OSC 4 Codex's win32 launcher writes to give the
  // *console* the theme's colors (src/main/agents/codex/index.ts); honoured here, it would
  // recolor ANSI black and white into the terminal's own background and foreground. A handler
  // returning true stops xterm's own from running.
  term.parser.registerOscHandler(4, (data) => !data.split(";").includes("?"));

  const fit = new FitAddon();
  term.loadAddon(fit);
  // CLIs that support "select to copy" report the selection back via OSC 52, which xterm ignores
  // without this addon.
  term.loadAddon(new ClipboardAddon());
  term.registerLinkProvider(createUrlLinkProvider(term, openUrl, createWrappedUrlResolver(projectId, tabId)));
  term.registerLinkProvider(createFileLinkProvider(term, (filePath) => openFile(projectId, filePath)));

  term.onData((data) => window.tet.terminals.input(projectId, tabId, data));

  term.attachCustomKeyEventHandler((event) => {
    // xterm can't tell Shift+Enter from plain Enter at the data level — both arrive as "\r".
    // Send the ESC+CR sequence agent TUIs read as "insert newline" instead. event.repeat is
    // skipped: flooding a CLI's escape-sequence parser with back-to-back ESC+CR hangs it.
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        window.tet.terminals.input(projectId, tabId, "\x1b\r");
      }
      return false;
    }
    // xterm treats Ctrl+V as the literal control character 0x16 and calls preventDefault()
    // on it, so the browser never fires its native paste event — paste explicitly instead.
    if (event.type === "keydown" && event.key.toLowerCase() === "v" && isModifierHeld(event) && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        void pasteClipboard(term);
      }
      return false;
    }
    // Ctrl+C with a selection copies instead of interrupting, in every terminal type. Without a
    // selection xterm sends \x03 and what it means there is the CLI's own business.
    if (event.type === "keydown" && event.key.toLowerCase() === "c" && isModifierHeld(event) && !event.shiftKey) {
      const selection = term.getSelection();
      if (selection) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          void navigator.clipboard.writeText(selection);
          term.clearSelection();
        }
        return false;
      }
    }
    return true;
  });

  const view: TerminalView = { term, fit, agent };
  const key = viewKey(projectId, tabId);
  views.set(key, view);
  const buffered = earlyOutput.get(key);
  if (buffered) {
    earlyOutput.delete(key);
    term.write(buffered);
  }
  return view;
}

/** Whether this tab has been attached before — its xterm exists, wherever it is mounted now. */
export function hasTerminal(projectId: string, tabId: string): boolean {
  return views.has(viewKey(projectId, tabId));
}

export function attachTerminal(projectId: string, tabId: string, agent: AgentInfo, container: HTMLElement): void {
  // Only the first attach of a tab reads the agent; the view it creates outlives every mount.
  const view = views.get(viewKey(projectId, tabId)) ?? createView(projectId, tabId, agent);
  if (view.term.element?.parentElement === container) {
    return;
  }
  if (view.term.element) {
    // The tab moved, so React gave it a new container. xterm's own open() silently no-ops once
    // `element` is set, rather than moving it, leaving the terminal attached to the detached old
    // container — visible nowhere, and no refit brings back a node that isn't in the tree. Move
    // the existing DOM node instead of reopening it.
    container.appendChild(view.term.element);
  } else {
    view.term.open(container);
    // Only a first open is a tab coming in front of the user; before Pane's fit, see acquireWebgl.
    // A moved tab keeps whatever renderer it had: its canvas moves with the element.
    acquireWebgl(projectId, tabId, view);
  }

  // On the container rather than the document: several terminals are mounted at once, and a drop
  // belongs to the one it landed on. Only for a drag carrying files.
  const holdsFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") === true;
  const frame = (shown: boolean): void => {
    container.classList.toggle("drag-over", shown);
  };

  container.addEventListener("dragover", (event) => {
    if (!holdsFiles(event)) {
      return;
    }
    // Only a prevented dragover makes this a drop target at all.
    event.preventDefault();
    frame(true);
  });
  container.addEventListener("dragleave", (event) => {
    // Fires for every nested element xterm draws, too; only leaving the container counts, and
    // a null relatedTarget is the pointer leaving the window altogether.
    if (!container.contains(event.relatedTarget as Node | null)) {
      frame(false);
    }
  });
  container.addEventListener("drop", (event) => {
    event.preventDefault();
    frame(false);
    void pasteDroppedFiles(view.term, Array.from(event.dataTransfer?.files ?? []));
  });
  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!agent.takesRightMouse) {
      // Nothing reads the right click on its own here (measured per agent at
      // AgentDefinition.takesRightMouse), so tet supplies the usual terminal convention: copy a
      // selection, or paste when there is none.
      const selection = view.term.getSelection();
      if (selection) {
        void navigator.clipboard.writeText(selection);
        view.term.clearSelection();
      } else {
        void pasteClipboard(view.term);
      }
      return;
    }
    // Only the image case: both CLIs act on the right mouse button themselves through xterm's
    // mouse reporting (Claude Code pastes, opencode copies the selection), but neither can paste
    // an image.
    void pasteClipboardImage(view.term);
  });
}

/**
 * Refits the terminal and reports the new size — this is what starts its process. Never split
 * into an immediate local reflow plus a debounced pty notify: ConPTY reflows its own internal
 * screen buffer out from under a CLI's cursor-relative redraw when a resize lands while one is
 * in flight, corrupting the CLI's screen (upstream: microsoft/vscode#230852, #260038). Every
 * resize reflows and notifies together, only once activity settles (`RESIZE_DEBOUNCE_MS` in
 * `Pane.tsx`); a dragged sash can show an empty strip until it stops.
 */
export function fitTerminal(projectId: string, tabId: string): void {
  const view = views.get(viewKey(projectId, tabId));
  if (!view) {
    return;
  }
  // Timed: a change of columns reflows the whole scrollback, synchronously.
  const fitStart = performance.now();
  view.fit.fit();
  reportSlow("fit", performance.now() - fitStart);
  // Every tab and project switch fits twice — the effect that follows the selection and the
  // ResizeObserver's initial notification — and a same-size resize still repaints the CLI.
  const { cols, rows } = view.term;
  if (view.sent?.cols === cols && view.sent.rows === rows) {
    return;
  }
  view.sent = { cols, rows };
  window.tet.terminals.resize(projectId, tabId, cols, rows);
}

/** The terminal came in front of the user; called before its fit, which then measures WebGL cells. */
export function showTerminal(projectId: string, tabId: string): void {
  const key = viewKey(projectId, tabId);
  inFront.add(key);
  webglPool.show(key);
  const view = views.get(key);
  if (view) {
    acquireWebgl(projectId, tabId, view);
  }
}

let trimQueued = false;

/**
 * The terminal went out of sight. It keeps its context unless that pushes one hidden longer out of
 * the pool — decided in a microtask, once the same commit's `showTerminal` calls have taken the
 * terminals coming back on screen out of it (see `WebglPool.trim`). Released contexts are not
 * refitted: the terminal is hidden, and `showTerminal` puts WebGL back before its next fit, so its
 * column count — and the pty — stay as they are.
 */
export function hideTerminal(projectId: string, tabId: string): void {
  const key = viewKey(projectId, tabId);
  inFront.delete(key);
  if (!views.get(key)?.webgl) {
    return;
  }
  webglPool.hide(key);
  if (trimQueued) {
    return;
  }
  trimQueued = true;
  queueMicrotask(() => {
    trimQueued = false;
    for (const evicted of webglPool.trim()) {
      const view = views.get(evicted);
      if (view) {
        releaseWebgl(view);
      }
    }
  });
}

export function focusTerminal(projectId: string, tabId: string): void {
  views.get(viewKey(projectId, tabId))?.term.focus();
}

/** Repaints every terminal in the theme now on the root element; a terminal not built yet reads it
 *  when it is. Colors alone, so no pty is resized. */
export function rethemeTerminals(): void {
  for (const view of views.values()) {
    view.term.options.theme = buildXtermTheme(view.agent);
  }
}

/** Wipes the scrollback and screen — what a restart clears once the command is running again. */
export function clearTerminal(projectId: string, tabId: string): void {
  views.get(viewKey(projectId, tabId))?.term.clear();
}

export function disposeTerminal(projectId: string, tabId: string): void {
  const key = viewKey(projectId, tabId);
  earlyOutput.delete(key);
  const view = views.get(key);
  if (!view) {
    return;
  }
  dropView(key, view);
  webglPool.forget(key);
  forgetUrls(`${key} `);
}

/** One xterm gone for good: out of the map, its WebGL context handed back, its buffer dropped. */
function dropView(key: string, view: TerminalView): void {
  views.delete(key);
  releaseWebgl(view);
  view.term.dispose();
}

/**
 * Every terminal of a project that was closed; the per-tab disposal above only runs for a tab
 * that disappeared from a list the host still reports.
 *
 * Called from the close path, never from a pane's unmount: a lifecycle hook would also fire for
 * a remount that means nothing (a changed key, an error boundary, StrictMode's double-invoke),
 * throwing away the scrollback of terminals that are still running.
 *
 * The ptys are already dead by then — removing a project disposes its session manager in the
 * host. What is dropped here is only the buffers and xterm's DOM.
 */
export function disposeProjectTerminals(projectId: string): void {
  // Project ids are uuids, so nothing else can start with one followed by the separator.
  const prefix = viewKey(projectId, "");
  for (const key of [...earlyOutput.keys()]) {
    if (key.startsWith(prefix)) {
      earlyOutput.delete(key);
    }
  }
  for (const [key, view] of [...views]) {
    if (key.startsWith(prefix)) {
      dropView(key, view);
    }
  }
  webglPool.forgetPrefix(prefix);
  forgetUrls(prefix);
}
