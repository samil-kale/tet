import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { AGENTS } from "./agents";
import { AccountStore } from "./providers/accounts";
import { GitLoginStore } from "./git-logins";
import { CONTROL_ENV } from "../shared/control";
import { RELEASES_URL } from "../shared/release";
import { resolveTheme, themeKey, type ThemeDefinition } from "../shared/themes";
import { overridesMachineNote } from "../shared/types";
import type { NoticeSeverity, Project, TerminalDescriptor, TerminalOutput, TerminalStatus } from "../shared/types";
import { installPendingUpdate, startAutoUpdate } from "./auto-update";
import { readCommands, readSbxConfig } from "./tet-json";
import { writeLaunchers } from "./control/control-launcher";
import { ControlRecords } from "./control/control-records";
import { findControlPort, startControlServer } from "./control/control-server";
import { EnvRequests, EnvStore } from "./environment";
import { countActivity, markStartup, startEventLoopMonitor, timeStartup } from "./event-loop-monitor";
import { startGitProcess, stopGitProcess } from "./git/git-client";
import { registerIpc, sweepTempFiles } from "./ipc";
import { addProject, addWorktree, deleteWorktree, ProjectStore, removeProject, type ProjectDeps } from "./projects";
import { configureSandboxes, readSbxStatus } from "./sbx";
import { SbxLocalStore } from "./sbx-local";
import { readProjectSbxProblems, saveProjectSbx } from "./sbx-settings";
import { anyAgentInstalled } from "./requirements";
import { resolveDataRoot } from "./data-root";
import { augmentAgentPath } from "./terminals/agent-path";
import { setControlEnv, setStoredEnv } from "./terminals/pty";
import { installUncaughtHandler, logError } from "./uncaught";
import { awaitedToastTab, showDesktopNotification, startNotifications } from "./notifications";
import { isOpenableUrl } from "./shell-open";
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

