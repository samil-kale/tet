import * as fs from "node:fs";
import * as path from "node:path";
import { app, BaseWindow, Menu } from "electron";
import { AGENTS, listAskModels, listInstalledAgents } from "./agents";
import { AccountStore } from "./providers/accounts";
import { GitLoginStore } from "./git/git-logins";
import { CONTROL_ENV } from "../shared/ctl";
import { RELEASES_URL } from "../shared/release";
import { resolveTheme, themeKey } from "../shared/themes";
import { overridesMachineNote } from "../shared/types/environment";
import type { ProjectRef } from "../shared/types/project";
import type { TabDescriptor, TerminalStatus } from "../shared/types/terminals";
import { installPendingUpdate, startAutoUpdate } from "./update/auto-update";
import { readChanged, readCommands, readSbxSettings } from "./store/tet-json";
import { prepareControl } from "./ctl/ctl-channel";
import { ControlRecords } from "./ctl/ctl-records";
import { startControlServer } from "./ctl/ctl-server";
import { EnvRequests } from "./ctl/env-requests";
import { EnvStore } from "./store/environment";
import { startGitProcess, stopGitProcess } from "./git/git-client";
import { stopExplorerProcess } from "./git/explorer-client";
import { browserAutomation } from "./browser/browser-client";
import { BrowserTabs, sweepBrowserProfiles, type BrowserSandbox, type SandboxRoute } from "./browser/browser-tabs";
import { SandboxProxy } from "./browser/sandbox-proxy";
import { registerIpc } from "./ipc";
import { sweepDropFiles } from "./store/drops";
import { resolveProjectRef } from "./store/resolved-ref";
import { projectRefPath } from "./store/project-dirs";
import {
  addProject,
  addWorktree,
  deleteWorktree,
  openStoredProjects,
  removeProject,
  resolveStoredIds,
  syncWorktrees,
  type ProjectDeps,
} from "./projects";
import { ProjectStore } from "./store/project-store";
import { readSbxUser } from "./sbx/sbx-cli";
import { SandboxRelay } from "./sbx/sbx-relay";
import { readSbxReading, readSbxSignedIn } from "./sbx/sbx-status";
import { SbxAccountStore, signInToSbx } from "./sbx/sbx-accounts";
import { SbxLocalStore } from "./sbx/sbx-local";
import { readProjectSbxProblems, saveProjectSbx } from "./sbx/sbx-settings";
import { anyAgentInstalled } from "./requirements";
import { resolveDataRoot } from "./store/data-root";
import { augmentAgentPath } from "./agents/agent-path";
import { setStoredEnv } from "./terminals/pty";
import { installUncaughtHandler } from "./uncaught";
import { AppWindow } from "./window";
import { logError } from "./util/error-log";
import { awaitedNotificationTab, showDesktopNotification, startNotifications } from "./util/notifications";
import { RepositoryManager } from "./git/repository";
import { SessionManagerRegistry } from "./terminals/session-registry";
import { SettingsStore } from "./store/settings";
import type { SettingsAccess } from "./store/settings";
import { currentTheme } from "./store/theme";
import { PLATFORM } from "./util/host-platform";

/**
 * A separate profile for tests driving the real app via tet-ctl (test/e2e/app.test.ts): own
 * projects, settings and socket, and — the lock being per profile — a second TET beside the working
 * one. Both Chromium's profile and TET's data folder (data-root.ts), set before either is asked
 * for. Only then is the control token taken from the environment.
 */
const USER_DATA_ARG = "--user-data-dir=";
const userDataArg = process.argv.find((arg) => arg.startsWith(USER_DATA_ARG))?.slice(USER_DATA_ARG.length);
if (userDataArg) {
  app.setPath("userData", path.resolve(userDataArg));
}
/** For tests run locally (test/helpers/): the window is drawn but never shown. */
const HIDE_WINDOW = process.argv.includes("--hide-window");
/** TET's own data; `userData` is left to Chromium's profile. */
const dataRoot = resolveDataRoot(userDataArg);
try {
  fs.mkdirSync(dataRoot, { recursive: true });
} catch (error) {
  logError("could not create the data folder", error);
}

