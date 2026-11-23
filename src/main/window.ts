import * as path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { WINDOW_ARGS } from "../shared/api";
import type { EventChannels, WindowReply } from "../shared/ipc";
import type { ThemeDefinition } from "../shared/themes";
import { refKeyOf } from "../shared/types/project";
import type { Notice, NoticeProgress, NoticeSeverity } from "../shared/types/app";
import type { ProjectRef } from "../shared/types/project";
import type { TabRef, TerminalOutput } from "../shared/types/terminals";
import { on, once } from "./ipc/channels";
import { logError } from "./util/error-log";
import { PLATFORM } from "./util/host-platform";
import { isOpenableUrl } from "./util/shell-open";

/** Output arrives in small chunks; batch them rather than one IPC message each. */
const OUTPUT_FLUSH_MS = 8;
/** The same while the window is out of the user's sight: nobody watches the lines scroll. */
const BACKGROUND_OUTPUT_FLUSH_MS = 64;
/** The most one tab hands the window per timed flush; the rest follows on the next. */
const MAX_FLUSH_CHARS = 64 * 1024;
/** Sent to a tab's terminal and not yet parsed, above which its process is paused... */
const OUTPUT_HIGH_WATER = 256 * 1024;
/** ...and below which it runs again. */
const OUTPUT_LOW_WATER = 64 * 1024;
/** A paused process runs again after this long without an ack: a window that never answers (a page
 *  reloading, a lost message) must not freeze it. */
const OUTPUT_PAUSE_LIMIT_MS = 3000;
/** Minimum gap between two renderer-crash rebuilds. */
const RENDERER_REBUILD_GAP_MS = 60_000;
/** How long a window stays hidden for the page's `app:drawn` before it shows regardless. */
const SHOW_FALLBACK_MS = 5000;
/** A question's wait for the window: one in its requirements check or reloading never answers. */
const WINDOW_ANSWER_TIMEOUT_MS = 2000;

/** A tab's output sent to the window and not yet parsed there. */
interface FlowState extends TabRef {
  chars: number;
  paused: boolean;
  /** Resumed by `OUTPUT_PAUSE_LIMIT_MS` or out of sight: not paused again until below the low water. */
  gaveUp: boolean;
  limit: ReturnType<typeof setTimeout> | undefined;
}

function flowKey(ref: ProjectRef, tabId: string): string {
  return `${refKeyOf(ref)}\u0000${tabId}`;
}

export interface AppWindowDeps {
  /** For tests run locally (test/helpers/): the window is drawn but never shown. */
  hidden: boolean;
  /** Whether the tab is still open: output batched for one closed meanwhile is dropped. */
  hasTab(ref: ProjectRef, tabId: string): boolean;
  /** Stops or resumes reading the tab's process (flow control, see `ackOutput`). */
  setOutputPaused(ref: ProjectRef, tabId: string, paused: boolean): void;
  /** A page load began, reloads included: what the page showed is gone with it. */
  onPageLoad(): void;
}

/**
 * The window and everything that talks to it: what main sends it, the notices held until it
 * listens, the terminals' batched output, its theme, and asking it for an editor's text. One
 * window at a time; before it exists and after it closed, what is sent to it is dropped.
 */
export class AppWindow {
  private window: BrowserWindow | undefined;
  private rendererRebuiltAt = 0;
  /** A rebuild held back by RENDERER_REBUILD_GAP_MS, run once the gap has passed. */
  private rendererRebuildTimer: NodeJS.Timeout | undefined;
  /**
   * Notices sent before the window listens are held: `App` subscribes only after the requirements
   * check, and a fast sender (the update's "Updated to") would otherwise be lost. The renderer
   * reports listening via `app:notice-listening` (preload's `onNotice`); every page load resets it.
   * A progress is dropped instead: its next step shows it anew. Its end on `done` is held as the
   * notice it becomes.
   */
  private noticesHeard = false;
  private readonly heldNotices: Notice[] = [];
  private windowQuestions = 0;
  private readonly pendingOutput = new Map<string, TerminalOutput>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly foregroundListeners: (() => void)[] = [];
  /** Per tab, what was sent and not yet acked; an entry lives while it is nonzero or paused. */
  private readonly inFlight = new Map<string, FlowState>();
  /** The theme on screen: the window's initial one or the last `showTheme` took. */
  private theme: ThemeDefinition | undefined;
  /** `AppearanceSettings.backgroundGradient` on screen: the window's initial one or the last
   *  `showBackgroundGradient` took. */
  private backgroundGradient = true;

