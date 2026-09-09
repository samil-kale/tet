import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, Menu } from "electron";
import { AGENTS } from "./agents";
import { AccountStore } from "./providers/accounts";
import { CONTROL_ENV } from "../shared/control";
import type { Project, TerminalOutput, TerminalStatus } from "../shared/types";
import { installPendingUpdate, startAutoUpdate } from "./auto-update";
import { readCommands } from "./git/commands";
import { writeLaunchers } from "./control/control-launcher";
import { findControlPort, startControlServer } from "./control/control-server";
import { countActivity, markStartup, startEventLoopMonitor, timeStartup } from "./event-loop-monitor";
import { startGitProcess, stopGitProcess } from "./git/git-client";
import { registerIpc, sweepTempFiles } from "./ipc";
import { addProject, ProjectStore, removeProject } from "./projects";
import { configureSandboxes } from "./sbx";
import { augmentAgentPath } from "./terminals/agent-path";
import { scriptInvocation, writeNotifyScript } from "./terminals/os-notify";
import { setControlEnv } from "./terminals/pty";
import { installUncaughtHandler } from "./uncaught";
import { isAgentInstalled } from "./terminals/terminal-session";
import { RepositoryManager } from "./git/repository";
import { SessionManagerRegistry } from "./terminals/session-manager";
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

/**
 * A profile of its own for the tests driving the real app through tet-ctl (test/app.test.ts): own
 * projects, settings and socket, and — the lock being per profile — a second tet beside the one
 * being worked in. Set before anything below asks for userData. Only with it does tet take the
 * control token from its environment instead of making one; a normal start never reads that.
 */
const USER_DATA_ARG = "--user-data-dir=";
const userDataArg = process.argv.find((arg) => arg.startsWith(USER_DATA_ARG))?.slice(USER_DATA_ARG.length);
if (userDataArg) {
  app.setPath("userData", path.resolve(userDataArg));
}

// Before the stores, and before anything that could throw asynchronously: an uncaught exception
// shows a notice and keeps every terminal alive instead of freezing them all behind Electron's
// modal dialog. See uncaught.ts.
installUncaughtHandler(path.join(app.getPath("userData"), "errors.log"), (severity, message) =>
  send("app:notice", { severity, message })
);

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

/** The stored projects, brought up once by the requirements check and only when it passed.
 *  Idempotent: the check runs again on every window and after every re-check. */
function openWorkspace(): void {
  if (workspaceOpen) {
    return;
  }
  workspaceOpen = true;
  for (const project of store.list()) {
    timeStartup(`open ${project.name}`, () => openProject(project));
  }
  markStartup("control");
  void startControl();
}

/** What the control channel needs from the process; set before any terminal can spawn. */
let controlChannel: { token: string; port: number } | undefined;
let controlServer: { close: () => Promise<void> } | undefined;

/**
 * The real desktop toast behind the control channel's `notify` verb — this process is the one
 * holding the desktop session (a sandboxed hook has none; see os-notify.ts's
 * buildHookNotifyCommand). `unref` so a toast never keeps the event loop alive, but **not**
 * `detached`: measured, a detached `powershell -File` of the exact same script never got past
 * `CreateToastNotifier`/`ToastNotification.Show()` (alive but idle, no error, no toast, forever),
 * while the same script non-detached completes in well under a second.
 */
function showDesktopNotification(title: string, body: string): void {
  const dir = path.join(app.getPath("userData"), "notify");
  fs.mkdirSync(dir, { recursive: true });
  const scriptFile = writeNotifyScript(dir, "relay", title, body);
  const { command, args } = scriptInvocation(scriptFile);
  spawn(command, args, { stdio: "ignore", windowsHide: true }).unref();
}

