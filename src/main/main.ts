import * as path from "node:path";
import { app, BrowserWindow, Menu } from "electron";
import { prepareAgents } from "../agents";
import { AccountStore } from "../providers/accounts";
import type { Project, TerminalOutput, TerminalStatus } from "../shared/types";
import { startAutoUpdate } from "./auto-update";
import { countActivity, startEventLoopMonitor } from "./event-loop-monitor";
import { startGitProcess, stopGitProcess } from "./git-client";
import { registerIpc, sweepTempFiles } from "./ipc";
import { ProjectStore } from "./projects";
import { RepositoryManager } from "./repository";
import { SessionManagerRegistry } from "./session-manager";
import { SettingsStore } from "./settings";
import { currentTheme } from "./theme";

/** Terminal output arrives in many small chunks; one IPC message per chunk is wasteful. */
const OUTPUT_FLUSH_MS = 8;

let window: BrowserWindow | undefined;

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

const pendingOutput = new Map<string, TerminalOutput>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** All of it in one message: see TerminalOutput for why it is not one per tab. */
function flushOutput(): void {
  flushTimer = undefined;
  if (pendingOutput.size > 0) {
    send("terminal:output", [...pendingOutput.values()]);
    pendingOutput.clear();
  }
}

function queueOutput(projectId: string, tabId: string, data: string): void {
  countActivity("output");
  const key = `${projectId}\u0000${tabId}`;
  const pending = pendingOutput.get(key);
  if (pending) {
    pending.data += data;
  } else {
    pendingOutput.set(key, { projectId, tabId, data });
  }
  flushTimer ??= setTimeout(flushOutput, OUTPUT_FLUSH_MS);
}

const store = new ProjectStore(app.getPath("userData"));
const settings = new SettingsStore(app.getPath("userData"));
const accounts = new AccountStore(app.getPath("userData"));
const repositories = new RepositoryManager(
  (projectId, state) => send("repo:state-changed", { projectId, state }),
  (severity, message) => send("app:notice", { severity, message }),
  (projectId) => send("commands:changed", { projectId })
);
const sessions = new SessionManagerRegistry(app.getPath("userData"), settings, {
  onTabs: (projectId, tabs) => send("terminal:tabs", { projectId, tabs }),
  onOutput: queueOutput,
  onStatus: (projectId, tabId, status: TerminalStatus) => send("terminal:status", { projectId, tabId, status }),
  onStartupProgress: (projectId, show) => send("terminal:startup-progress", { projectId, show }),
  onNotice: (severity, message) => send("app:notice", { severity, message })
});

function openProject(project: Project): void {
  repositories.open(project);
  sessions.open(project);
}

let workspaceOpen = false;

/**
 * The stored projects, brought up once. Not at startup: the renderer's requirements check
 * calls this, and only when it passed — without git or an agent there is nothing a restored
 * repository or terminal could do. Idempotent, since the check runs again on every window and
 * after every re-check the user asks for.
 */
function openWorkspace(): void {
  if (workspaceOpen) {
    return;
  }
  workspaceOpen = true;
  for (const project of store.list()) {
    openProject(project);
  }
}

function createWindow(): void {
  // Read here, per window: a theme picked in the settings dialog reaches the windows opened
  // after it, the same as every other setting — the ones already up keep what they were built
  // with (xterm, shiki and monaco each bake their colors in once).
  const theme = currentTheme(settings);
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    // Where the panes' own floors add up to: the sidebar, the git pane and the terminals
    // side by side (--pane-min-width twice and --content-min-width), and two stacked
    // sections plus the title and branch bars. Below this the renderer would have to start
    // clipping something, so the window is what refuses instead.
    minWidth: 700,
    minHeight: 340,
    // What the window is painted with before the renderer has drawn anything, so it is the
    // title bar's own color rather than the editor's: the window controls are an overlay the
    // platform draws right away, in the color below, and against #1f1f1f they stood in a
    // patch of their own for the moment before the first frame. --vscode-titleBar-
    // activeBackground and --vscode-sideBar-background are both this, which is most of the
    // window; the editor background arrives with the frame that paints it.
    backgroundColor: theme.windowBackground,
    show: false,
    // What the taskbar and the window itself show. Windows takes the .ico, whose frames are
    // each rendered at the size they are drawn at rather than resampled from one large image
    // on the spot, which is what made the mark look soft beside every other icon down there.
    // Linux wants a plain image, and macOS ignores this outright — its dock reads the app
    // bundle. Both files are the same drawing; icon.ico is generated from icon.png.
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
    // The project tabs live in the title bar, as in the reference views; the platform's
    // own window controls stay in place through the overlay.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      // Height must match the .titlebar rule in the renderer, or the window controls and
      // the drag region disagree about where the title bar ends.
      process.platform === "darwin"
        ? undefined
        : { color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor, height: 35 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // How the renderer learns the theme before its first paint: the preload reads this off
      // process.argv synchronously (see preload.ts), where an IPC round trip would have left
      // the first frame in the default colors.
      additionalArguments: [`--tet-theme=${theme.id}`]
    }
  });

  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = undefined;
  });

  // No application menu (the title bar is our own), so wire the devtools shortcuts by hand.
  window.webContents.on("before-input-event", (_event, input) => {
    const toggle =
      input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (input.type === "keyDown" && toggle) {
      window?.webContents.toggleDevTools();
    }
  });

  void window.loadFile(path.join(__dirname, "index.html"));
}

/**
 * One instance, because there is one of everything it keeps: projects and accounts are
 * rewritten whole from memory, so a second window saving after the first would drop what the
 * first had added; the agents' sessions are listed, adopted and deleted in the same
 * directories by both; and the two would run git in one repository without either knowing,
 * which `Repository.runAction` only prevents within a process.
 *
 * The second start therefore hands over and leaves. Asked before anything is opened — the lock
 * is the app's, not the window's, and Electron only tells the first instance about the others.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Somebody started it again, which is a request to look at it: bring what is already there
  // to the front rather than doing nothing at all.
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    startEventLoopMonitor(path.join(app.getPath("userData"), "event-loop.log"));
    // Up front rather than on the first repository: forking it costs a moment, and every
    // project that opens below is about to ask it something.
    startGitProcess();
    // Before a project opens, since opening one is what asks an agent for its sessions: what
    // a run that was killed left running is taken down here. See AgentDefinition.prepareApp.
    prepareAgents(app.getPath("userData"));
    sweepTempFiles();
    registerIpc({ store, settings, accounts, repositories, sessions, send, openProject, openWorkspace });
    createWindow();
    startAutoUpdate((severity, message, progress) => send("app:notice", { severity, message, progress }));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

/**
 * Ending the sessions is asynchronous now — each agent is given a moment to quit by itself
 * (see TerminalSession.stop) — and electron tears the process down the moment a synchronous
 * before-quit handler returns, so the quit has to be held back and asked for again afterwards.
 * `quitting` is what keeps that second ask from being held back in turn, which would leave the
 * app unable to quit at all. Bounded so a pty that never reports its exit can't do the same.
 */
const QUIT_TEARDOWN_TIMEOUT_MS = 5000;

let quitting = false;

app.on("before-quit", (event) => {
  if (quitting) {
    return;
  }
  quitting = true;
  event.preventDefault();
  void Promise.race([
    sessions.disposeAll(),
    new Promise((resolve) => setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS))
  ]).finally(() => {
    repositories.disposeAll();
    stopGitProcess();
    app.quit();
  });
});
