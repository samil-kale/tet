import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AgentInfo } from "../shared/types";
import { createFileLinkProvider } from "./links/file-links";
import type { WrappedUrlResolver } from "./links/link-provider";
import { createUrlLinkProvider } from "./links/url-links";
import { isMac, isModifierHeld } from "./platform";
import { buildXtermTheme } from "./theme";

interface TerminalView {
  term: Terminal;
  fit: FitAddon;
  /** The size last reported to the pty, so a fit that changed nothing does not report again. */
  sent?: { cols: number; rows: number };
}

/**
 * xterm instances live outside React: terminal output is written straight to them instead of
 * going through component state, and they survive view and project switches unchanged.
 * Tab ids are only unique within their project, so views are keyed by both.
 */
const views = new Map<string, TerminalView>();

/**
 * Per project, what to do when a ctrl-clicked file turns out to have local changes: the diff
 * dialog opens on it. Registered by the pane, which is what has the callback for that.
 */
const revealHandlers = new Map<string, (path: string) => void>();

function viewKey(projectId: string, tabId: string): string {
  return `${projectId} ${tabId}`;
}

// One batch per flush, in the order the main process collected it — a terminal that produced
// nothing in that window is simply not in it.
window.tet.terminals.onOutput((batch) => {
  for (const { projectId, tabId, data } of batch) {
    views.get(viewKey(projectId, tabId))?.term.write(data);
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
 * How long a "the agent knows no such url" answer is trusted. Not forever: the url may simply
 * not have been persisted when it was first asked about — a message still being written is the
 * normal case for a link that just appeared. Kept short because a retry is cheap: it only fires
 * while the pointer sits on that link, the in-flight set folds the per-render calls into one
 * request, and the host answers from a local http call.
 */
const NEGATIVE_TTL_MS = 2000;

/**
 * Answers to resolveUrl, keyed by the tab and fragment asked about; null means the host has
 * no url for it and it must not be asked again. Only grows by one entry per distinct url the
 * user holds the modifier over, so it needs no eviction.
 */
const resolvedUrls = new Map<string, string | null>();
const negativeAnswers = new Map<string, number>();
const pendingUrlRequests = new Set<string>();

/**
 * Forgets every url answer belonging to a terminal that is gone — one tab's, or a whole
 * project's. Keys start with the view they were asked for, so the prefix is all it takes.
 * Nothing looks them up afterwards: only a mounted terminal's link provider reads them.
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
      // provideLinks runs per render, so this is called until the answer lands — the
      // in-flight set is what keeps that down to a single request.
      const key = cacheKey(fragment);
      if (pendingUrlRequests.has(key)) {
        return;
      }
      pendingUrlRequests.add(key);
      void window.tet.terminals.resolveUrl(projectId, tabId, fragment).then((url) => {
        // Gone while this was in flight means the terminal it was asked for was closed
        // (see forgetUrls) — the answer belongs to nothing and must not put an entry back.
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
 * Types the dropped files' paths, the way a hand-typed reference would arrive. A file dragged
 * in from the filesystem has a real path; one dragged out of a browser carries only its
 * content, and is saved to a temp file first so there is a path to name.
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
    // Through term.paste, like clipboard text, so whatever input mode the CLI is in cannot
    // misread it as individual keystrokes (vim-mode commands, say).
    term.paste(`${paths.join(" ")} `);
  }
}

/** A copied screenshot has no path either — same temp-file trick, from the clipboard. */
async function pasteClipboardImage(term: Terminal): Promise<boolean> {
  const file = await window.tet.files.clipboardImage();
  if (file === null) {
    return false;
  }
  term.paste(`${file} `);
  return true;
}

async function pasteClipboard(term: Terminal): Promise<void> {
  if (!(await pasteClipboardImage(term))) {
    term.paste(await navigator.clipboard.readText());
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
    // The scrollbar is hidden in CSS, but FitAddon's column math still reserves pixel width
    // for it through `options.overviewRuler?.width || 14`, leaving a dead gap on the right.
    // `0` won't work (`0 || 14` is 14), so 1px is the smallest reservation there is. Asking
    // for a ruler also makes xterm *draw* one, outlined in `overviewRulerBorder` whether or
    // not anything is marked in it — which `theme.ts` therefore makes invisible.
    overviewRuler: { width: 1 },
    // Governs OSC 8 hyperlinks the CLI itself may emit (as opposed to plain URL text, which
    // the url link provider below matches by regex). Without this, xterm's built-in OSC 8
    // handling wins priority over our own link providers and opens links with window.open.
    //
    // Unlike ILinkProvider's ILink, xterm's ILinkHandler has no `decorations` to gate the
    // hover underline behind a modifier — xterm always shows it on hover for an OSC 8 link.
    // Gating only the click there would leave a link that visibly invites a click but eats it,
    // so activation matches the affordance instead: a plain click opens it.
    linkHandler: {
      activate(_event, text) {
        openUrl(text);
      }
    }
  });

  // The palette is the theme's, not a program's to repaint: OSC 4 *sets* are dropped, queries
  // (`n;?`) still answered. What actually sends one is ConPTY, forwarding the OSC 4 Codex's
  // win32 launcher writes to give the *console* the theme's colors (src/agents/codex/index.ts)
  // — honoured here, that would recolor ANSI black and white into the terminal's own
  // background and foreground. A handler returning true stops xterm's own from running.
  term.parser.registerOscHandler(4, (data) => !data.split(";").includes("?"));

  const fit = new FitAddon();
  term.loadAddon(fit);
  // CLIs that support "select to copy" report the selection back via OSC 52, which xterm
  // ignores without this addon — the CLI's copy would silently go nowhere.
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
    // selection it keeps sending \x03, which most CLIs read as an ordinary byte — except where
    // it would kill the process outright, so the key is swallowed there instead; the measured
    // per-agent story is at AgentDefinition.plainCtrlCKills.
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
      if (agent.plainCtrlCKills) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
    }
    return true;
  });

  const view: TerminalView = { term, fit };
  views.set(viewKey(projectId, tabId), view);
  return view;
}