/**
 * The control channel, up from the moment the workspace is: a socket that answers means every
 * project's terminals and repository are there to be asked about. Before that there is no socket
 * at all — no half-open state for a verb to find; tet-ctl waits a moment for one.
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
              // The shell has no version check and is always there.
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
        showTab: (projectId, tabId) => send("terminal:show", { projectId, tabId }),
        projectsChanged: (change) => send("projects:changed", { projects: store.list(), ...change }),
        notify: showDesktopNotification
      },
      controlChannel.token,
      controlChannel.port
    );
  } catch (error) {
    // The terminals then simply have nothing to reach, and tet-ctl says so.
    console.error("[tet] control channel not started:", error);
  }
}

function createWindow(): void {
  // Read per window: a theme picked in the settings dialog reaches the windows opened after it;
  // the ones already up keep what they were built with (xterm, shiki and monaco bake colors in).
  const theme = currentTheme(settings);
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    // Where the panes' own floors add up to (--pane-min-width twice and --content-min-width,
    // plus the stacked sections and the title and branch bars); below this something clips.
    minWidth: 700,
    minHeight: 340,
    // What the window is painted with before the first frame, so it is the title bar's own color
    // rather than the editor's: the platform draws the window controls as an overlay right away.
    // --vscode-titleBar-activeBackground and --vscode-sideBar-background are both this.
    backgroundColor: theme.windowBackground,
    show: false,
    // Windows takes the .ico, whose frames are each rendered at the size they are drawn at
    // rather than resampled from one large image, which made the mark look soft in the taskbar.
    // Linux wants a plain image; macOS ignores this and reads the app bundle. icon.ico is
    // generated from icon.png.
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
    // The project tabs live in the title bar; the platform's window controls stay via the overlay.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      // Height must match the .titlebar rule in the renderer, or the window controls and the
      // drag region disagree about where the title bar ends.
      process.platform === "darwin"
        ? undefined
        : { color: theme.windowBackground, symbolColor: theme.titleBarSymbolColor, height: 35 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // How the renderer learns the theme before its first paint: the preload reads this off
      // process.argv synchronously; an IPC round trip would leave the first frame in the defaults.
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
 * One instance, because there is one of everything it keeps: projects and accounts are rewritten
 * whole from memory, so a second window saving after the first would drop what the first added;
 * the agents' sessions live in the same directories for both; and the two would run git in one
 * repository unserialized, which `Repository.runAction` only prevents within a process. Asked
 * before anything is opened — the lock is the app's, not the window's.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Started again is a request to look at it: bring what is already there to the front.
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    // Before anything else opens: a download finished last session installs here, with nothing
    // yet running to lose. See installPendingUpdate.
    if (await installPendingUpdate()) {
      return;
    }
    Menu.setApplicationMenu(null);
    startEventLoopMonitor(path.join(app.getPath("userData"), "event-loop.log"));
    // Before anything reads PATH — the requirements check and every terminal do — add where agents
    // actually install to it, since tet is launched with the OS's barer GUI PATH. Awaited only
    // below the window: on macOS/Linux it asks the login shell, which with an nvm in the profile
    // takes a good part of a second. The requirements re-check (ipc.ts) joins the same run.
    const pathReady = augmentAgentPath();
    sweepTempFiles();
    // The control channel's token and address, into every terminal's environment before the first
    // one can spawn. The token lives in this process only — never on disk, never on a command line.
    const controlToken =
      (userDataArg && process.env[CONTROL_ENV.token]) || crypto.randomBytes(24).toString("base64url");
    const port = await findControlPort(app.getPath("userData"));
    // Packaged, dist/ sits in app.asar, which a process other than electron cannot read into;
    // tet-ctl.js is unpacked beside it (electron-builder.yml).
    const cliPath = path.join(app.isPackaged ? __dirname.replace("app.asar", "app.asar.unpacked") : __dirname, "tet-ctl.js");
    let binDir: string | undefined;
    try {
      binDir = writeLaunchers(app.getPath("userData"), cliPath);
    } catch (error) {
      // A read-only profile must not cost the window: the terminals then have no `tet-ctl` on PATH.
      console.error("[tet] could not write the tet-ctl launcher:", error);
    }
    setControlEnv({ [CONTROL_ENV.port]: String(port), [CONTROL_ENV.token]: controlToken }, binDir);
    // Same bundle and port: a sandbox has no access to userData's launcher, so sbx.ts writes this
    // file into the sandbox itself (ensureSandboxLauncher).
    configureSandboxes(cliPath, port);
    controlChannel = { token: controlToken, port };
    registerIpc({ store, settings, accounts, repositories, sessions, send, openProject, openWorkspace });
    timeStartup("window", createWindow);
    // The git process inherits its environment at the fork, so it waits for the PATH — still up
    // front rather than on the first repository, the renderer being busy loading meanwhile.
    await pathReady;
    timeStartup("git-process", startGitProcess);
    markStartup("auto-update");
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
 * Ending the sessions is asynchronous (TerminalSession.stop) and electron tears the process down
 * the moment a synchronous before-quit handler returns, so the quit is held back and asked for
 * again afterwards. `quitting` keeps that second ask from being held back in turn, which would
 * leave the app unable to quit at all. Bounded so a pty that never reports its exit cannot either.
 */
const QUIT_TEARDOWN_TIMEOUT_MS = 5000;

let quitting = false;

/**
 * The one way out, for the quit and the control channel's restart alike: the sessions first, then
 * everything with nothing left to serve. `relaunch` starts the new instance once this one has
 * exited, so the single-instance lock is free by then.
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
