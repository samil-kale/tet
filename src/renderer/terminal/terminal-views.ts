import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { OpenEditor } from "./editor-tab";
import { Terminal } from "@xterm/xterm";
import type { AgentInfo } from "../../shared/types";
import { createFileLinkProvider } from "./links/file-links";
import { endLinkHover, type WrappedUrlResolver } from "./links/link-provider";
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
  /** The size last reported to the pty, so an unchanged fit does not report again. */
  sent?: { cols: number; rows: number };
  /** Set while it holds a WebGL context; otherwise xterm draws through the DOM. */
  webgl?: WebglAddon;
}

/**
 * xterm instances live outside React, written to directly. Tab ids are unique only within their
 * project, so keyed by both.
 */
const views = new Map<string, TerminalView>();

/** Per project, opens a file inside the repository in the preview tab, a Markdown file with its
 *  preview beside the editor if asked. Set by the pane. */
const revealHandlers = new Map<string, (path: string, how: OpenEditor) => void>();

function viewKey(projectId: string, tabId: string): string {
  return `${projectId} ${tabId}`;
}

/**
 * The output path since the last `takeOutputStats`: writes, distinct terminals, and hidden ones —
 * a hidden xterm parses and draws every batch like a visible one. For main.tsx's long-task report.
 * Counting only: it runs per batch and may not cost more than the write.
 */
let outputWrites = 0;
/** The longest write, in characters: xterm parses a write in one piece, so a huge one can hold
 *  the thread. */
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
 * Output arriving before a tab's view exists — a saved command's process starts with its tab and
 * can write before attachTerminal builds the xterm. Replayed once in createView. Capped per tab,
 * for one never attached.
 */
const earlyOutput = new Map<string, string>();
const MAX_EARLY_OUTPUT = 64 * 1024;


// Output arrives batched: one message, and one flush, for every terminal.
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

export function setRevealHandler(
  projectId: string,
  handler: (path: string, how: OpenEditor) => void
): () => void {
  revealHandlers.set(projectId, handler);
  return () => revealHandlers.delete(projectId);
}

/** VS Code's `terminal.integrated.fontSize` default. */
function defaultFontSize(): number {
  return isMac() ? 12 : 14;
}

function openUrl(url: string): void {
  void window.tet.shell.openUrl(url);
}

/** A ctrl-clicked path or a Markdown preview's link: main finds it, opens one outside the
 *  repository itself, and says when there is none. */
export function openFile(projectId: string, filePath: string, markdownPreview = false): void {
  void window.tet.shell.openFile(projectId, filePath).then((repoPath) => {
    if (repoPath) {
      revealHandlers.get(projectId)?.(repoPath, { markdownPreview });
    }
  });
}

/**
 * How long "no such url" is trusted: the url may not have been persisted yet when asked. Short,
 * since a retry is cheap — only while the pointer is on the link, one request in flight.
 */
const NEGATIVE_TTL_MS = 2000;

/**
 * resolveUrl answers by tab and fragment; null means none, not to be asked again. One entry per
 * distinct url hovered, so no eviction.
 */
const resolvedUrls = new Map<string, string | null>();
const negativeAnswers = new Map<string, number>();
const pendingUrlRequests = new Set<string>();

