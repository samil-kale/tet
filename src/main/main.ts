import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, Menu, Notification } from "electron";
import { AGENTS } from "./agents";
import { AccountStore } from "./providers/accounts";
import { CONTROL_ENV } from "../shared/control";
import { RELEASES_URL } from "../shared/release";
import { resolveTheme, themeKey, type ThemeDefinition } from "../shared/themes";
import type { Project, TerminalOutput, TerminalStatus } from "../shared/types";
import { installPendingUpdate, startAutoUpdate } from "./auto-update";
import { readCommands } from "./git/commands";
import { writeLaunchers } from "./control/control-launcher";
import { ControlRecords } from "./control/control-records";
import { findControlPort, startControlServer } from "./control/control-server";
import type { ToastTarget } from "./control/control-server";
import { countActivity, markStartup, startEventLoopMonitor, timeStartup } from "./event-loop-monitor";
import { startGitProcess, stopGitProcess } from "./git/git-client";
import { registerIpc, sweepTempFiles } from "./ipc";
import { addProject, ProjectStore, removeProject } from "./projects";
import { configureSandboxes } from "./sbx";
import { resolveDataRoot } from "./data-root";
import { augmentAgentPath } from "./terminals/agent-path";
import { setControlEnv } from "./terminals/pty";
import { installUncaughtHandler, logError } from "./uncaught";
import { isAgentInstalled } from "./terminals/terminal-session";
import { RepositoryManager } from "./git/repository";
import { SessionManagerRegistry } from "./terminals/session-manager";
import { SettingsStore } from "./settings";
import { currentTheme } from "./theme";

/** Output arrives in small chunks; batch them rather than one IPC message each. */
const OUTPUT_FLUSH_MS = 8;

let window: BrowserWindow | undefined;

/** Minimum gap between two renderer-crash rebuilds. */
const RENDERER_REBUILD_GAP_MS = 60_000;
let rendererRebuiltAt = 0;

/**
 * Notices sent before the window listens are held: `App` subscribes only after the requirements
 * check, and a fast sender (the update's "Updated to") would otherwise be lost. The renderer
 * reports listening via `app:notice-listening` (preload's `onNotice`); every page load resets it.
 */
let noticesHeard = false;
const heldNotices: unknown[] = [];

function send(channel: string, payload: unknown): void {
  if (channel === "app:notice" && !noticesHeard) {
    heldNotices.push(payload);
    return;
  }
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

ipcMain.on("app:notice-listening", () => {
  noticesHeard = true;
  for (const notice of heldNotices.splice(0)) {
    send("app:notice", notice);
  }
});

/** `editor-state`'s wait for the window: one in its requirements check or reloading never answers. */
const EDITOR_CONTENT_TIMEOUT_MS = 2000;
let editorContentRequests = 0;

/** A project's editor tab text (ControlDeps.editorContent), on a per-request reply channel. */
function editorContent(projectId: string): Promise<string | undefined> {
  if (!window || window.isDestroyed()) {
    return Promise.resolve(undefined);
  }
  editorContentRequests += 1;
  const reply = `editor:content:${editorContentRequests}`;
  return new Promise((resolve) => {
    const answer = (_event: Electron.IpcMainEvent, content: string | undefined): void => {
      clearTimeout(timer);
      resolve(content);
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener(reply, answer);
      resolve(undefined);
    }, EDITOR_CONTENT_TIMEOUT_MS);
    ipcMain.once(reply, answer);
    send("editor:content-request", { projectId, reply });
  });
}

const pendingOutput = new Map<string, TerminalOutput>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** One message for all tabs: see TerminalOutput. */
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

/**
 * A separate profile for tests driving the real app via tet-ctl (test/app.test.ts): own projects,
 * settings and socket, and — the lock being per profile — a second tet beside the working one.
 * Both Chromium's profile and tet's data folder (data-root.ts), set before either is asked for.
 * Only then is the control token taken from the environment.
 */