/**
 * Who Windows says a notification is from: name and icon come from the Start menu entry carrying this id,
 * never from the notification (so no notification icon). Electron writes that entry on the first notification
 * (windows_toast_activator.cc), named after the executable's ProductName, with the id and the
 * activator CLSID. Installed, the executable is `TET.exe` (electron-builder.yml), so the entry is
 * install.ps1's `TET.lnk` rewritten in place; a development run's electron.exe reads "Electron".
 *
 * Windows remembers what it decided about an id, so `npm start` gets its own id — else one dev
 * notification leaves the installed TET reading "Electron". The CLSID is fixed, not Electron's per-run
 * random one, so a notification clicked after TET quit starts the COM server the entry names. Both are set
 * before the workspace: a hook can report a turn once the first terminal is up. The id is
 * electron-builder.yml's `appId`, which Windows' existing decisions about it are keyed on.
 */
const APP_USER_MODEL_ID = "com.samilkale.tet";
const TOAST_ACTIVATOR_CLSID = "{8DA9BB54-C0A5-4BEC-AF76-BE3568344852}";
const installed = app.isPackaged;
if (PLATFORM.windowsNotifications) {
  app.setAppUserModelId(installed ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.dev`);
  if (installed) {
    app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
  }
}

// Every visible terminal plus the warm hidden ones (webgl-pool.ts) holds a WebGL context. Past 16
// per renderer Blink silently evicts the oldest to the DOM renderer; 128 leaves room, a leak shows.
app.commandLine.appendSwitch("max-active-webgl-contexts", "128");

/**
 * GitHub's releases, except for the install test (test/e2e/install.test.ts) serving its own — read
 * from the environment only with a profile of its own, like the control token.
 */
const releasesUrl = (userDataArg && process.env.TET_RELEASES_URL) || RELEASES_URL;

const appWindow: AppWindow = new AppWindow({
  hidden: HIDE_WINDOW,
  hasTab: (ref, tabId): boolean => tabManagers.get(ref)?.hasTab(tabId) === true,
  // The environment dialog went with the page.
  onPageLoad: (): void => envRequests.drop(),
  onClosed: (): void => browserTabs.closeEverything(),
});
const { send, notice } = appWindow;

// Before anything that could throw asynchronously, so an uncaught exception becomes a notice rather
// than Electron's modal dialog freezing every terminal (uncaught.ts).
installUncaughtHandler(path.join(dataRoot, "errors.log"), notice);

const store = new ProjectStore(dataRoot);
const settings = new SettingsStore(dataRoot);
const accounts = new AccountStore(dataRoot);
const logins = new GitLoginStore(dataRoot);
const sbxLocal = new SbxLocalStore(dataRoot);
const sbxAccounts = new SbxAccountStore(dataRoot);
const environment = new EnvStore(dataRoot);
// Read at every spawn, so a restarted tab sees what was saved meanwhile.
setStoredEnv(() => environment.values());
// Held until the window listens (send), like any notice this early.
const overriding = environment
  .list()
  .filter((variable) => variable.overridesMachine)
  .map((variable) => variable.name);
if (overriding.length > 0) {
  notice("info", overridesMachineNote(overriding));
}
// Asked only once App listens (AppWindow.listening), which is also when the dialog can show.
const envRequests = new EnvRequests(
  environment,
  (request) => {
    if (!appWindow.listening()) {
      return false;
    }
    send("env:request", request);
    // Out of sight, told as a question is (session-manager's notification): the agent's shell gives up
    // waiting at some point, and the dialog with it.
    if (appWindow.inBackground() && settings.get().notifications.waiting) {
      const tab = request.ref && request.tabId ? findTab(request.ref, request.tabId) : undefined;
      const agent = AGENTS.find((entry) => entry.id === tab?.agentId)?.displayName ?? "An agent";
      showDesktopNotification(
        `${agent}: Environment variables needed`,
        `Asks for ${request.variables.map((variable) => variable.name).join(", ")} — answer it in TET`,
        tab && request.ref && { ref: request.ref, tabId: tab.tabId },
      );
    }
    return true;
  },
  (id) => send("env:withdrawn", id),
);
/** What control verbs answer beyond the stores. */
const records = new ControlRecords();
const repositories = new RepositoryManager(
  dataRoot,
  (ref, state) => {
    send("repository:state-changed", { ref, state });
    // Every repository's and worktree's state lists the project's worktrees; a worktree's own is
    // the first to see a branch switched in it (the repository's watcher skips a worktree's
    // events).
    syncWorktrees(projectDeps, ref.projectId, state);
  },
  notice,
  (projectId) => {
    // Written broken, it still counts as its last readable version (tet-json.ts's `read`).
    const project = store.get(projectId);
    if (!project) {
      return;
    }
    // Read once here for every listener; the repository's file serves its worktrees too.
    void readChanged(project.path).then(({ problem, commands, sbx }) => {
      if (problem !== undefined) {
        notice("warning", `${project.name} keeps its last readable tet.json until it is fixed: ${problem}`);
      }
      if (!commands || !sbx) {
        return;
      }
      send("commands:changed", { projectId, commands, sbxEnabled: sbx.enabled });
      // tet.json also holds whether SBX is enabled, which sbx-only agents must hear (sbxSettingsChanged) — in
      // every repository and worktree of the project.
      for (const manager of tabManagers.forProject(projectId)) {
        void manager.sbxSettingsChanged(sbx.enabled).catch((error: unknown) => logError("could not apply the SBX settings change", error));
      }
    });
  },
  (ref) => send("repository:files-changed", { ref }),
  (ref, filePath) => send("repository:file-changed", { ref, path: filePath }),
  logins,
);
const tabManagers = new SessionManagerRegistry(dataRoot, settings, sbxLocal, {
  onTabs: (ref, tabs) => {
    send("tabs:changed", { ref, tabs });
    awaitedNotificationTab(ref);
  },
  onOutput: (ref, tabId, data) => {
    appWindow.queueOutput(ref, tabId, data);
  },
  onStatus: (ref, tabId, status: TerminalStatus) => {
    // Output batched before the change goes first, so a status never overtakes it (a restart's
    // clear in App.tsx would otherwise run before the dying process's last bytes arrive).
    appWindow.flushOutput();
    send("tabs:status", { ref, tabId, status });
  },
  onStartupProgress: (ref, show) => send("tabs:startup-progress", { ref, show }),
  onNotice: notice,
});

/** The browser tabs' pages, and Playwright driving them for the browser verbs. */
const browserTabs = new BrowserTabs({
  host: appWindow,
  dataRoot,
  onTabs: (ref, tabs) => send("browser:changed", { ref, tabs }),
  onOpened: (ref, tabId) => send("tabs:show", { ref, tabId }),
  onPressed: (ref, tabId) => send("browser:pressed", { ref, tabId }),
  pageBackground: () => appWindow.shownTheme()?.editorBackground,
  onClosed: (tabId) => browser.tabClosed(tabId),
  onShortcut: (shortcut) => send("browser:shortcut", shortcut),
  onMenu: (ref, tabId, menu) => send("browser:menu", { ref, tabId, menu }),
  onLogin: (ref, tabId, login) => send("browser:login", { ref, tabId, login }),
  route: sandboxRoute,
  notice,
});
const browser = browserAutomation((tabId) => browserTabs.pageById(tabId));

/** A sandbox's way out for its agent's browser tabs: its relay (sbx-relay.ts), and the proxy on
 *  this machine's loopback dialling through it (sandbox-proxy.ts). */
async function sandboxRoute(sandbox: BrowserSandbox): Promise<SandboxRoute> {
  const relay = new SandboxRelay(sandbox.name, path.join(__dirname, "tet-browser-relay.js"));
  try {
    const { ca } = await relay.hello();
    const proxy = await SandboxProxy.start(relay);
    return {
      port: proxy.port,
      ca,
      refusal: (host) => proxy.refusal(host),
      close: () => {
        proxy.close();
        relay.stop();
      },
    };
  } catch (error) {
    relay.stop();
    throw error;
  }
}

/** The sandbox a tab runs in, which its browser tabs load through. */
function openProjectRef(ref: ProjectRef): void {
  const resolved = resolveProjectRef(dataRoot, store, ref);
  repositories.open(resolved);
  tabManagers.open(resolved);
}

/** For opening and closing projects, shared by the window (ipc/) and the control channel. */
const projectDeps: ProjectDeps = {
  store,
  repositories,
  tabManagers,
  browserTabs,
  records,
  sbxLocal,
  openProjectRef,
  dataRoot,
  projectsChanged: (change) => send("projects:changed", { projects: store.list(), ...change }),
  notice,
};

let workspaceOpened: Promise<void> | undefined;

/**
 * Opens the stored projects once the requirements check passes (openStoredProjects). Idempotent:
 * the check reruns. First each project's id as its repository says (resolveStoredIds).
 */
function openWorkspace(): Promise<void> {
  workspaceOpened ??= (async () => {
    await resolveStoredIds(projectDeps);
    await openStoredProjects(projectDeps);
    void startControl();
  })().catch((error: unknown) => {
    // A failed open is not kept: the check's next pass runs it again.
    workspaceOpened = undefined;
    throw error;
  });
  return workspaceOpened;
}

/** Set before any terminal can spawn. */
let controlChannel: { token: string; port: number } | undefined;
let controlServer: { close: () => Promise<void> } | undefined;

function findTab(ref: ProjectRef, tabId: string): TabDescriptor | undefined {
  return tabManagers
    .get(ref)
    ?.snapshot()
    .find((tab) => tab.tabId === tabId);
}

/**
 * Brings a notification's tab to the front, found by tab id or by session id — the tab id of a restored
 * tab (TabDescriptor). Returns whether it was found.
 */
function showNotificationTarget(target: { ref: ProjectRef; tabId: string; sessionId?: string }): boolean {
  const tab = findTab(target.ref, target.tabId) ?? (target.sessionId !== undefined ? findTab(target.ref, target.sessionId) : undefined);
  if (tab) {
    send("tabs:show", { ref: target.ref, tabId: tab.tabId });
  }
  return tab !== undefined;
}

startNotifications({
  installed,
  revealWindow: appWindow.reveal,
  attractAttention: appWindow.attractAttention,
  showTab: showNotificationTarget,
  sessionIdOf: (target) => findTab(target.ref, target.tabId)?.sessionId,
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
        settings: settingsAccess,
        tabManagers,
        repositories,
        listAgents: listInstalledAgents,
        agents: AGENTS,
        askModels: listAskModels,
        addProject: (directory) => addProject(projectDeps, directory),
        removeProject: (projectId) => removeProject(projectDeps, projectId),
        addWorktree: (projectId, branch) => addWorktree(projectDeps, projectId, branch),
        deleteWorktree: (worktree, force) => deleteWorktree(projectDeps, worktree, { force, onRemote: false }),
        readCommands,
        shutdown,
        records,
        projectRefPath: (ref) => {
          const project = store.get(ref.projectId);
          return project && projectRefPath(dataRoot, project, ref);
        },
        openEditor: (ref, filePath, keep) => send("editor:open", { ref, path: filePath, keep }),
        editorContent: appWindow.editorContent,
        terminalText: appWindow.terminalText,
        showTab: (ref, tabId) => send("tabs:show", { ref, tabId }),
        browser: { tabs: browserTabs, automation: browser.api },
        showDesktopNotification,
        environment,
        envRequests,
        sbx: {
          // No PATH re-read: tet-ctl follows no install, the dialog's "Check again" does.
          status: (project) => readSbxReading(project.path, { projectId: project.id }, false),
          anyAgentInstalled,
          settings: (project) => readSbxSettings(project.path),
          stored: (projectId) => sbxLocal.stored(projectId),
          problems: readProjectSbxProblems,
          save: (project, request, local, known) => saveProjectSbx({ sbxLocal, notice }, project, request, local, known),
          accounts: () => sbxAccounts.list(),
          signedIn: readSbxSignedIn,
          signedInUser: () => readSbxUser(false),
          signIn: (account) => signInToSbx(sbxAccounts, account.user, "", account.id),
        },
      },
      controlChannel.token,
      controlChannel.port,
    );
  } catch (error) {
    // tet-ctl then reports nothing to reach.
    logError("control channel not started", error);
  }
}

/** Every settings change, from the window or tet-ctl: stored, then handed on at once to what shows
 *  or reads it. */
const settingsAccess: SettingsAccess = {
  get: () => settings.get(),
  patch(edits) {
    settings.patch(edits);
    const restartRequired = applyTheme();
    if (edits.notifications?.idleReminder !== undefined) {
      tabManagers.idleReminderChanged();
    }
    if (edits.appearance?.lanes) {
      appWindow.showLanes(settings.get().appearance.lanes);
    }
    if (edits.files?.excludeGitIgnore !== undefined || edits.files?.compactFolders !== undefined || edits.files?.sortOrder !== undefined) {
      repositories.announceFilesChanged();
    }
    return restartRequired;
  },
};

/**
 * Applies the saved theme live and returns whether a restart is still needed. Live only within one
 * `kind`: an agent gets light or dark once at tab start (`AgentPaths.theme`).
 */
function applyTheme(): boolean {
  const shown = appWindow.shownTheme();
  if (!shown) {
    return false;
  }
  // The kind on screen, not the saved one: a pending kind switch must not block a change within it.
  const { kind } = shown;
  appWindow.showTheme(resolveTheme(settings.get().appearance[themeKey(kind)], kind));
  browserTabs.repaint();
  const saved = currentTheme(settings);
  // Agents get the saved theme (AgentPaths.theme), so only once it is on screen: a kind awaiting its
  // restart is not handed to them.
  if (saved.id === appWindow.shownTheme()?.id) {
    tabManagers.themeChanged();
  }
  return saved.kind !== kind;
}

function createWindow(): void {
  appWindow.create(currentTheme(settings));
}

/**
 * One instance: projects and accounts are rewritten whole from memory (a second instance would drop
 * the first's additions), agent sessions share directories, and `Repository.runAction` serializes
 * git only within a process. Asked before anything opens.
 */
if (!app.requestSingleInstanceLock()) {
  // Logged: even a refused start runs from its install folder until it quits.
  logError(`start: ${app.getVersion()}, pid ${process.pid} from ${process.execPath}, another instance runs, quitting`);
  app.quit();
} else {
  logError(`start: ${app.getVersion()}, pid ${process.pid} from ${process.execPath}`);
  // A second start brings the running window to the front.
  app.on("second-instance", appWindow.reveal);

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Before anything reads PATH, add the agents' install dirs to the OS's bare GUI PATH. Awaited
    // only after the window: on macOS/Linux it asks the login shell, which with nvm takes most of a
    // second. The requirements re-check (ipc/app.ts) joins the same run.
    const pathReady = augmentAgentPath();
    sweepDropFiles(dataRoot);
    sweepBrowserProfiles(dataRoot);
    try {
      controlChannel = await prepareControl(dataRoot, __dirname, installed, (userDataArg && process.env[CONTROL_ENV.token]) || undefined);
    } catch (error) {
      // The window still opens: tet-ctl then reports nothing to reach (startControl).
      logError("control channel not prepared", error);
    }
    registerIpc({
      store,
      settings: settingsAccess,
      accounts,
      logins,
      sbxLocal,
      sbxAccounts,
      environment,
      envRequests,
      repositories,
      tabManagers,
      browserTabs,
      records,
      projectDeps,
      notice,
      openWorkspace,
      shutdown,
    });
    createWindow();
    // The git process inherits its environment at the fork, so it waits for PATH; started up front
    // while the renderer loads.
    await pathReady;
    startGitProcess();
    startAutoUpdate(installed, releasesUrl, dataRoot, notice, appWindow.noticeProgress);

    app.on("activate", () => {
      if (BaseWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (PLATFORM.quitsWithLastWindow) {
    app.quit();
  }
});

/**
 * Ending tabs is async (TerminalSession.stop) but electron exits once before-quit returns, so
 * the quit is held back and re-asked; `quitting` lets the re-ask through. Bounded so a pty that
 * never reports its exit cannot block the quit.
 */
const QUIT_TEARDOWN_TIMEOUT_MS = 5000;
/**
 * After `app.quit()` the exit is electron's: windows close, then `will-quit`, which on macOS can
 * stall with nothing left to tear down. Everything of ours is written by then, so the process
 * leaves on its own after this — said in the log, since a forced exit is not the normal way out.
 */
const QUIT_EXIT_TIMEOUT_MS = 5000;

let quitting = false;

/**
 * The one way out, for quit and the control channel's restart: tabs first, then the rest.
 * `relaunch` starts the new instance after this one exits, so the single-instance lock is free.
 */
function shutdown(relaunch: boolean): void {
  if (quitting) {
    return;
  }
  quitting = true;
  void Promise.race([tabManagers.disposeAll(), new Promise((resolve) => setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS))])
    .catch((error: unknown) => logError("quit: ending tabs failed", error))
    .finally(async () => {
      repositories.disposeAll();
      stopGitProcess();
      stopExplorerProcess();
      browser.stop();
      await controlServer?.close();
      if (relaunch) {
        app.relaunch();
      } else {
        installPendingUpdate();
      }
      app.quit();
      setTimeout(() => {
        logError(`quit: still here after ${QUIT_EXIT_TIMEOUT_MS / 1000}s, exiting`);
        app.exit(0);
      }, QUIT_EXIT_TIMEOUT_MS).unref();
    });
}

app.on("before-quit", (event) => {
  if (quitting) {
    return;
  }
  event.preventDefault();
  shutdown(false);
});

/**
 * Keeps electron's own handling of these signals, a quit through before-quit. write-file-atomic
 * listens on them during each write, and libuv resets a signal to its default when its last
 * listener goes, after which SIGTERM would kill TET outright — no tabs ended, no update
 * installed. A listener of our own, added before electron installs its handler, keeps libuv from
 * touching the disposition; the quit here is only its fallback.
 */
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => app.quit());
}
