import * as path from "node:path";
import { app, BaseWindow, shell, WebContentsView } from "electron";
import { WINDOW_ARGS } from "../shared/api";
import type { EventChannels, WindowReply } from "../shared/ipc";
import type { ThemeDefinition } from "../shared/themes";
import type { LaneSettings } from "../shared/types/settings";
import { refKeyOf } from "../shared/types/project";
import type { Notice, NoticeProgress, NoticeSeverity } from "../shared/types/app";
import type { ProjectRef } from "../shared/types/project";
import type { TerminalOutput } from "../shared/types/terminals";
import { on, once } from "./ipc/channels";
import { isDevToolsKey } from "./util/devtools-key";
import { logError } from "./util/error-log";
import { PLATFORM } from "./util/host-platform";
import { isOpenableUrl } from "./util/shell-open";

/** Output arrives in small chunks; batch them rather than one IPC message each. */
const OUTPUT_FLUSH_MS = 8;
/** Minimum gap between two renderer-crash rebuilds. */
const RENDERER_REBUILD_GAP_MS = 60_000;
/** A question's wait for the window: one in its requirements check or reloading never answers. */
const WINDOW_ANSWER_TIMEOUT_MS = 2000;

export interface AppWindowDeps {
  /** For tests run locally (test/helpers/): the window is drawn but never shown. */
  hidden: boolean;
  /** Whether the tab is still open: output batched for one closed meanwhile is dropped. */
  hasTab(ref: ProjectRef, tabId: string): boolean;
  /** A page load began, reloads included: what the page showed is gone with it. */
  onPageLoad(): void;
  /** The window closed, and the browser tabs' pages drawn into it with it. */
  onClosed(): void;
}

/**
 * The window and everything that talks to it: what main sends it, the notices held until it
 * listens, the terminals' batched output, its theme, and asking it for an editor's text. One
 * window at a time; before it exists and after it closed, what is sent to it is dropped.
 *
 * The window draws nothing itself: TET's own page is a view filling it (`page`), transparent where
 * it paints nothing, and the browser tabs' pages are views of their own beside it
 * (browser/browser-tabs.ts), always above TET's page. Where something of TET's page must lie over
 * one — a dialog, a menu — the page is hidden and a still of it shown in its place (BrowserHost).
 */
export class AppWindow {
  private window: BaseWindow | undefined;
  /** TET's own page, filling the window. */
  private page: WebContentsView | undefined;
  private rendererRebuiltAt = 0;
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
  /** The theme on screen: the window's initial one or the last `showTheme` took. */
  private theme: ThemeDefinition | undefined;

  constructor(private readonly deps: AppWindowDeps) {
    on("app:notice-listening", () => {
      this.noticesHeard = true;
      for (const notice of this.heldNotices.splice(0)) {
        this.send("app:notice", notice);
      }
    });
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
    if (this.page && !this.page.webContents.isDestroyed()) {
      this.page.webContents.send(channel, payload);
    }
  };

  /** Everything the user is told from this process (Notices.tsx), held as `send` holds it. */
  notice = (severity: NoticeSeverity, message: string): void => {
    this.send("app:notice", { severity, message });
  };

  noticeProgress = (progress: NoticeProgress): void => {
    this.send("app:notice-progress", progress);
  };

  /** Whether the page listens and a question can show now. */
  listening(): boolean {
    return this.noticesHeard && this.window !== undefined && !this.window.isDestroyed();
  }