const USER_DATA_ARG = "--user-data-dir=";
const userDataArg = process.argv.find((arg) => arg.startsWith(USER_DATA_ARG))?.slice(USER_DATA_ARG.length);
/** Only such a run answers ControlVerb.ownProfileOnly verbs. */
const ownProfile = Boolean(userDataArg);
if (userDataArg) {
  app.setPath("userData", path.resolve(userDataArg));
}
/** tet's own data; `userData` is left to Chromium's profile. */
const dataRoot = resolveDataRoot(userDataArg);
try {
  fs.mkdirSync(dataRoot, { recursive: true });
} catch (error) {
  console.error("[tet] could not create the data folder:", error);
}

/**
 * Who Windows says a toast is from: name and icon come from the Start menu entry carrying this id,
 * never from the notification (so no toast icon). Electron writes that entry on the first toast
 * (windows_toast_activator.cc), named after the executable's ProductName, with the id and the
 * activator CLSID. Installed, the executable is `TET.exe` (electron-builder.yml), so the entry is
 * install.ps1's `TET.lnk` rewritten in place; a development run's electron.exe reads "Electron".
 *
 * Windows remembers what it decided about an id, so `npm start` gets its own id — else one dev
 * toast leaves the installed tet reading "Electron". The CLSID is fixed, not Electron's per-run
 * random one, so a toast clicked after tet quit starts the COM server the entry names. Both are set
 * before the workspace: a hook can report a turn once the first terminal is up. The id is the old
 * installers' `appId`, kept so Windows' existing decisions about it stay.
 */