  constructor(private readonly deps: AppWindowDeps) {
    on("app:drawn", () => this.showOnce(this.liveWindow()));
    on("tabs:output-ack", (_event, ref, tabId, length) => this.ackOutput(ref, tabId, length));
    on("app:notice-listening", () => {
      this.noticesHeard = true;
      for (const notice of this.heldNotices.splice(0)) {
        this.send("app:notice", notice);
      }
    });
  }

  /** The window while it stands; undefined before it exists, once closed, or while destroyed. */
  private liveWindow(): BrowserWindow | undefined {
    return this.window?.isDestroyed() === false ? this.window : undefined;
  }

  /** Shows the window the first time only: a reloaded page reports again, and `show` would take
   *  the focus back from whatever the user is in. */
  private showOnce(window: BrowserWindow | undefined): void {
    if (!this.deps.hidden && window && !window.isDestroyed() && !window.isVisible()) {
      window.show();
    }
  }

  send = <C extends keyof EventChannels>(channel: C, payload: EventChannels[C]): void => {
    if (channel === "app:notice" && !this.noticesHeard) {
      this.heldNotices.push(payload as Notice);
      return;
    }
    if (channel === "app:notice-progress" && !this.noticesHeard) {
      const progress = payload as NoticeProgress;
      if (progress.fraction === undefined && progress.done) {
        this.heldNotices.push({ severity: "info", message: progress.message });
      }
      return;
    }
    this.liveWindow()?.webContents.send(channel, payload);
  };

  /** Everything the user is told from this process (Notices.tsx), held as `send` holds it. */
  notice = (severity: NoticeSeverity, message: string, title?: string): void => {
    this.send("app:notice", { severity, title, message });
  };

  noticeProgress = (progress: NoticeProgress): void => {
    this.send("app:notice-progress", progress);
  };

  /** Whether the page listens and a question can show now. */
  listening(): boolean {
    return this.noticesHeard && this.liveWindow() !== undefined;
  }

  /** Calls `listener` whenever the window comes back into sight: focused, shown or restored. */
  onForeground(listener: () => void): void {
    this.foregroundListeners.push(listener);
  }

  /** Out of the user's sight: unfocused, or minimized — a win32 window minimized by its button
   *  still reports `isFocused`. */
  inBackground(): boolean {
    const window = this.liveWindow();
    return window !== undefined && (!window.isFocused() || window.isMinimized());
  }

  /** Nowhere on screen: minimized or hidden. A window merely unfocused still shows beside others;
   *  one drawn for tests never shows and counts as in sight. */
  outOfSight(): boolean {
    const window = this.liveWindow();
    return !this.deps.hidden && window !== undefined && (window.isMinimized() || !window.isVisible());
  }

  /** A repository's or worktree's active editor tab text (ControlDeps.editorContent). */
  editorContent = (ref: ProjectRef): Promise<string | undefined> =>
    this.askWindow((reply) => this.send("editor:content-request", { ref, reply }));

  /** What a tab's terminal shows (ControlDeps.terminalText), its batched output handed over first. */
  terminalText = (ref: ProjectRef, tabId: string): Promise<string | undefined> => {
    this.flushOutput();
    return this.askWindow((reply) => this.send("tabs:text-request", { ref, tabId, reply }));
  };