  /** Out of the user's sight: unfocused, or minimized — a win32 window minimized by its button
   *  still reports `isFocused`. */
  inBackground(): boolean {
    return this.window !== undefined && !this.window.isDestroyed() && (!this.window.isFocused() || this.window.isMinimized());
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
    if (!this.window || this.window.isDestroyed()) {
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
    this.flushTimer ??= setTimeout(() => this.flushOutput(), OUTPUT_FLUSH_MS);
  }

  /**
   * One message for all tabs: see TerminalOutput. Output whose tab closed while it was batched is
   * dropped here: the renderer has disposed that view by now, and a late batch would look to it
   * like output for a tab not yet attached (terminal-views.ts's earlyOutput). Called early by a
   * status change, which must not overtake the output before it.
   */
  flushOutput(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = undefined;
    const live = [...this.pendingOutput.values()].filter((pending) => this.deps.hasTab(pending.ref, pending.tabId));
    this.pendingOutput.clear();
    if (live.length > 0) {
      this.send("tabs:output", live);
    }
  }

  /**
   * A notification disappears; this lasts until the window is focused (the `focus` handler): taskbar flash
   * on Windows, dock bounce on macOS, urgency hint on Linux. No badge count: only macOS has one
   * everywhere.
   */
  attractAttention = (): void => {
    if (this.inBackground()) {
      this.window?.flashFrame(true);
    }
  };

  reveal = (): void => {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.focus();
  };

  /** The theme on screen, undefined while no window stands. */
  shownTheme(): ThemeDefinition | undefined {
    return this.window && !this.window.isDestroyed() ? this.theme : undefined;
  }

  /** Puts `theme` on screen live; within one `kind` only, which the caller keeps to. */
  showTheme(theme: ThemeDefinition): void {
    if (!this.window || this.window.isDestroyed() || theme.id === this.theme?.id) {
      return;
    }
    this.theme = theme;
    this.window.setBackgroundColor(theme.windowBackground);
    if (PLATFORM.titleBarOverlay) {
      this.window.setTitleBarOverlay({ color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor });
    }
    this.send("app:theme", theme.id);
  }

  /** A browser tab's page, drawn above TET's own where its tab lies (browser/browser-tabs.ts);
   *  dropped when no window stands. */
  addView = (view: WebContentsView): void => {
    if (this.window && !this.window.isDestroyed()) {
      this.window.contentView.addChildView(view);
    }
  };

  removeView = (view: WebContentsView): void => {
    if (this.window && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(view);
    }
  };

  focusPage = (): void => {
    if (this.page && !this.page.webContents.isDestroyed()) {
      this.page.webContents.focus();
    }
  };

  /** Hands the window the lanes as stored; a window still loading reads them at its start. */
  showLanes(lanes: LaneSettings): void {
    this.send("app:lanes", lanes);
  }

  /** Per window: a theme the running window could not take (showTheme) reaches later windows. */
  create(theme: ThemeDefinition): void {
    this.theme = theme;
    const window = new BaseWindow({
      width: 1400,
      height: 900,
      // The areas' floors summed (--area-min-width twice, --content-min-width, the stacked sections,
      // title and branch bars); below this something clips.
      minWidth: 800,
      minHeight: 340,
      // Painted before the first frame in the title bar's color, since the window controls overlay
      // shows at once. Equals --tet-titleBar-activeBackground and --tet-sideBar-background.
      backgroundColor: theme.windowBackground,
      show: false,
      // Windows takes the .ico (generated from icon.png): per-size frames stay sharp in the taskbar,
      // where a resampled image looks soft. Linux wants a plain image; macOS reads the app bundle.
      icon: path.join(__dirname, PLATFORM.windowIcon),
      // Our own title bar; the platform's window controls stay via the overlay.
      titleBarStyle: PLATFORM.titleBarOverlay ? "hidden" : "hiddenInset",
      titleBarOverlay:
        // Height must match the renderer's .titlebar rule, or controls and drag region disagree.
        PLATFORM.titleBarOverlay ? { color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor, height: 35 } : undefined,
    });
    const page = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // The preload reads the theme off process.argv synchronously, so the first frame is right;
        // an IPC round trip would paint it in the defaults.
        additionalArguments: [`${WINDOW_ARGS.theme}${theme.id}`, ...(isWaylandSession() ? [WINDOW_ARGS.wayland] : [])],
      },
    });
    // Transparent where the page paints nothing: before its first frame, the window's theme color.
    page.setBackgroundColor("#00000000");
    window.contentView.addChildView(page, 0);
    const fill = (): void => {
      const { width, height } = window.contentView.getBounds();
      page.setBounds({ x: 0, y: 0, width, height });
    };
    fill();
    window.contentView.on("bounds-changed", fill);
    this.window = window;
    this.page = page;

    // Every load, reloads included, has no listener until App subscribes.
    page.webContents.on("did-start-loading", () => {
      this.noticesHeard = false;
      this.deps.onPageLoad();
    });
    // A reload reads the theme off the window's original arguments, possibly stale since showTheme.
    // The renderer ignores its own theme id.
    page.webContents.on("did-finish-load", () => {
      if (this.theme) {
        this.send("app:theme", this.theme.id);
      }
    });
    // Shown once the page has drawn, so no empty window shows first.
    if (!this.deps.hidden) {
      page.webContents.once("did-finish-load", () => {
        window.show();
        page.webContents.focus();
      });
    }
    // Ends attractAttention's flash.
    window.on("focus", () => window.flashFrame(false));
    window.on("closed", () => {
      if (this.window === window) {
        this.window = undefined;
        this.page = undefined;
      }
      // A view's page outlives its window unless closed.
      page.webContents.close();
      this.deps.onClosed();
    });

    page.webContents.on("render-process-gone", (_event, details) => {
      // `clean-exit` is a window on its way out, not a fault.
      if (details.reason === "clean-exit" || window.isDestroyed()) {
        return;
      }
      logError(`renderer gone (${details.reason}); rebuilding the window`);
      // Every pty lives in this process and keeps running, so reloading brings the sessions back;
      // only the renderer-held scrollback is lost. Rate-limited, or a renderer failing on load
      // would reload forever.
      const now = Date.now();
      if (now - this.rendererRebuiltAt < RENDERER_REBUILD_GAP_MS) {
        return;
      }
      this.rendererRebuiltAt = now;
      // Only once the new renderer has loaded; earlier sends reach the dead process.
      page.webContents.once("did-finish-load", () =>
        this.notice(
          "warning",
          "The window stopped responding and was loaded again. Your sessions kept running; what they printed before is gone.",
        ),
      );
      page.webContents.reload();
    });

    // No application menu (the title bar is our own), so wire the devtools shortcuts by hand.
    page.webContents.on("before-input-event", (_event, input) => {
      if (isDevToolsKey(input)) {
        page.webContents.toggleDevTools();
      }
    });

    // Nothing in the page takes the window away from TET or opens another: a link or form in a
    // Markdown preview, a stray drop. A new window is what monaco's ctrl-clicked link asks for, so
    // its web and mail links reach the browser as `shell:open-url`'s do; nothing else leaves. A
    // navigation to `about:blank` reaches neither event, so only the page's own script could blank
    // the window, and there is none but TET's.
    page.webContents.on("will-navigate", (event) => event.preventDefault());
    page.webContents.setWindowOpenHandler(({ url }) => {
      if (isOpenableUrl(url)) {
        shell.openExternal(url).catch((error: unknown) => logError(`could not open ${url}`, error));
      }
      return { action: "deny" };
    });

    void page.webContents.loadFile(path.join(__dirname, "index.html"));
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