/** Drops every key starting with `prefix` — a gone tab's or project's view key. */
function deletePrefixed(cache: { keys(): Iterable<string>; delete(key: string): unknown }, prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/** Forgets the url answers of a gone tab or project; keys start with their view key. */
function forgetUrls(prefix: string): void {
  for (const cache of [resolvedUrls, negativeAnswers, pendingUrlRequests]) {
    deletePrefixed(cache, prefix);
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
      // Called every render until answered; the in-flight set makes it one request.
      const key = cacheKey(fragment);
      if (pendingUrlRequests.has(key)) {
        return;
      }
      pendingUrlRequests.add(key);
      void window.tet.terminals.resolveUrl(projectId, tabId, fragment).then((url) => {
        // Gone in flight: the terminal closed (forgetUrls); don't put an entry back.
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
 * A path as one word, so a space does not split it. Double quotes read the same in bash, zsh,
 * PowerShell and cmd.exe.
 */
function quotePath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

/**
 * Types the dropped files' paths; content without a path (from a browser) goes to a temp file,
 * swept a day old at startup.
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
    // term.paste, so no CLI input mode misreads it as keystrokes (vim mode, say).
    term.paste(`${paths.map(quotePath).join(" ")} `);
  }
}

/** A copied image has no path either — a temp file too. */
async function pasteClipboardImage(term: Terminal): Promise<boolean> {
  const file = await window.tet.files.clipboardImage();
  if (file === null) {
    return false;
  }
  // The temp directory is under the profile, whose name can hold a space.
  term.paste(`${quotePath(file)} `);
  return true;
}

async function pasteClipboard(term: Terminal): Promise<void> {
  if (!(await pasteClipboardImage(term))) {
    term.paste(await navigator.clipboard.readText());
  }
}

/** Copies the selection and clears it; false when there is none. */
function copySelection(term: Terminal): boolean {
  const selection = term.getSelection();
  if (!selection) {
    return false;
  }
  void navigator.clipboard.writeText(selection);
  term.clearSelection();
  return true;
}

/**
 * WebGL where available and fast; the DOM renderer is the fallback, never a failure. Who holds a
 * context is webgl-pool.ts's; the budget is main.ts's `max-active-webgl-contexts`.
 */
const webglPool = new WebglPool();

/** The terminals in front of the user, as `showTerminal` and `hideTerminal` report them. */
const inFront = new Set<string>();

/** Decided once, on the first terminal; a failed attach anywhere turns it off for the session. */
let webglAllowed: boolean | undefined;

/**
 * Orca's policy, not measured here. On Linux WebGL stays off under Wayland, where a context is
 * reported to wedge terminal input (stablyai/orca#5319), and where the renderer is missing, unnamed
 * or software — slower than the DOM, with glyph corruption that never reports a lost context.
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
    // ANGLE on Windows can keep a disposed context alive long enough for quick tab switches to hit
    // the budget (Orca, #6874); losing it and emptying the canvas returns it at once.
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
    // A lost context can throw here; the DOM renderer is back either way.
  }
}

/**
 * Puts the terminal on WebGL if allowed. Before a fit: WebGL floors the cell width to whole device
 * pixels, so a renderer changed after the fit would resize the pty again.
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
    // Fired after the addon waited a few seconds for the context to return.
    attached.onContextLoss(() => {
      if (view.webgl !== attached) {
        return;
      }
      webglPool.recordLoss(key, Date.now());
      webglPool.lost(key);
      releaseWebgl(view);
      // DOM cells measure differently: refit an on-screen terminal next frame, after the addon's
      // teardown. A hidden one is fitted on show, after `showTerminal` retries WebGL.
      if (inFront.has(key)) {
        requestAnimationFrame(() => fitTerminal(projectId, tabId));
      }
    });
    view.term.loadAddon(attached);
    view.webgl = attached;
    // A new canvas stays blank until the next output otherwise.
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
    // FitAddon reserves `options.overviewRuler?.width || 14` pixels for the hidden scrollbar; `0`
    // gives 14, so 1px is the minimum. The ruler xterm then draws, `theme.ts` makes invisible.
    overviewRuler: { width: 1 },
    // OSC 8 hyperlinks the CLI emits. Without this, xterm's own handling outranks our providers
    // and uses window.open. ILinkHandler has no `decorations` to gate the always-shown hover
    // underline, so activation matches: a plain click opens it.
    linkHandler: {
      activate(_event, text) {
        openUrl(text);
      }
    }
  });

  // OSC 4 *sets* are dropped (returning true skips xterm's handler), queries (`n;?`) answered.
  // ConPTY forwards the OSC 4 Codex's win32 launcher writes for the *console*
  // (src/main/agents/codex/index.ts); honoured, it would recolor ANSI black and white into the
  // terminal's background and foreground.
  term.parser.registerOscHandler(4, (data) => !data.split(";").includes("?"));

  const fit = new FitAddon();
  term.loadAddon(fit);
  // "Select to copy" CLIs send OSC 52, ignored without this addon.
  term.loadAddon(new ClipboardAddon());
  term.registerLinkProvider(createUrlLinkProvider(term, openUrl, createWrappedUrlResolver(projectId, tabId)));
  term.registerLinkProvider(createFileLinkProvider(term, (filePath) => openFile(projectId, filePath)));

  term.onData((data) => window.tet.terminals.input(projectId, tabId, data));

  // Runs before xterm encodes the key. Takes nothing an agent could receive (see `shortcuts.ts`):
  // the three below are handled *for* the terminal, not taken from it.
  term.attachCustomKeyEventHandler((event) => {
    // xterm sends Shift+Enter as plain "\r"; agent TUIs read ESC+CR as "insert newline". Repeats
    // are skipped: back-to-back ESC+CR hangs a CLI's escape-sequence parser.
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        window.tet.terminals.input(projectId, tabId, "\x1b\r");
      }
      return false;
    }
    // xterm sends Ctrl+V as 0x16 and prevents the native paste event, so paste explicitly.
    if (event.type === "keydown" && event.key.toLowerCase() === "v" && isModifierHeld(event) && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        void pasteClipboard(term);
      }
      return false;
    }
    // Ctrl+C with a selection copies, in every terminal; without one, \x03 is the CLI's business.
    // A held key copies once: its repeats find the selection cleared.
    if (event.type === "keydown" && event.key.toLowerCase() === "c" && isModifierHeld(event) && !event.shiftKey) {
      if (copySelection(term)) {
        event.preventDefault();
        event.stopPropagation();
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
  // Only the first attach reads the agent; the view outlives every mount.
  const view = views.get(viewKey(projectId, tabId)) ?? createView(projectId, tabId, agent);
  if (view.term.element?.parentElement === container) {
    return;
  }
  if (view.term.element) {
    // A moved tab gets a new container. xterm's open() silently no-ops once `element` is set,
    // leaving it in the detached old container, so move the node instead.
    container.appendChild(view.term.element);
  } else {
    view.term.open(container);
    // A first open is a tab coming in front, before Pane's fit (acquireWebgl). A moved tab keeps
    // its renderer: the canvas moves with the element.
    acquireWebgl(projectId, tabId, view);
  }

  // On the container, not the document: a drop belongs to the terminal it lands on. Files only.
  const holdsFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") === true;
  const frame = (shown: boolean): void => {
    container.classList.toggle("drag-over", shown);
  };

  container.addEventListener("dragover", (event) => {
    if (!holdsFiles(event)) {
      return;
    }
    // Only a prevented dragover makes this a drop target.
    event.preventDefault();
    frame(true);
  });
  container.addEventListener("dragleave", (event) => {
    // Also fires for xterm's children; only leaving the container (or window: null) counts.
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
      // Nothing takes the right click (measured, AgentDefinition.takesRightMouse): copy a
      // selection, else paste.
      if (!copySelection(view.term)) {
        void pasteClipboard(view.term);
      }
      return;
    }
    // The CLI takes the right button via mouse reporting (Claude Code pastes, opencode copies),
    // but neither pastes an image.
    void pasteClipboardImage(view.term);
  });
}

/**
 * Refits and reports the new size — which starts the process. Never an immediate local reflow
 * plus a debounced pty notify: a resize landing mid-redraw has ConPTY reflow its buffer under the
 * CLI's cursor-relative redraw, corrupting it (microsoft/vscode#230852, #260038). Reflow and
 * notify go together once activity settles (`RESIZE_DEBOUNCE_MS` in `Pane.tsx`).
 */
export function fitTerminal(projectId: string, tabId: string): void {
  const view = views.get(viewKey(projectId, tabId));
  if (!view) {
    return;
  }
  // Timed: a column change reflows the whole scrollback synchronously.
  const fitStart = performance.now();
  view.fit.fit();
  reportSlow("fit", performance.now() - fitStart);
  // Every switch fits twice (the selection effect, the ResizeObserver's first notification), and
  // a same-size resize still repaints the CLI.
  const { cols, rows } = view.term;
  if (view.sent?.cols === cols && view.sent.rows === rows) {
    return;
  }
  view.sent = { cols, rows };
  window.tet.terminals.resize(projectId, tabId, cols, rows);
}

/** In front of the user; called before its fit, which then measures WebGL cells. */
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
 * Out of sight. Keeps its context unless over budget — decided in a microtask, after the same
 * commit's `showTerminal` calls (`WebglPool.trim`). A released one is not refitted: `showTerminal`
 * restores WebGL before its next fit, so columns and pty stay.
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

/** Repaints every built terminal in the root element's current theme. Colors only: no resize. */
export function rethemeTerminals(): void {
  for (const view of views.values()) {
    view.term.options.theme = buildXtermTheme(view.agent);
  }
}

/** Wipes scrollback and screen, for a restart. Written as a reset (RIS) rather than `clear()`, so it
 *  lands after output xterm has queued but not parsed yet, and takes the cursor line too. */
export function clearTerminal(projectId: string, tabId: string): void {
  views.get(viewKey(projectId, tabId))?.term.write("\x1bc");
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

/** One xterm gone for good. */
function dropView(key: string, view: TerminalView): void {
  views.delete(key);
  releaseWebgl(view);
  endLinkHover(view.term);
  view.term.dispose();
}

/**
 * Every terminal of a closed project; `disposeTerminal` only covers tabs gone from a list the host
 * still reports.
 *
 * From the close path, never a pane's unmount: a meaningless remount (changed key, error boundary,
 * StrictMode) would throw away running terminals' scrollback.
 *
 * The ptys are already dead (the host disposed the session manager); only buffers and DOM go.
 */
export function disposeProjectTerminals(projectId: string): void {
  // Project ids are uuids: no other key starts with one plus the separator.
  const prefix = viewKey(projectId, "");
  deletePrefixed(earlyOutput, prefix);

  for (const [key, view] of [...views]) {
    if (key.startsWith(prefix)) {
      dropView(key, view);
    }
  }
  webglPool.forgetPrefix(prefix);
  forgetUrls(prefix);
}
