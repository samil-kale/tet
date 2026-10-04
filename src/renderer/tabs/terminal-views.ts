import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { openFile } from "../editor/editor-tab";
import { Terminal } from "@xterm/xterm";
import { CONTROL_START_SIZE } from "../../shared/control";
import { projectRefKey } from "../../shared/types/project";
import type { ProjectRef } from "../../shared/types/project";
import { createFileLinkProvider } from "./links/file-links";
import { endLinkHover } from "./links/link-provider";
import { createUrlLinkProvider } from "./links/url-links";
import { isModifierHeld, PLATFORM } from "../platform";
import { buildXtermTheme, editorFontFamily } from "../themes/theme-colors";
import { isSoftwareRenderer, WebglPool } from "./webgl-pool";

interface TerminalView {
  /** The tab's repository or worktree, whose drops folder and sandbox a drop or paste goes through. */
  ref: ProjectRef;
  tabId: string;
  term: Terminal;
  fit: FitAddon;
  /** What Shift+Enter sends, its agent's (AgentInfo.shiftEnter); unset: xterm's own. */
  shiftEnter?: string;
  /** The size last reported to the pty, so an unchanged fit does not report again. */
  sent?: { cols: number; rows: number };
  /** Set while it holds a WebGL context; otherwise xterm draws through the DOM. */
  webgl?: WebglAddon;
  /** A focus-out report held back while the focus stayed in the window (`FOCUS_OUT`). */
  focusOutHeld?: boolean;
}

/**
 * The focus reports (DECSET 1004) xterm sends. Claude Code drops a click that comes while it thinks
 * it is unfocused, so a click into a terminal that lost the focus to a lane or another pane
 * would only focus it. So a terminal is told of losing the focus only once the window loses it;
 * focus moving within the window is not reported.
 */
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/**
 * xterm instances live outside React, written to directly. Tab ids are unique only within their
 * project, so keyed by both.
 */
const views = new Map<string, TerminalView>();


function viewKey(ref: ProjectRef, tabId: string): string {
  return `${projectRefKey(ref)} ${tabId}`;
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
  for (const { ref, tabId, data } of batch) {
    const key = viewKey(ref, tabId);
    const view = views.get(key);
    if (!view) {
      earlyOutput.set(key, ((earlyOutput.get(key) ?? "") + data).slice(-MAX_EARLY_OUTPUT));
      continue;
    }
    view.term.write(data);
  }
});

window.tet.terminals.onTextRequest((ref, tabId) => shownText(ref, tabId));

/**
 * What the tab's terminal shows, as text — its scrollback and screen, or a fullscreen TUI's screen
 * (the alternate buffer) — once xterm has parsed everything it was handed; a wrapped row joins the
 * line it continues. `tabs-output`. A tab never attached that printed — one `tet-ctl` started —
 * gets its xterm now, unopened and at the size it was started at, to parse what `earlyOutput` holds.
 */
async function shownText(ref: ProjectRef, tabId: string): Promise<string> {
  const key = viewKey(ref, tabId);
  const view = views.get(key) ?? (earlyOutput.has(key) ? createView(ref, tabId, CONTROL_START_SIZE) : undefined);
  if (!view) {
    return "";
  }
  await new Promise<void>((resolve) => view.term.write("", resolve));
  const buffer = view.term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }
    // A row continued by the next keeps its trailing blanks: they are spaces of the line.
    const text = line.translateToString(buffer.getLine(row + 1)?.isWrapped !== true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n").trimEnd();
}

// Leaving the window is the focus loss a terminal is told of (`FOCUS_OUT`).
window.addEventListener("blur", () => {
  for (const view of views.values()) {
    if (view.focusOutHeld) {
      view.focusOutHeld = false;
      window.tet.terminals.input(view.ref, view.tabId, FOCUS_OUT);
    }
  }
});