/** Whether this tab has been attached before — its xterm exists, wherever it is mounted now. */
export function hasTerminal(projectId: string, tabId: string): boolean {
  return views.has(viewKey(projectId, tabId));
}

export function attachTerminal(projectId: string, tabId: string, agent: AgentInfo, container: HTMLElement): void {
  // Only the first attach of a tab reads the agent — a tab keeps the one it was opened for,
  // and the view it created outlives every mount.
  const view = views.get(viewKey(projectId, tabId)) ?? createView(projectId, tabId, agent);
  if (view.term.element?.parentElement === container) {
    return;
  }
  if (view.term.element) {
    // The tab moved — dragged into another pane of the split, or its pane's place in the tree
    // changed with the preset — so React gave it a new container; this is not a first attach.
    // xterm's own open() silently no-ops once `element` is already set, rather than moving it,
    // so the terminal would stay attached to the now-detached old container: visible nowhere,
    // and no resize or refit brings back a node that isn't in the tree. Move the existing DOM
    // node instead of reopening it.
    container.appendChild(view.term.element);
  } else {
    view.term.open(container);
  }

  // On the container rather than the document: several terminals are mounted at once, and a
  // drop belongs to the one it landed on — which is what the frame says. It only appears for a
  // drag carrying files, since that is all this takes; a project row dragged past carries a
  // type of its own and is no drop here.
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
      // Nothing reads the right click on its own here — the shell never turns on xterm's mouse
      // reporting, and which TUIs leave the mouse to the terminal is measured at
      // AgentDefinition.takesRightMouse — so tet supplies the usual terminal convention itself:
      // copy a selection, or paste when there is none.
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
    // mouse reporting (Claude Code pastes, opencode copies the selection), and handling plain
    // text here too would risk clobbering an opencode copy. Neither can paste an image out of
    // its own handling, so that part stays ours.
    void pasteClipboardImage(view.term);
  });
}

/**
 * Refits the terminal and reports the new size — this is what starts its process. Deliberately
 * not split into an immediate local reflow plus a debounced pty notify: ConPTY can reflow its
 * own internal screen buffer out from under a CLI's own cursor-relative redraw when a resize
 * lands while one is in flight, corrupting the CLI's screen (an upstream Windows bug — VS Code
 * hits the identical symptom, e.g. microsoft/vscode#230852, #260038, closed by xterm.js's own
 * maintainer as unfixable from the application side). Reflowing xterm locally ahead of telling
 * the pty widened that window for the whole length of a drag; every resize now reflows and
 * notifies together, only once activity settles (see `RESIZE_DEBOUNCE_MS` in `Pane.tsx`) — a
 * dragged sash can show an empty strip until it stops, which is the trade we take instead.
 */
export function fitTerminal(projectId: string, tabId: string): void {
  const view = views.get(viewKey(projectId, tabId));
  if (!view) {
    return;
  }
  view.fit.fit();
  // Every tab and project switch fits twice — the effect that follows the selection and the
  // ResizeObserver's initial notification — and a same-size resize still repaints the CLI.
  const { cols, rows } = view.term;
  if (view.sent?.cols === cols && view.sent.rows === rows) {
    return;
  }
  view.sent = { cols, rows };
  window.tet.terminals.resize(projectId, tabId, cols, rows);
}

export function focusTerminal(projectId: string, tabId: string): void {
  views.get(viewKey(projectId, tabId))?.term.focus();
}

/** Wipes the scrollback and screen — what a restart clears once the command is running again. */
export function clearTerminal(projectId: string, tabId: string): void {
  views.get(viewKey(projectId, tabId))?.term.clear();
}

export function disposeTerminal(projectId: string, tabId: string): void {
  const key = viewKey(projectId, tabId);
  const view = views.get(key);
  if (!view) {
    return;
  }
  views.delete(key);
  view.term.dispose();
  forgetUrls(`${key} `);
}

/**
 * Every terminal of a project that was closed. Without this they would sit here for the rest of
 * the session: the pane that mounted them is gone, and the per-tab disposal above only runs for
 * a tab that disappeared from a list the host still reports.
 *
 * Called from the close path rather than from a pane's unmount, deliberately. Today that
 * unmount happens in one place — `App` renders one pane per project, keyed by project id — but
 * a lifecycle hook would also fire for a remount that means nothing (a changed key, an error
 * boundary, StrictMode's double-invoke), each of which would throw away the scrollback of
 * terminals that are still running. "This project is gone" cannot fire by accident.
 *
 * The ptys are already dead by then: removing a project disposes its session manager in the
 * host. What is dropped here is only what the renderer holds — the buffers and xterm's DOM.
 */
export function disposeProjectTerminals(projectId: string): void {
  // Project ids are uuids, so nothing else can start with one followed by the separator.
  const prefix = viewKey(projectId, "");
  for (const [key, view] of [...views]) {
    if (key.startsWith(prefix)) {
      views.delete(key);
      view.term.dispose();
    }
  }
  forgetUrls(prefix);
}