  /** Asks the window on a per-question reply channel; undefined when it does not answer. */
  private askWindow(ask: (reply: WindowReply) => void): Promise<string | undefined> {
    if (!this.liveWindow()) {
      return Promise.resolve(undefined);
    }
    this.windowQuestions += 1;
    const reply: WindowReply = `window:reply:${this.windowQuestions}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(undefined);
      }, WINDOW_ANSWER_TIMEOUT_MS);
      const off = once(reply, (_event, answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      ask(reply);
    });
  }

  queueOutput(ref: ProjectRef, tabId: string, data: string): void {
    const key = `${refKeyOf(ref)}\u0000${tabId}`;
    const pending = this.pendingOutput.get(key);
    if (pending) {
      pending.data += data;
    } else {
      this.pendingOutput.set(key, { ref, tabId, data });
    }
    // Counted once queued, not once sent: a backlog held here must pause the process too.
    this.sent(ref, tabId, data.length);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => this.flushOutput(false), this.inBackground() ? BACKGROUND_OUTPUT_FLUSH_MS : OUTPUT_FLUSH_MS);
  }

  /**
   * The terminal parsed `length` characters of the tab's output. Below the low-water mark a paused
   * process runs again; a process is never left paused without an ack due: see `OUTPUT_PAUSE_LIMIT_MS`.
   */
  ackOutput(ref: ProjectRef, tabId: string, length: number): void {
    const key = flowKey(ref, tabId);
    const flow = this.inFlight.get(key);
    if (!flow) {
      return;
    }
    flow.chars = Math.max(0, flow.chars - length);
    if (flow.chars < OUTPUT_LOW_WATER) {
      flow.gaveUp = false;
    }
    if (flow.paused && flow.chars < OUTPUT_LOW_WATER) {
      this.resumeFlow(flow);
    } else if (flow.paused) {
      this.armPauseLimit(key, flow);
    }
    if (flow.chars === 0 && !flow.paused) {
      this.inFlight.delete(key);
    }
  }

  private armPauseLimit(key: string, flow: FlowState): void {
    clearTimeout(flow.limit);
    flow.limit = setTimeout(() => this.giveUp(flow), OUTPUT_PAUSE_LIMIT_MS);
  }

  /** Runs the process again without an ack due, and pauses it no more until the acks still owed
   *  bring it below the low-water mark: counting on keeps late acks from crediting later output. */
  private giveUp(flow: FlowState): void {
    flow.gaveUp = true;
    this.resumeFlow(flow);
  }

  /** Ends every pause while the window is out of sight: Chromium throttles its timers then, so
   *  xterm would ack slowly and hold background processes back. */
  private releasePaused(): void {
    for (const flow of this.inFlight.values()) {
      if (flow.paused) {
        this.giveUp(flow);
      }
    }
  }

  private resumeFlow(flow: FlowState): void {
    clearTimeout(flow.limit);
    flow.limit = undefined;
    if (flow.paused) {
      flow.paused = false;
      this.deps.setOutputPaused(flow.ref, flow.tabId, false);
    }
  }

  /** Owes nothing more and runs the process again if paused: the acks are not coming. */
  private forgetFlow(key: string, flow: FlowState): void {
    this.resumeFlow(flow);
    flow.chars = 0;
    if (this.inFlight.get(key) === flow) {
      this.inFlight.delete(key);
    }
  }

  /** Counts what is sent and pauses the tab's process above the high-water mark. */
  private sent(ref: ProjectRef, tabId: string, length: number): void {
    const key = flowKey(ref, tabId);
    let flow = this.inFlight.get(key);
    if (!flow) {
      flow = { ref, tabId, chars: 0, paused: false, gaveUp: false, limit: undefined };
      this.inFlight.set(key, flow);
    }
    flow.chars += length;
    if (flow.chars > OUTPUT_HIGH_WATER && !flow.paused && !flow.gaveUp && !this.outOfSight()) {
      flow.paused = true;
      this.deps.setOutputPaused(ref, tabId, true);
      this.armPauseLimit(key, flow);
    }
  }

  /** Every pause ends, and nothing is owed: the page that would have acked is gone. */
  private resetFlow(): void {
    for (const [key, flow] of [...this.inFlight]) {
      this.forgetFlow(key, flow);
    }
  }

  /**
   * One message for all tabs: see TerminalOutput. Output whose tab closed while it was batched is
   * dropped here: the renderer has disposed that view by now, and a late batch would look to it
   * like output for a tab not yet attached (terminal-views.ts's earlyOutput). Called early by a
   * status change, which must not overtake the output before it. Handing over everything (`all`) is
   * the default; the timer hands over at most MAX_FLUSH_CHARS per tab and keeps the rest.
   */
  flushOutput(all = true): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = undefined;
    const live: TerminalOutput[] = [];
    for (const [key, pending] of [...this.pendingOutput]) {
      if (!this.deps.hasTab(pending.ref, pending.tabId)) {
        this.pendingOutput.delete(key);
        const flowId = flowKey(pending.ref, pending.tabId);
        const flow = this.inFlight.get(flowId);
        if (flow) {
          this.forgetFlow(flowId, flow);
        }
        continue;
      }
      // Out of sight nothing is paused, so nothing is held back either: the backlog would only grow.
      if (all || pending.data.length <= MAX_FLUSH_CHARS || this.outOfSight()) {
        this.pendingOutput.delete(key);
        live.push(pending);
      } else {
        live.push({ ref: pending.ref, tabId: pending.tabId, data: pending.data.slice(0, MAX_FLUSH_CHARS) });
        pending.data = pending.data.slice(MAX_FLUSH_CHARS);
      }
    }
    if (live.length > 0) {
      this.send("tabs:output", live);
    }
    if (this.pendingOutput.size > 0) {
      this.scheduleFlush();
    }
  }

  /**
   * A notification disappears; this lasts until the window is focused (the `focus` handler): taskbar
   * flash on Windows, dock bounce on macOS, urgency hint on Linux. No badge count: only macOS has one
   * everywhere.
   */
  attractAttention = (): void => {
    if (this.inBackground()) {
      this.window?.flashFrame(true);
    }
  };

  reveal = (): void => {
    const window = this.liveWindow();
    if (!window) {
      return;
    }
    if (PLATFORM.foregroundLock) {
      // Minimized, restored and held on top while it takes the focus: focus() alone would only flash
      // the taskbar button.
      window.minimize();
      window.restore();
      window.setAlwaysOnTop(true);
      window.focus();
      window.setAlwaysOnTop(false);
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  };

  /** The theme on screen, undefined while no window stands. */
  shownTheme(): ThemeDefinition | undefined {
    return this.liveWindow() ? this.theme : undefined;
  }

  /** Puts `theme` on screen live; within one `kind` only, which the caller keeps to. */
  showTheme(theme: ThemeDefinition): void {
    const window = this.liveWindow();
    if (!window || theme.id === this.theme?.id) {
      return;
    }
    this.theme = theme;
    window.setBackgroundColor(theme.windowBackground);
    if (PLATFORM.titleBarOverlay) {
      window.setTitleBarOverlay({ color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor });
    }
    this.send("app:theme", theme.id);
  }

  showBackgroundGradient(on: boolean): void {
    this.backgroundGradient = on;
    this.send("app:background-gradient", on);
  }

  /** Per window: a theme the running window could not take (showTheme) reaches later windows. */
  create(theme: ThemeDefinition, backgroundGradient: boolean): void {
    this.theme = theme;
    this.backgroundGradient = backgroundGradient;
    const window = new BrowserWindow({
      // The last session's size, position and maximized state, kept in Electron's own profile; the
      // size below is only the first start's.
      name: "main",
      windowStatePersistence: true,
      width: 1400,
      height: 900,
      // The areas' floors summed (--area-min-width twice, --content-min-width, the stacked sections,
      // title and branch bars); below this something clips.
      minWidth: 800,
      minHeight: 340,
      // Painted before the first frame in the title bar's color, since the window controls overlay
      // shows at once. Equals --tet-app-background.
      backgroundColor: theme.windowBackground,
      show: false,
      // Windows takes the .ico (generated from icon.png), Linux a plain image; macOS reads the app
      // bundle.
      icon: path.join(__dirname, PLATFORM.windowIcon),
      // Our own title bar; the platform's window controls stay via the overlay.
      titleBarStyle: PLATFORM.titleBarOverlay ? "hidden" : "hiddenInset",
      titleBarOverlay:
        // Height must match the renderer's .titlebar rule, or controls and drag region disagree.
        PLATFORM.titleBarOverlay ? { color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor, height: 40 } : undefined,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // The preload reads the theme off process.argv synchronously, so the first frame is right;
        // an IPC round trip would paint it in the defaults.
        additionalArguments: [
          `${WINDOW_ARGS.theme}${theme.id}`,
          ...(isWaylandSession() ? [WINDOW_ARGS.wayland] : []),
          ...(backgroundGradient ? [WINDOW_ARGS.backgroundGradient] : []),
        ],
      },
    });
    this.window = window;

    // Every load, reloads included, has no listener until App subscribes.
    window.webContents.on("did-start-loading", () => {
      this.noticesHeard = false;
      this.resetFlow();
      this.deps.onPageLoad();
    });
    // A reload reads the theme off the window's original arguments, possibly stale since showTheme.
    // The renderer ignores its own theme id.
    window.webContents.on("did-finish-load", () => {
      if (this.theme) {
        this.send("app:theme", this.theme.id);
      }
      this.send("app:background-gradient", this.backgroundGradient);
    });
    // Shown once the page reports what the user waits for (`app:drawn`), so neither an empty window
    // nor a half-built workspace shows first; the timer shows it anyway if the page never reports.
    if (!this.deps.hidden) {
      const showTimer = setTimeout(() => this.showOnce(window), SHOW_FALLBACK_MS);
      window.once("closed", () => clearTimeout(showTimer));
    }
    // Ends attractAttention's flash.
    window.on("focus", () => window.flashFrame(false));
    const foregrounded = (): void => {
      for (const listener of this.foregroundListeners) {
        listener();
      }
    };
    window.on("focus", foregrounded);
    window.on("show", foregrounded);
    window.on("restore", foregrounded);
    window.on("minimize", () => this.releasePaused());
    window.on("hide", () => this.releasePaused());
    window.on("closed", () => {
      this.resetFlow();
      if (this.window === window) {
        this.window = undefined;
      }
      clearTimeout(this.rendererRebuildTimer);
      this.rendererRebuildTimer = undefined;
    });

    window.webContents.on("render-process-gone", (_event, details) => {
      // `clean-exit` is a window on its way out, not a fault.
      if (details.reason === "clean-exit" || window.isDestroyed()) {
        return;
      }
      logError(`renderer gone (${details.reason}); rebuilding the window`);
      // Every pty lives in this process and keeps running, so reloading brings the sessions back;
      // only the renderer-held scrollback is lost. Rate-limited, or a renderer failing on load
      // would reload forever — but held back, not dropped: a dead page has no way to reload itself,
      // and closing the window would end every session.
      const rebuild = (): void => {
        this.rendererRebuildTimer = undefined;
        if (window.isDestroyed()) {
          return;
        }
        this.rendererRebuiltAt = Date.now();
        // Only once the new renderer has loaded; earlier sends reach the dead process.
        window.webContents.once("did-finish-load", () =>
          this.notice(
            "warning",
            "The window stopped responding and was loaded again. Your sessions kept running; what they printed before is gone.",
          ),
        );
        window.webContents.reload();
      };
      const wait = this.rendererRebuiltAt + RENDERER_REBUILD_GAP_MS - Date.now();
      if (wait <= 0) {
        rebuild();
      } else {
        this.rendererRebuildTimer ??= setTimeout(rebuild, wait);
      }
    });

    // No application menu (the title bar is our own), so wire the devtools shortcuts by hand.
    window.webContents.on("before-input-event", (_event, input) => {
      const toggle = input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i");
      if (input.type === "keyDown" && toggle) {
        window.webContents.toggleDevTools();
      }
    });

    // Nothing in the page takes the window away from TET or opens another: a link or form in a
    // Markdown preview, a stray drop. A new window is what monaco's ctrl-clicked link asks for, so
    // its web and mail links reach the browser as `shell:open-url`'s do; nothing else leaves. A
    // navigation to `about:blank` reaches neither event, so only the page's own script could blank
    // the window, and there is none but TET's.
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isOpenableUrl(url)) {
        shell.openExternal(url).catch((error: unknown) => logError(`could not open ${url}`, error));
      }
      return { action: "deny" };
    });

    void window.loadFile(path.join(__dirname, "index.html"));
  }
}

/**
 * Whether Chromium draws through Wayland; the renderer then keeps terminals off WebGL
 * (terminal-views.ts). An explicit x11 wins; else any Wayland sign counts, as Electron picks it.
 */
function isWaylandSession(): boolean {
  if (!PLATFORM.checksGpu) {
    return false;
  }
  const ozonePlatform = app.commandLine.getSwitchValue("ozone-platform").toLowerCase();
  const ozoneHint = (process.env.ELECTRON_OZONE_PLATFORM_HINT ?? "").toLowerCase();
  if (ozonePlatform === "x11" || (ozonePlatform === "" && ozoneHint === "x11")) {
    return false;
  }
  return (
    Boolean(process.env.WAYLAND_DISPLAY) ||
    process.env.XDG_SESSION_TYPE === "wayland" ||
    ozoneHint === "wayland" ||
    ozonePlatform === "wayland"
  );
}