const APP_USER_MODEL_ID = "com.samilkale.tet";
const TOAST_ACTIVATOR_CLSID = "{8DA9BB54-C0A5-4BEC-AF76-BE3568344852}";
const installed = app.isPackaged;
if (process.platform === "win32") {
  app.setAppUserModelId(installed ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.dev`);
  if (installed) {
    app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
  }
}

// Every visible terminal plus the warm hidden ones (webgl-pool.ts) holds a WebGL context. Past 16
// per renderer Blink silently evicts the oldest to the DOM renderer; 128 leaves room, a leak shows.
app.commandLine.appendSwitch("max-active-webgl-contexts", "128");

/**
 * Whether Chromium draws through Wayland; the renderer then keeps terminals off WebGL
 * (terminal-views.ts). An explicit x11 wins; else any Wayland sign counts, as Electron picks it.
 */
function isWaylandSession(): boolean {
  if (process.platform !== "linux") {
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

/**
 * GitHub's releases, except for the install test (test/install.test.ts) serving its own — read from
 * the environment only with a profile of its own, like the control token.
 */
const releasesUrl = (userDataArg && process.env.TET_RELEASES_URL) || RELEASES_URL;

// Before anything that could throw asynchronously, so an uncaught exception becomes a notice rather
// than Electron's modal dialog freezing every terminal (uncaught.ts).
installUncaughtHandler(path.join(dataRoot, "errors.log"), (severity, message) =>
  send("app:notice", { severity, message })
);

const store = new ProjectStore(dataRoot);
const settings = new SettingsStore(dataRoot);
const accounts = new AccountStore(dataRoot);
/** What control verbs answer beyond the stores; terminal output only with a profile of its own. */
const records = new ControlRecords(ownProfile);
const repositories = new RepositoryManager(
  (projectId, state) => send("repo:state-changed", { projectId, state }),
  (severity, message) => send("app:notice", { severity, message }),
  (projectId) => {
    send("commands:changed", { projectId });
    // tet.json also holds the sbx switch, which sbx-only agents must hear (sbxConfigChanged).
    void sessions
      .get(projectId)
      ?.sbxConfigChanged()
      .catch((error: unknown) => console.error("[tet] could not apply the sbx config change:", error));
  },
  (projectId) => send("repo:files-changed", { projectId }),
  (projectId, path) => send("repo:file-changed", { projectId, path })
);
const sessions = new SessionManagerRegistry(dataRoot, settings, {
  onTabs: (projectId, tabs) => {
    send("terminal:tabs", { projectId, tabs });
    awaitedToastTab(projectId);
  },
  onOutput: (projectId, tabId, data) => {
    records.addOutput(projectId, tabId, data);
    queueOutput(projectId, tabId, data);
  },
  onStatus: (projectId, tabId, status: TerminalStatus) => send("terminal:status", { projectId, tabId, status }),
  onStartupProgress: (projectId, show) => send("terminal:startup-progress", { projectId, show }),
  onNotice: (severity, message) => send("app:notice", { severity, message })
});

function openProject(project: Project): void {
  repositories.open(project);
  sessions.open(project);
}

let workspaceOpen = false;

/** Opens the stored projects once the requirements check passes. Idempotent: the check reruns. */
function openWorkspace(): void {
  if (workspaceOpen) {
    return;
  }
  workspaceOpen = true;
  for (const project of store.list()) {
    timeStartup(`open ${project.name}`, () => openProject(project));
  }
  void markStartup("control", startControl);
}

/** Set before any terminal can spawn. */
let controlChannel: { token: string; port: number } | undefined;
let controlServer: { close: () => Promise<void> } | undefined;

/** Like notices (Notices.tsx), an identical toast within this span is dropped, without extending
 *  it. The target tab is part of the identity: two untitled tabs of one agent read the same, and
 *  dropping the second would point its click at the first's tab. */
const TOAST_REPEAT_MS = 8000;
const recentToasts = new Map<string, number>();

function repeatedToast(title: string, body: string, target?: ToastTarget): boolean {
  const now = Date.now();
  for (const [seen, at] of recentToasts) {
    if (now - at >= TOAST_REPEAT_MS) {
      recentToasts.delete(seen);
    }
  }
  const key = `${title}\u0000${body}\u0000${target?.projectId ?? ""}\u0000${target?.tabId ?? ""}`;
  if (recentToasts.has(key)) {
    return true;
  }
  recentToasts.set(key, now);
  return false;
}

/**
 * Clickable toasts, held so their click handlers are not garbage-collected — outside win32, where
 * clicks arrive through `Notification.handleActivation`. Not released on `close`: that can be the
 * move to the notification center, where a click still arrives (measured on win32). Capped.
 */
const LIVE_TOASTS_MAX = 50;
const liveToasts = new Set<Notification>();

function holdToast(toast: Notification): void {
  if (liveToasts.size >= LIVE_TOASTS_MAX) {
    // Insertion order, so this is the one held longest.
    const oldest = liveToasts.values().next().value;
    if (oldest) {
      liveToasts.delete(oldest);
    }
  }
  liveToasts.add(toast);
}

/**
 * A clicked toast's tab not yet restored (the click started tet). Looked for on each `onTabs` of
 * its project; replaced by a later click.
 */
let toastTargetAwaited: { projectId: string; tabId: string; sessionId?: string } | undefined;

/**
 * Brings a toast's tab to the front, found by tab id or by session id — the tab id of a restored
 * tab (TerminalDescriptor). Returns whether it was found.
 */
function showToastTarget(target: { projectId: string; tabId: string; sessionId?: string }): boolean {
  const tab = sessions
    .get(target.projectId)
    ?.snapshot()
    .find((candidate) => candidate.tabId === target.tabId || (target.sessionId !== undefined && candidate.tabId === target.sessionId));
  if (tab) {
    send("terminal:show", { projectId: target.projectId, tabId: tab.tabId });
  }
  return tab !== undefined;
}

/** For a toast clicked before its tab was restored. */
function awaitedToastTab(projectId: string): void {
  if (toastTargetAwaited?.projectId === projectId && showToastTarget(toastTargetAwaited)) {
    toastTargetAwaited = undefined;
  }
}

/**
 * On win32 every toast click arrives here, whether tet runs or the click started it, carrying the
 * `launch` string from `windowsToastXml` — Electron's own toast has none, so no tab would be known.
 */
if (process.platform === "win32") {
  void app.whenReady().then(() => {
    // Electron registers the COM activator only once its notification presenter exists, which the
    // first Notification or this call creates — asked at once, or a click that started tet reaches
    // no one. Installed only: the presenter also writes the Start menu entry ("Electron" in dev).
    if (installed) {
      Notification.isSupported();
    }
    Notification.handleActivation((details) => {
      revealWindow();
      const launch = new URLSearchParams(details.arguments);
      const projectId = launch.get("project");
      const tabId = launch.get("tab");
      if (!projectId || !tabId) {
        return;
      }
      const target = { projectId, tabId, sessionId: launch.get("session") || undefined };
      toastTargetAwaited = showToastTarget(target) ? undefined : target;
    });
  });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Electron's toast plus a `launch` string Windows hands back on a click. `type` and `tag` are
 * Electron's keys, so it still finds the Notification while tet runs; the session id outlives a
 * quit (showToastTarget).
 */
function windowsToastXml(id: string, title: string, body: string, target?: ToastTarget): string {
  const launch = new URLSearchParams({ type: "click", tag: id });
  if (target) {
    launch.set("project", target.projectId);
    launch.set("tab", target.tabId);
    const sessionId = sessions
      .get(target.projectId)
      ?.snapshot()
      .find((tab) => tab.tabId === target.tabId)?.sessionId;
    if (sessionId) {
      launch.set("session", sessionId);
    }
  }
  return (
    `<toast launch="${escapeXml(launch.toString())}"><visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>` +
    `</binding></visual></toast>`
  );
}

/**
 * The desktop toast behind the `hook` and `notify` verbs — this process holds the desktop session
 * (a sandboxed hook has none). No `icon`: Windows takes tet's (APP_USER_MODEL_ID).
 *
 * A click brings the window and the toast's tab to the front — on win32 via
 * `Notification.handleActivation` (also after tet quit), elsewhere via the toast's `click`.
 */
function showDesktopNotification(title: string, body: string, target?: ToastTarget): void {
  if (repeatedToast(title, body, target)) {
    return;
  }
  attractAttention();
  if (!Notification.isSupported()) {
    return;
  }
  const id = crypto.randomUUID();
  const toast = new Notification(
    process.platform === "win32" ? { id, title, body, toastXml: windowsToastXml(id, title, body, target) } : { title, body }
  );
  if (process.platform !== "win32") {
    holdToast(toast);
    toast.on("click", () => {
      liveToasts.delete(toast);
      revealWindow();
      if (target) {
        showToastTarget(target);
      }
    });
  }
  // The only trace of notifications being off in Windows' settings: "Settings prevent the
  // notification from being delivered" (measured).
  toast.on("failed", (_event, error) => {
    liveToasts.delete(toast);
    logError(`toast not delivered: ${error}`);
  });
  toast.show();
}

/**
 * A toast disappears; this lasts until the window is focused (createWindow's `focus` handler):
 * taskbar flash on Windows, dock bounce on macOS, urgency hint on Linux. No badge count: only
 * macOS has one everywhere.
 *
 * `isMinimized` too: a win32 window minimized by its button still reports `isFocused` (measured).
 */
function attractAttention(): void {
  if (window && !window.isDestroyed() && (!window.isFocused() || window.isMinimized())) {
    window.flashFrame(true);
  }
}

function revealWindow(): void {
  if (!window || window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.focus();
}

/**
 * Started with the workspace, so an answering socket means every project is open — no half-open
 * state for a verb to find; tet-ctl waits a moment for the socket.
 */
async function startControl(): Promise<void> {
  if (!controlChannel) {
    return;
  }
  const projectDeps = { store, repositories, sessions, openProject };
  try {
    controlServer = await startControlServer(
      {
        version: app.getVersion(),
        pid: process.pid,
        store,
        settings,
        sessions,
        repositories,
        listAgents: async () =>
          Promise.all(
            AGENTS.map(async (agent) => ({
              id: agent.id,
              name: agent.displayName,
              // The shell has no version check.
              installed: agent.versionArgs
                ? await isAgentInstalled(agent.executable(), agent.versionArgs, os.tmpdir())
                : true
            }))
          ),
        agentIds: AGENTS.map((agent) => agent.id),
        addProject: (directory) => addProject(projectDeps, directory),
        removeProject: (projectId) => removeProject(projectDeps, projectId),
        readCommands,
        shutdown,
        records,
        ownProfile,
        openEditor: (projectId, filePath) => send("editor:open", { projectId, path: filePath }),
        editorContent,
        showTab: (projectId, tabId) => send("terminal:show", { projectId, tabId }),
        projectsChanged: (change) => send("projects:changed", { projects: store.list(), ...change }),
        notify: showDesktopNotification,
        applyTheme
      },
      controlChannel.token,
      controlChannel.port
    );
  } catch (error) {
    // tet-ctl then reports nothing to reach.
    console.error("[tet] control channel not started:", error);
  }
}

/** The theme on screen: the window's initial one or the last `applyTheme` took. */
let shownTheme: ThemeDefinition | undefined;

/**
 * Applies the saved theme live and returns whether a restart is still needed. Live only within one
 * `kind`: an agent gets light or dark once at tab start (`AgentPaths.theme`).
 */
function applyTheme(): boolean {
  if (!window || window.isDestroyed() || !shownTheme) {
    return false;
  }
  // The kind on screen, not the saved one: a pending kind switch must not block a change within it.
  const { kind } = shownTheme;
  const theme = resolveTheme(settings.get()[themeKey(kind)], kind);
  if (theme.id !== shownTheme.id) {
    shownTheme = theme;
    window.setBackgroundColor(theme.windowBackground);
    if (process.platform !== "darwin") {
      window.setTitleBarOverlay({ color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor });
    }
    send("app:theme", theme.id);  }
  const saved = currentTheme(settings);
  // Agents get the saved theme (AgentPaths.theme), so only once it is on screen: a kind awaiting its
  // restart is not handed to open projects.
  if (saved.id === shownTheme.id) {
    sessions.themeChanged();
  }
  return saved.kind !== kind;
}

function createWindow(): void {
  // Per window: a theme the running window could not take (applyTheme) reaches later windows.
  const theme = currentTheme(settings);
  shownTheme = theme;
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    // The panes' floors summed (--pane-min-width twice, --content-min-width, the stacked sections,
    // title and branch bars); below this something clips.
    minWidth: 700,
    minHeight: 340,
    // Painted before the first frame in the title bar's color, since the window controls overlay
    // shows at once. Equals --vscode-titleBar-activeBackground and --vscode-sideBar-background.
    backgroundColor: theme.windowBackground,
    show: false,
    // Windows takes the .ico (generated from icon.png): per-size frames stay sharp in the taskbar,
    // where a resampled image looks soft. Linux wants a plain image; macOS reads the app bundle.
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
    // Our own title bar; the platform's window controls stay via the overlay.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      // Height must match the renderer's .titlebar rule, or controls and drag region disagree.
      process.platform === "darwin"
        ? undefined
        : { color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor, height: 35 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The preload reads the theme off process.argv synchronously, so the first frame is right;
      // an IPC round trip would paint it in the defaults.
      additionalArguments: [`--tet-theme=${theme.id}`, ...(isWaylandSession() ? ["--tet-wayland"] : [])]
    }
  });

  // Every load, reloads included, has no listener until App subscribes.
  window.webContents.on("did-start-loading", () => {
    noticesHeard = false;
  });
  // A reload reads the theme off the window's original arguments, possibly stale since applyTheme.
  // The renderer ignores its own theme id.
  window.webContents.on("did-finish-load", () => {
    if (shownTheme) {
      send("app:theme", shownTheme.id);
    }
  });
  window.once("ready-to-show", () => window?.show());
  // Ends attractAttention's flash.
  window.on("focus", () => window?.flashFrame(false));
  window.on("closed", () => {
    window = undefined;
  });

  const crashed = window;
  window.webContents.on("render-process-gone", (_event, details) => {
    // `clean-exit` is a window on its way out, not a fault.
    if (details.reason === "clean-exit" || crashed.isDestroyed()) {
      return;
    }
    console.error(`[tet] renderer gone (${details.reason}); rebuilding the window`);
    // Every pty lives in this process and keeps running, so reloading brings the sessions back;
    // only the renderer-held scrollback is lost. Rate-limited, or a renderer failing on load
    // would reload forever.
    const now = Date.now();
    if (now - rendererRebuiltAt < RENDERER_REBUILD_GAP_MS) {
      return;
    }
    rendererRebuiltAt = now;
    // Only once the new renderer has loaded; earlier sends reach the dead process.
    crashed.webContents.once("did-finish-load", () =>
      send("app:notice", {
        severity: "warning",
        message: "The window stopped responding and was loaded again. Your sessions kept running; what they printed before is gone."
      })
    );
    crashed.webContents.reload();
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
 * One instance: projects and accounts are rewritten whole from memory (a second instance would drop
 * the first's additions), agent sessions share directories, and `Repository.runAction` serializes
 * git only within a process. Asked before anything opens.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second start brings the running window to the front.
  app.on("second-instance", revealWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    startEventLoopMonitor(path.join(dataRoot, "event-loop.log"));
    // Before anything reads PATH, add the agents' install dirs to the OS's bare GUI PATH. Awaited
    // only after the window: on macOS/Linux it asks the login shell, which with nvm takes most of a
    // second. The requirements re-check (ipc.ts) joins the same run.
    const pathReady = augmentAgentPath();
    sweepTempFiles();
    // Into every terminal's environment before the first spawn. The token lives in this process
    // only — never on disk or a command line.
    const controlToken =
      (userDataArg && process.env[CONTROL_ENV.token]) || crypto.randomBytes(24).toString("base64url");
    const port = await findControlPort(dataRoot);
    // Installed, dist/ is in app.asar, unreadable outside electron; electron-builder.yml unpacks
    // the CLI.
    const cliPath = path.join(installed ? __dirname.replace("app.asar", "app.asar.unpacked") : __dirname, "tet-ctl.js");
    let binDir: string | undefined;
    try {
      binDir = writeLaunchers(dataRoot, cliPath);
    } catch (error) {
      // Not fatal: terminals then just lack `tet-ctl` on PATH.
      console.error("[tet] could not write the tet-ctl launcher:", error);
    }
    setControlEnv({ [CONTROL_ENV.port]: String(port), [CONTROL_ENV.token]: controlToken }, binDir);
    // A sandbox cannot reach the data folder's launcher, so sbx.ts writes the bundle into it
    // (ensureSandboxLauncher).
    configureSandboxes(cliPath, port, dataRoot);
    controlChannel = { token: controlToken, port };
    registerIpc({ store, settings, accounts, repositories, sessions, records, send, openProject, openWorkspace, applyTheme });
    timeStartup("window", createWindow);
    // The git process inherits its environment at the fork, so it waits for PATH; started up front
    // while the renderer loads.
    await pathReady;
    timeStartup("git-process", startGitProcess);
    timeStartup("auto-update", () =>
      startAutoUpdate(installed, releasesUrl, dataRoot, (severity, message) => send("app:notice", { severity, message }))
    );

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
 * Ending sessions is async (TerminalSession.stop) but electron exits once before-quit returns, so
 * the quit is held back and re-asked; `quitting` lets the re-ask through. Bounded so a pty that
 * never reports its exit cannot block the quit.
 */
const QUIT_TEARDOWN_TIMEOUT_MS = 5000;

let quitting = false;

/**
 * The one way out, for quit and the control channel's restart: sessions first, then the rest.
 * `relaunch` starts the new instance after this one exits, so the single-instance lock is free.
 */
function shutdown(relaunch: boolean): void {
  if (quitting) {
    return;
  }
  quitting = true;
  void Promise.race([
    sessions.disposeAll(),
    new Promise((resolve) => setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS))
  ]).finally(async () => {
    repositories.disposeAll();
    stopGitProcess();
    await controlServer?.close();
    if (relaunch) {
      app.relaunch();
    } else {
      installPendingUpdate();
    }
    app.quit();
  });
}

app.on("before-quit", (event) => {
  if (quitting) {
    return;
  }
  event.preventDefault();
  shutdown(false);
});