/** Everything the user is told from this process (Notices.tsx), held as `send` holds it. */
function notice(severity: NoticeSeverity, message: string): void {
  send("app:notice", { severity, message });
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

/** A project's active editor tab text (ControlDeps.editorContent), on a per-request reply channel. */
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

/**
 * One message for all tabs: see TerminalOutput. Output whose tab closed while it was batched is
 * dropped here: the renderer has disposed that view by now, and a late batch would look to it
 * like output for a tab not yet attached (terminal-views.ts's earlyOutput).
 */
function flushOutput(): void {
  flushTimer = undefined;
  const live = [...pendingOutput.values()].filter((pending) => sessions.get(pending.projectId)?.hasTab(pending.tabId));
  pendingOutput.clear();
  if (live.length > 0) {
    send("terminal:output", live);
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
installUncaughtHandler(path.join(dataRoot, "errors.log"), notice);

const store = new ProjectStore(dataRoot);
const settings = new SettingsStore(dataRoot);
const accounts = new AccountStore(dataRoot);
const logins = new GitLoginStore(dataRoot);
const sbxLocal = new SbxLocalStore(dataRoot);
const environment = new EnvStore(dataRoot);
// Read at every spawn, so a restarted tab sees what was saved meanwhile.
setStoredEnv(() => environment.values());
// Held until the window listens (send), like any notice this early.
const overriding = environment.list().filter((variable) => variable.overridesMachine).map((variable) => variable.name);
if (overriding.length > 0) {
  notice("info", overridesMachineNote(overriding));
}
// Asked only once App listens (noticesHeard), which is also when the dialog can show.
const envRequests = new EnvRequests(
  environment,
  (request) => {
    if (!noticesHeard || !window || window.isDestroyed()) {
      return false;
    }
    send("environment:request", request);
    // Out of sight, told as a question is (session-manager's toast): the agent's shell gives up
    // waiting at some point, and the dialog with it.
    if ((!window.isFocused() || window.isMinimized()) && settings.get().notifications.needsYou) {
      const tab = request.projectId && request.tabId ? findTab(request.projectId, request.tabId) : undefined;
      const agent = AGENTS.find((entry) => entry.id === tab?.agentId)?.displayName ?? "An agent";
      showDesktopNotification(
        `${agent}: Environment variables needed`,
        `Asks for ${request.variables.map((variable) => variable.name).join(", ")} — answer it in TET`,
        tab && { projectId: tab.projectId, tabId: tab.tabId }
      );
    }
    return true;
  },
  (id) => send("environment:withdrawn", id)
);
/** What control verbs answer beyond the stores. */
const records = new ControlRecords();
const repositories = new RepositoryManager(
  (projectId, state) => send("repo:state-changed", { projectId, state }),
  notice,
  (projectId) => {
    send("commands:changed", { projectId });
    // tet.json also holds the sbx switch, which sbx-only agents must hear (sbxConfigChanged).
    void sessions
      .get(projectId)
      ?.sbxConfigChanged()
      .catch((error: unknown) => console.error("[tet] could not apply the sbx config change:", error));
  },
  (projectId) => send("repo:files-changed", { projectId }),
  (projectId, path) => send("repo:file-changed", { projectId, path }),
  logins
);
const sessions = new SessionManagerRegistry(dataRoot, settings, sbxLocal, {
  onTabs: (projectId, tabs) => {
    send("terminal:tabs", { projectId, tabs });
    awaitedToastTab(projectId);
    records.keepOutputs(projectId, new Set(tabs.map((tab) => tab.tabId)));
  },
  onOutput: (projectId, tabId, data) => {
    records.addOutput(projectId, tabId, data);
    queueOutput(projectId, tabId, data);
  },
  onStatus: (projectId, tabId, status: TerminalStatus) => {
    // Output batched before the change goes first, so a status never overtakes it (a restart's
    // clear in App.tsx would otherwise run before the dying process's last bytes arrive).
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushOutput();
    }
    send("terminal:status", { projectId, tabId, status });
  },
  onStartupProgress: (projectId, show) => send("terminal:startup-progress", { projectId, show }),
  onNotice: notice
});

function openProject(project: Project): void {
  repositories.open(project);
  sessions.open(project);
}

/** For opening and closing projects, shared by the window (ipc.ts) and the control channel. */
const projectDeps: ProjectDeps = {
  store,
  repositories,
  sessions,
  records,
  sbxLocal,
  openProject,
  dataRoot,
  projectsChanged: (change) => send("projects:changed", { projects: store.list(), ...change })
};

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

function findTab(projectId: string, tabId: string): TerminalDescriptor | undefined {
  return sessions.get(projectId)?.snapshot().find((tab) => tab.tabId === tabId);
}

/**
 * Brings a toast's tab to the front, found by tab id or by session id — the tab id of a restored
 * tab (TerminalDescriptor). Returns whether it was found.
 */
function showToastTarget(target: { projectId: string; tabId: string; sessionId?: string }): boolean {
  const tab =
    findTab(target.projectId, target.tabId) ??
    (target.sessionId !== undefined ? findTab(target.projectId, target.sessionId) : undefined);
  if (tab) {
    send("terminal:show", { projectId: target.projectId, tabId: tab.tabId });
  }
  return tab !== undefined;
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

startNotifications({
  installed,
  revealWindow,
  attractAttention,
  showTab: showToastTarget,
  sessionIdOf: (target) => findTab(target.projectId, target.tabId)?.sessionId
});

/**
 * Started with the workspace, so an answering socket means every project is open — no half-open
 * state for a verb to find; tet-ctl waits a moment for the socket.
 */
async function startControl(): Promise<void> {
  if (!controlChannel) {
    return;
  }
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
        removeProject: (projectId) => void removeProject(projectDeps, projectId),
        addWorktree: (projectId, branch) => addWorktree(projectDeps, projectId, branch),
        deleteWorktree: (worktree, force) => deleteWorktree(projectDeps, worktree, { force, onRemote: false }),
        readCommands,
        shutdown,
        records,
        openEditor: (projectId, filePath, keep) => send("editor:open", { projectId, path: filePath, keep }),
        editorContent,
        showTab: (projectId, tabId) => send("terminal:show", { projectId, tabId }),
        projectsChanged: projectDeps.projectsChanged,
        notify: showDesktopNotification,
        applyTheme,
        environment,
        envRequests,
        sbx: {
          status: (project) => readSbxStatus(project.path, project.id),
          anyAgentInstalled,
          config: (project) => readSbxConfig(project.path),
          stored: (projectId) => sbxLocal.stored(projectId),
          problems: readProjectSbxProblems,
          save: (project, request, local, status) => saveProjectSbx({ sbxLocal, send }, project, request, local, status)
        }
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
    minWidth: 800,
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
    // The dialog went with the page.
    envRequests.drop();
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
      notice("warning", "The window stopped responding and was loaded again. Your sessions kept running; what they printed before is gone.")
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

  // Nothing in the page takes the window away from tet or opens another: a link or form in a
  // Markdown preview, a stray drop. A new window is what monaco's ctrl-clicked link asks for, so
  // its web and mail links reach the browser as `shell:open-url`'s do; nothing else leaves.
  // Measured: a navigation to `about:blank` reaches neither event — Chromium offers no cancel for
  // it — so only the page's own script could blank the window, and there is none but tet's.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenableUrl(url)) {
      shell.openExternal(url).catch((error: unknown) => logError(`could not open ${url}: ${String(error)}`));
    }
    return { action: "deny" };
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
    // Before the first spawn; each terminal gets only a token made from it for its own tab
    // (control-token.ts). The token lives in this process only — never on disk or a command line.
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
    registerIpc({
      dataRoot,
      store,
      settings,
      accounts,
      logins,
      sbxLocal,
      environment,
      envRequests,
      repositories,
      sessions,
      records,
      projectDeps,
      send,
      openProject,
      openWorkspace,
      applyTheme,
      shutdown
    });
    timeStartup("window", createWindow);
    // Off the start path: reading each project's main worktree is up to two reads and a realpath,
    // and the stored value is right until a folder is made or unmade a worktree behind tet's back.
    setImmediate(() => {
      if (store.refreshMainPaths()) {
        projectDeps.projectsChanged({});
      }
    });
    // The git process inherits its environment at the fork, so it waits for PATH; started up front
    // while the renderer loads.
    await pathReady;
    timeStartup("git-process", startGitProcess);
    timeStartup("auto-update", () => startAutoUpdate(installed, releasesUrl, dataRoot, notice));

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
/**
 * After `app.quit()` the exit is electron's: windows close, then `will-quit`. On macOS that has
 * stalled there with nothing left to tear down (install.test.ts, a quit by Apple Event: the second
 * `before-quit` logged, `will-quit` never). Everything of ours is written by then, so the process
 * leaves on its own after this — said in the log, since a forced exit is not the normal way out.
 */
const QUIT_EXIT_TIMEOUT_MS = 5000;

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
  // Each step logged: a quit on macOS has hung without saying where (install.test.ts).
  console.error(`[tet] quit: ending sessions${relaunch ? " for a restart" : ""}`);
  void Promise.race([
    sessions.disposeAll().then(() => "sessions ended"),
    new Promise((resolve) => setTimeout(() => resolve("sessions timed out"), QUIT_TEARDOWN_TIMEOUT_MS))
  ]).then(
    (outcome) => console.error(`[tet] quit: ${String(outcome)}`),
    (error: unknown) => console.error("[tet] quit: ending sessions failed:", error)
  ).finally(async () => {
    repositories.disposeAll();
    stopGitProcess();
    console.error("[tet] quit: git stopped, closing the control channel");
    await controlServer?.close();
    if (relaunch) {
      app.relaunch();
    } else {
      installPendingUpdate();
    }
    console.error("[tet] quit: done, quitting");
    app.quit();
    setTimeout(() => {
      console.error(`[tet] quit: still here after ${QUIT_EXIT_TIMEOUT_MS / 1000}s, exiting`);
      app.exit(0);
    }, QUIT_EXIT_TIMEOUT_MS).unref();
  });
}

app.on("before-quit", (event) => {
  console.error(`[tet] quit: before-quit${quitting ? ", letting it through" : ""}`);
  if (quitting) {
    return;
  }
  event.preventDefault();
  shutdown(false);
});

app.on("will-quit", () => console.error("[tet] quit: will-quit"));