function openUrl(url: string): void {
  void window.tet.shell.openUrl(url);
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

/** Types the words, as main quoted them for the tab (handPaths); term.paste, so no CLI input mode
 *  misreads them as keystrokes (vim mode, say). */
function pastePaths(view: TerminalView, words: string[]): void {
  if (words.length > 0) {
    view.term.paste(`${words.join(" ")} `);
  }
}

/** Types paths of this machine as the tab sees them (handPaths), in the order given. */
async function handPaths(view: TerminalView, paths: string[]): Promise<void> {
  pastePaths(view, await window.tet.files.handPaths(view.ref, view.tabId, paths));
}

/**
 * Types the dropped files' paths; content without a path (from a browser) is written into the
 * tab's drops folder first, swept a day old at startup.
 */
async function pasteDroppedFiles(view: TerminalView, files: File[]): Promise<void> {
  const paths: string[] = [];
  for (const file of files) {
    const filePath =
      window.tet.files.pathOf(file) ||
      (await window.tet.files.writeDrop(view.ref, view.tabId, file.name, toBase64(await file.arrayBuffer())));
    if (filePath) {
      paths.push(filePath);
    }
  }
  await handPaths(view, paths);
}

/** A copied image has no path either — written into the drops folder too. */
async function pasteClipboardImage(view: TerminalView): Promise<boolean> {
  const file = await window.tet.files.clipboardImage(view.ref, view.tabId);
  if (file === null) {
    return false;
  }
  await handPaths(view, [file]);
  return true;
}

async function pasteClipboard(view: TerminalView): Promise<void> {
  if (!(await pasteClipboardImage(view))) {
    view.term.paste(await navigator.clipboard.readText());
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
 * Where the GPU is to be checked (Platform.checksGpu), WebGL stays off under Wayland, where a
 * context can wedge terminal input, and where the renderer is missing, unnamed or software —
 * slower than the DOM, with glyph corruption that never reports a lost context.
 */
function decideWebgl(): boolean {
  if (!PLATFORM.checksGpu) {
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
    // the budget; losing it and emptying the canvas returns it at once.
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
function acquireWebgl(ref: ProjectRef, tabId: string, view: TerminalView): void {
  const key = viewKey(ref, tabId);
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
        requestAnimationFrame(() => fitTerminal(ref, tabId));
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

/** At xterm's default size unless `size` is given; the first fit sets the window's. */
function createView(ref: ProjectRef, tabId: string, size?: { cols: number; rows: number }): TerminalView {
  const term = new Terminal({
    ...size,
    fontFamily: editorFontFamily(),
    fontSize: PLATFORM.terminalFontSize,
    theme: buildXtermTheme(),
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
    },
    // `term.unicode` is a proposed API (the Unicode 11 widths below).
    allowProposedApi: true
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
  // Unicode 11's widths, not xterm's default 6: a TUI lays out emoji and symbols like ⏺ at two
  // columns where Unicode 6 counts one, and the cursor drifts off what it drew.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.registerLinkProvider(createUrlLinkProvider(term, openUrl));
  term.registerLinkProvider(createFileLinkProvider(term, (filePath) => openFile(ref, filePath)));

  term.onData((data) => {
    if (data === FOCUS_OUT && document.hasFocus()) {
      view.focusOutHeld = true;
      return;
    }
    if (data === FOCUS_IN && view.focusOutHeld) {
      view.focusOutHeld = false;
      return;
    }
    window.tet.terminals.input(ref, tabId, data);
  });

  // Runs before xterm encodes the key. Takes nothing an agent could receive (see `shortcuts.ts`):
  // the three below are handled *for* the terminal, not taken from it.
  term.attachCustomKeyEventHandler((event) => {
    // Shift+Enter sends the agent's newline sequence where it has one. Repeats are skipped:
    // back-to-back ESC+CR hangs a CLI's escape-sequence parser.
    const shiftEnter = view.shiftEnter;
    if (shiftEnter !== undefined && event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        window.tet.terminals.input(ref, tabId, shiftEnter);
      }
      return false;
    }
    // xterm sends Ctrl+V as 0x16 and prevents the native paste event, so paste explicitly.
    if (event.type === "keydown" && event.key.toLowerCase() === "v" && isModifierHeld(event) && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        void pasteClipboard(view);
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

  const view: TerminalView = { ref, tabId, term, fit };
  const key = viewKey(ref, tabId);
  views.set(key, view);
  const buffered = earlyOutput.get(key);
  if (buffered) {
    earlyOutput.delete(key);
    term.write(buffered);
  }
  return view;
}

/** Whether this tab has been attached before — its xterm is open, wherever it is mounted now. One
 *  `shownText` made without attaching is not. */
export function hasTerminal(ref: ProjectRef, tabId: string): boolean {
  return views.get(viewKey(ref, tabId))?.term.element !== undefined;
}

export function attachTerminal(ref: ProjectRef, tabId: string, container: HTMLElement, shiftEnter: string | undefined): void {
  // The view outlives every mount.
  const view = views.get(viewKey(ref, tabId)) ?? createView(ref, tabId);
  // Set on every attach: the agents' list may land after the first.
  view.shiftEnter = shiftEnter;
  if (view.term.element?.parentElement === container) {
    return;
  }
  if (view.term.element) {
    // A moved tab gets a new container. xterm's open() silently no-ops once `element` is set,
    // leaving it in the detached old container, so move the node instead.
    container.appendChild(view.term.element);
  } else {
    view.term.open(container);
    // A first open is a tab coming in front, before its host's fit (acquireWebgl). A moved tab keeps
    // its renderer: the canvas moves with the element.
    acquireWebgl(ref, tabId, view);
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
    void pasteDroppedFiles(view, Array.from(event.dataTransfer?.files ?? []));
  });
  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // Asked per click, not per agent: whether a TUI reports the mouse depends on its mode (Codex
    // only in its fullscreen transcript). Without reporting — the shell — nothing takes the
    // right click: copy a selection, else paste.
    if (view.term.modes.mouseTrackingMode === "none") {
      if (!copySelection(view.term)) {
        void pasteClipboard(view);
      }
      return;
    }
    // The CLI takes the right button (Claude Code and pi paste, Codex copies a selection), but
    // none pastes an image.
    void pasteClipboardImage(view);
  });
}

/**
 * Refits and reports the new size — which starts the process. Never an immediate local reflow
 * plus a debounced pty notify: a resize landing mid-redraw has ConPTY reflow its buffer under the
 * CLI's cursor-relative redraw, corrupting it. Reflow and notify go together once activity settles
 * (`RESIZE_DEBOUNCE_MS` in `TerminalHost.tsx`).
 */
export function fitTerminal(ref: ProjectRef, tabId: string): void {
  const view = views.get(viewKey(ref, tabId));
  if (!view) {
    return;
  }
  view.fit.fit();
  // Every switch fits twice (the host's show effect, the ResizeObserver's first notification), and
  // a same-size resize still repaints the CLI.
  const { cols, rows } = view.term;
  if (view.sent?.cols === cols && view.sent.rows === rows) {
    return;
  }
  view.sent = { cols, rows };
  window.tet.terminals.resize(ref, tabId, cols, rows);
}

/** In front of the user; called before its fit, which then measures WebGL cells. */
export function showTerminal(ref: ProjectRef, tabId: string): void {
  const key = viewKey(ref, tabId);
  inFront.add(key);
  webglPool.show(key);
  const view = views.get(key);
  if (view) {
    acquireWebgl(ref, tabId, view);
  }
}

let trimQueued = false;

/**
 * Out of sight. Keeps its context unless over budget — decided in a microtask, after the same
 * commit's `showTerminal` calls (`WebglPool.trim`). A released one is not refitted: `showTerminal`
 * restores WebGL before its next fit, so columns and pty stay.
 */
export function hideTerminal(ref: ProjectRef, tabId: string): void {
  const key = viewKey(ref, tabId);
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

export function focusTerminal(ref: ProjectRef, tabId: string): void {
  views.get(viewKey(ref, tabId))?.term.focus();
}

/** Repaints every built terminal in the root element's current theme. Colors only: no resize. */
export function rethemeTerminals(): void {
  const theme = buildXtermTheme();
  for (const view of views.values()) {
    view.term.options.theme = theme;
  }
}

/** Wipes scrollback and screen, for a restart. Written as a reset (RIS) rather than `clear()`, so it
 *  lands after output xterm has queued but not parsed yet, and takes the cursor line too. */
export function clearTerminal(ref: ProjectRef, tabId: string): void {
  views.get(viewKey(ref, tabId))?.term.write("\x1bc");
}

/** Turns off the mouse reporting modes (and focus reporting) a killed process left on, so its
 *  successor does not get mouse moves typed at it before it asks for them itself. */
export function resetMouseModes(ref: ProjectRef, tabId: string): void {
  views.get(viewKey(ref, tabId))?.term.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l");
}

/** Wipes scrollback and screen but the cursor line, for the user's Clear: the shell's prompt stays,
 *  as it would not redraw a wiped one. */
export function clearTerminalOutput(ref: ProjectRef, tabId: string): void {
  views.get(viewKey(ref, tabId))?.term.clear();
}

export function disposeTerminal(ref: ProjectRef, tabId: string): void {
  const key = viewKey(ref, tabId);
  earlyOutput.delete(key);
  const view = views.get(key);
  if (!view) {
    return;
  }
  dropView(key, view);
  webglPool.forget(key);
}

/** One xterm gone for good. */
function dropView(key: string, view: TerminalView): void {
  views.delete(key);
  releaseWebgl(view);
  endLinkHover(view.term);
  view.term.dispose();
}

/**
 * Every terminal of a closed repository or worktree; `disposeTerminal` only covers tabs gone from a list the host
 * still reports.
 *
 * From the close path, never a pane's unmount: a meaningless remount (changed key, error boundary,
 * StrictMode) would throw away running terminals' scrollback.
 *
 * The ptys are already dead (the host disposed the session manager); only buffers and DOM go.
 */
export function disposeRefTerminals(ref: ProjectRef): void {
  // A repository's or worktree's key holds no space: no other key starts with it plus the separator
  // (shared/types/project.ts's projectRefKey).
  const prefix = viewKey(ref, "");
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
}
