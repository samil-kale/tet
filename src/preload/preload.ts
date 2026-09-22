import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { TETApi, Unsubscribe } from "../shared/api";
import { DEFAULT_THEME_IDS } from "../shared/themes";

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

/** From main.ts's createWindow, through webPreferences.additionalArguments. */
const THEME_ARG = "--tet-theme=";
const initialTheme = process.argv.find((arg) => arg.startsWith(THEME_ARG))?.slice(THEME_ARG.length) || DEFAULT_THEME_IDS.dark;
const waylandSession = process.argv.includes("--tet-wayland");

const api: TETApi = {
  startup: {
    check: () => ipcRenderer.invoke("startup:check"),
    anyAgentInstalled: () => ipcRenderer.invoke("startup:any-agent-installed"),
    quit: () => ipcRenderer.send("startup:quit")
  },
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    reportLongTask: (ms, context) => ipcRenderer.send("app:long-task", ms, context),
    reportSlow: (label, ms) => ipcRenderer.send("app:slow", label, ms),
    reportNotice: (report) => ipcRenderer.send("app:notice-shown", report),
    restart: () => ipcRenderer.send("app:restart")
  },
  sbx: {
    status: (projectId: string) => ipcRenderer.invoke("sbx:status", projectId),
    login: () => ipcRenderer.invoke("sbx:login"),
    initPolicy: () => ipcRenderer.invoke("sbx:init-policy"),
    cancelSetup: () => ipcRenderer.send("sbx:cancel-setup"),
    getConfig: (projectId) => ipcRenderer.invoke("sbx:get-config", projectId),
    stored: (projectId) => ipcRenderer.invoke("sbx:stored", projectId),
    saveConfig: (projectId, request, local) => ipcRenderer.invoke("sbx:save-config", projectId, request, local),
    mountsAllowed: (paths) => ipcRenderer.invoke("sbx:mounts-allowed", paths),
    hostAllowed: (host) => ipcRenderer.invoke("sbx:host-allowed", host)
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    patch: (edits) => ipcRenderer.invoke("settings:patch", edits)
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    pickDirectory: (title, defaultPath) => ipcRenderer.invoke("projects:pick-directory", title, defaultPath),
    pickFile: (title) => ipcRenderer.invoke("projects:pick-file", title),
    directoryToRemember: (directory) => ipcRenderer.invoke("projects:directory-to-remember", directory),
    open: (directory) => ipcRenderer.invoke("projects:open-path", directory),
    clone: (url, directory, name, accountId) => ipcRenderer.invoke("projects:clone", url, directory, name, accountId),
    create: (directory, name) => ipcRenderer.invoke("projects:create", directory, name),
    remove: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
    addWorktree: (projectId, branch) => ipcRenderer.invoke("projects:worktree-add", projectId, branch),
    deleteWorktree: (worktree, options) => ipcRenderer.invoke("projects:worktree-delete", worktree, options),
    renameWorktree: (worktree, branch) => ipcRenderer.invoke("projects:worktree-rename", worktree, branch),
    reorder: (projectIds) => ipcRenderer.invoke("projects:reorder", projectIds),
    onChanged: (listener) => subscribe("projects:changed", listener)
  },
  providers: {
    accounts: () => ipcRenderer.invoke("providers:accounts"),
    addAccount: (provider, host, token) => ipcRenderer.invoke("providers:add-account", provider, host, token),
    removeAccount: (accountId) => ipcRenderer.invoke("providers:remove-account", accountId),
    setNamespace: (accountId, namespace) => ipcRenderer.invoke("providers:set-namespace", accountId, namespace),
    repos: (accountId) => ipcRenderer.invoke("providers:repos", accountId)
  },
  environment: {
    list: () => ipcRenderer.invoke("environment:list"),
    save: (rows) => ipcRenderer.invoke("environment:save", rows),
    answer: (id, answer) => ipcRenderer.invoke("environment:answer", id, answer),
    onRequest: (listener) => subscribe("environment:request", listener),
    onWithdrawn: (listener) => subscribe("environment:withdrawn", listener)
  },
  repository: {
    state: (projectId) => ipcRenderer.invoke("repo:state", projectId),
    refresh: (projectId) => ipcRenderer.invoke("repo:refresh", projectId),
    checkout: (projectId, target) => ipcRenderer.invoke("repo:checkout", projectId, target),
    fetch: (projectId) => ipcRenderer.invoke("repo:fetch", projectId),
    pull: (projectId) => ipcRenderer.invoke("repo:pull", projectId),
    push: (projectId) => ipcRenderer.invoke("repo:push", projectId),
    setRemoteUrl: (projectId, remote, url) => ipcRenderer.invoke("repo:set-remote-url", projectId, remote, url),
    createBranch: (projectId, name, startPoint) =>
      ipcRenderer.invoke("repo:create-branch", projectId, name, startPoint),
    renameBranch: (projectId, from, to) => ipcRenderer.invoke("repo:rename-branch", projectId, from, to),
    deleteBranch: (projectId, name, onRemote) =>
      ipcRenderer.invoke("repo:delete-branch", projectId, name, onRemote),
    deleteRemoteBranch: (projectId, remote, name) =>
      ipcRenderer.invoke("repo:delete-remote-branch", projectId, remote, name),
    merge: (projectId, ref) => ipcRenderer.invoke("repo:merge", projectId, ref),
    rebase: (projectId, ref, confirmed) => ipcRenderer.invoke("repo:rebase", projectId, ref, confirmed),
    abort: (projectId) => ipcRenderer.invoke("repo:abort", projectId),
    createTag: (projectId, name, target, message) =>
      ipcRenderer.invoke("repo:create-tag", projectId, name, target, message),
    pushTag: (projectId, name) => ipcRenderer.invoke("repo:push-tag", projectId, name),
    deleteTag: (projectId, name, onRemote) => ipcRenderer.invoke("repo:delete-tag", projectId, name, onRemote),
    checkoutTag: (projectId, name) => ipcRenderer.invoke("repo:checkout-tag", projectId, name),
    commitAll: (projectId, message) => ipcRenderer.invoke("repo:commit-all", projectId, message),
    commitPaths: (projectId, message, paths) => ipcRenderer.invoke("repo:commit-paths", projectId, message, paths),
    suggestCommitMessage: (projectId, paths) => ipcRenderer.invoke("repo:suggest-commit-message", projectId, paths),
    stashPush: (projectId, message) => ipcRenderer.invoke("repo:stash-push", projectId, message),
    stash: (projectId, command, sha) => ipcRenderer.invoke("repo:stash", projectId, command, sha),
    discard: (projectId, paths, permanently) => ipcRenderer.invoke("repo:discard", projectId, paths, permanently),
    ignore: (projectId, filePath, scope) => ipcRenderer.invoke("repo:ignore", projectId, filePath, scope),
    createFile: (projectId, filePath) => ipcRenderer.invoke("repo:create-file", projectId, filePath),
    createDirectory: (projectId, dirPath) => ipcRenderer.invoke("repo:create-directory", projectId, dirPath),
    deletePath: (projectId, filePath) => ipcRenderer.invoke("repo:delete-path", projectId, filePath),
    renamePath: (projectId, fromPath, toPath) => ipcRenderer.invoke("repo:rename-path", projectId, fromPath, toPath),
    addFolder: (projectId, folderPath) => ipcRenderer.invoke("repo:add-folder", projectId, folderPath),
    removeFolder: (projectId, folderPath) => ipcRenderer.invoke("repo:remove-folder", projectId, folderPath),
    excludePath: (projectId, relPath) => ipcRenderer.invoke("repo:exclude-path", projectId, relPath),
    setExplorerSetting: (projectId, key, value) =>
      ipcRenderer.invoke("repo:set-explorer-setting", projectId, key, value),
    listExplorer: (projectId) => ipcRenderer.invoke("repo:explorer", projectId),
    searchFiles: (projectId, query) => ipcRenderer.invoke("repo:search", projectId, query),
    explorerSettings: (projectId) => ipcRenderer.invoke("repo:explorer-settings", projectId),
    readFile: (projectId, filePath) => ipcRenderer.invoke("repo:file-read", projectId, filePath),
    writeFile: (projectId, filePath, content, expectedMtimeMs) =>
      ipcRenderer.invoke("repo:file-write", projectId, filePath, content, expectedMtimeMs),
    onState: (listener) => subscribe("repo:state-changed", listener),
    onFilesChanged: (listener) => subscribe("repo:files-changed", listener),
    watchFiles: (projectId, paths) => ipcRenderer.invoke("repo:watch-files", projectId, paths),
    onFileChanged: (listener) => subscribe("repo:file-changed", listener),
    reportEditor: (projectId, tabId, report) => ipcRenderer.send("editor:report", projectId, tabId, report),
    reportActiveEditor: (projectId, tabId) => ipcRenderer.send("editor:active", projectId, tabId),
    onEditorContentRequest: (listener) =>
      subscribe<{ projectId: string; reply: string }>("editor:content-request", ({ projectId, reply }) =>
        ipcRenderer.send(reply, listener(projectId))
      ),
    onOpenEditor: (listener) => subscribe("editor:open", listener)
  },
  commands: {
    list: (projectId) => ipcRenderer.invoke("commands:list", projectId),
    save: (projectId, commands) => ipcRenderer.invoke("commands:save", projectId, commands),
    run: (projectId, command) => ipcRenderer.invoke("commands:run", projectId, command),
    onChanged: (listener) => subscribe("commands:changed", listener)
  },
  terminals: {
    list: (projectId) => ipcRenderer.invoke("terminal:list", projectId),
    create: (projectId, agentId) => ipcRenderer.invoke("terminal:create", projectId, agentId),
    close: (projectId, tabIds) => ipcRenderer.invoke("terminal:close", projectId, tabIds),
    rename: (projectId, tabId, title) => ipcRenderer.invoke("terminal:rename", projectId, tabId, title),
    restart: (projectId, tabId) => ipcRenderer.invoke("terminal:restart", projectId, tabId),
    seen: (projectId, tabId) => ipcRenderer.send("terminal:seen", projectId, tabId),
    inFront: (projectId, tabIds) => ipcRenderer.send("terminal:in-front", projectId, tabIds),
    input: (projectId, tabId, data) => ipcRenderer.send("terminal:input", projectId, tabId, data),
    resize: (projectId, tabId, cols, rows) => ipcRenderer.send("terminal:resize", projectId, tabId, cols, rows),
    resolveUrl: (projectId, tabId, fragment) =>
      ipcRenderer.invoke("terminal:resolve-url", projectId, tabId, fragment),
    onTabs: (listener) => subscribe("terminal:tabs", listener),
    onOutput: (listener) => subscribe("terminal:output", listener),
    onStatus: (listener) => subscribe("terminal:status", listener),
    onStartupProgress: (listener) => subscribe("terminal:startup-progress", listener),
    onShow: (listener) => subscribe("terminal:show", listener),
    starting: (projectId) => ipcRenderer.invoke("terminal:starting", projectId)
  },
  agents: {
    list: () => ipcRenderer.invoke("agents:list")
  },
  files: {
    // Replaces File.path (gone since Electron 32); preload-only under contextIsolation.
    pathOf: (file) => webUtils.getPathForFile(file),
    writeTemp: (name, dataBase64) => ipcRenderer.invoke("files:write-temp", name, dataBase64),
    clipboardImage: () => ipcRenderer.invoke("clipboard:image-file")
  },
  shell: {
    openUrl: (url) => ipcRenderer.invoke("shell:open-url", url),
    fetchImage: (url) => ipcRenderer.invoke("shell:fetch-image", url),
    openFile: (projectId, filePath) => ipcRenderer.invoke("shell:open-file", projectId, filePath),
    revealFile: (projectId, filePath) => ipcRenderer.invoke("shell:reveal-file", projectId, filePath),
    openFileExternally: (projectId, filePath) =>
      ipcRenderer.invoke("shell:open-file-externally", projectId, filePath),
    openProject: (projectId) => ipcRenderer.invoke("shell:open-project", projectId)
  },
  // Lets main release the notices it held back (`send` in main.ts).
  onNotice: (listener) => {
    const unsubscribe = subscribe("app:notice", listener);
    ipcRenderer.send("app:notice-listening");
    return unsubscribe;
  },
  initialTheme,
  onTheme: (listener) => subscribe("app:theme", listener),
  waylandSession
};

contextBridge.exposeInMainWorld("tet", api);
