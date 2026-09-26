import { contextBridge, ipcRenderer, webUtils } from "electron";
import { WINDOW_ARGS, type TETApi, type Unsubscribe } from "../shared/api";
import type { ProjectRef } from "../shared/types";
import { DEFAULT_THEME_IDS } from "../shared/themes";

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const initialTheme =
  process.argv.find((arg) => arg.startsWith(WINDOW_ARGS.theme))?.slice(WINDOW_ARGS.theme.length) || DEFAULT_THEME_IDS.dark;
const waylandSession = process.argv.includes(WINDOW_ARGS.wayland);

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
    signedInUser: () => ipcRenderer.invoke("sbx:signed-in-user"),
    accounts: () => ipcRenderer.invoke("sbx:accounts"),
    signIn: (user, token, accountId) => ipcRenderer.invoke("sbx:sign-in", user, token, accountId),
    logout: () => ipcRenderer.invoke("sbx:logout"),
    saveAccounts: (edits) => ipcRenderer.invoke("sbx:save-accounts", edits),
    initPolicy: () => ipcRenderer.invoke("sbx:init-policy"),
    cancelSetup: () => ipcRenderer.send("sbx:cancel-setup"),
    getConfig: (projectId) => ipcRenderer.invoke("sbx:get-config", projectId),
    stored: (projectId) => ipcRenderer.invoke("sbx:stored", projectId),
    knowledgeSources: () => ipcRenderer.invoke("sbx:knowledge-sources"),
    saveConfig: (projectId, request, local) => ipcRenderer.invoke("sbx:save-config", projectId, request, local),
    problems: (projectId, config, knowledge, values) => ipcRenderer.invoke("sbx:problems", projectId, config, knowledge, values)
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
    open: (directory) => ipcRenderer.invoke("projects:open", directory),
    clone: (url, directory, name, accountId, login) =>
      ipcRenderer.invoke("projects:clone", url, directory, name, accountId, login),
    create: (directory, name) => ipcRenderer.invoke("projects:create", directory, name),
    remove: (projectId) => ipcRenderer.invoke("projects:remove", projectId),
    addWorktree: (projectId, branch) => ipcRenderer.invoke("projects:add-worktree", projectId, branch),
    deleteWorktree: (worktree, options) => ipcRenderer.invoke("projects:delete-worktree", worktree, options),
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
    state: (ref) => ipcRenderer.invoke("repository:state", ref),
    refresh: (ref) => ipcRenderer.invoke("repository:refresh", ref),
    checkout: (ref, target) => ipcRenderer.invoke("repository:checkout", ref, target),
    fetch: (ref, login) => ipcRenderer.invoke("repository:fetch", ref, login),
    pull: (ref, login) => ipcRenderer.invoke("repository:pull", ref, login),
    push: (ref, login) => ipcRenderer.invoke("repository:push", ref, login),
    setRemoteUrl: (ref, remote, url) => ipcRenderer.invoke("repository:set-remote-url", ref, remote, url),
    createBranch: (ref, name, startPoint) =>
      ipcRenderer.invoke("repository:create-branch", ref, name, startPoint),
    renameBranch: (ref, from, to) => ipcRenderer.invoke("repository:rename-branch", ref, from, to),
    deleteBranch: (ref, name, onRemote) =>
      ipcRenderer.invoke("repository:delete-branch", ref, name, onRemote),
    deleteRemoteBranch: (ref, remote, name, login) =>
      ipcRenderer.invoke("repository:delete-remote-branch", ref, remote, name, login),
    merge: (ref, gitRef) => ipcRenderer.invoke("repository:merge", ref, gitRef),
    rebase: (ref, gitRef, confirmed) => ipcRenderer.invoke("repository:rebase", ref, gitRef, confirmed),
    abort: (ref) => ipcRenderer.invoke("repository:abort", ref),
    createTag: (ref, name, target, message) =>
      ipcRenderer.invoke("repository:create-tag", ref, name, target, message),
    pushTag: (ref, name, login) => ipcRenderer.invoke("repository:push-tag", ref, name, login),
    deleteTag: (ref, name, onRemote) => ipcRenderer.invoke("repository:delete-tag", ref, name, onRemote),
    deleteRemoteTag: (ref, name, login) => ipcRenderer.invoke("repository:delete-remote-tag", ref, name, login),
    checkoutTag: (ref, name) => ipcRenderer.invoke("repository:checkout-tag", ref, name),
    commitAll: (ref, message) => ipcRenderer.invoke("repository:commit-all", ref, message),
    commitPaths: (ref, message, paths) => ipcRenderer.invoke("repository:commit-paths", ref, message, paths),
    suggestCommitMessage: (ref, paths) => ipcRenderer.invoke("repository:suggest-commit-message", ref, paths),
    stashPush: (ref, message) => ipcRenderer.invoke("repository:stash-push", ref, message),
    stash: (ref, command, sha) => ipcRenderer.invoke("repository:stash", ref, command, sha),
    discard: (ref, paths, permanently) => ipcRenderer.invoke("repository:discard", ref, paths, permanently),
    ignore: (ref, filePath, scope) => ipcRenderer.invoke("repository:ignore", ref, filePath, scope),
    createFile: (ref, filePath) => ipcRenderer.invoke("repository:create-file", ref, filePath),
    createDirectory: (ref, dirPath) => ipcRenderer.invoke("repository:create-directory", ref, dirPath),
    deletePath: (ref, filePath) => ipcRenderer.invoke("repository:delete-path", ref, filePath),
    renamePath: (ref, fromPath, toPath) => ipcRenderer.invoke("repository:rename-path", ref, fromPath, toPath),
    addFolder: (projectId, folderPath) => ipcRenderer.invoke("repository:add-folder", projectId, folderPath),
    removeFolder: (projectId, folderPath) => ipcRenderer.invoke("repository:remove-folder", projectId, folderPath),
    excludePath: (projectId, relPath) => ipcRenderer.invoke("repository:exclude-path", projectId, relPath),
    setExplorerSetting: (projectId, key, value) =>
      ipcRenderer.invoke("repository:set-explorer-setting", projectId, key, value),
    listExplorer: (ref) => ipcRenderer.invoke("repository:list-explorer", ref),
    searchFiles: (ref, query) => ipcRenderer.invoke("repository:search-files", ref, query),
    explorerSettings: (projectId) => ipcRenderer.invoke("repository:explorer-settings", projectId),
    readFile: (ref, filePath) => ipcRenderer.invoke("repository:read-file", ref, filePath),
    writeFile: (ref, filePath, content, expectedMtimeMs) =>
      ipcRenderer.invoke("repository:write-file", ref, filePath, content, expectedMtimeMs),
    onState: (listener) => subscribe("repository:state-changed", listener),
    onFilesChanged: (listener) => subscribe("repository:files-changed", listener),
    watchFiles: (ref, paths) => ipcRenderer.invoke("repository:watch-files", ref, paths),
    onFileChanged: (listener) => subscribe("repository:file-changed", listener),
    reportEditor: (ref, tabId, report) => ipcRenderer.send("editor:report", ref, tabId, report),
    reportActiveEditor: (ref, tabId) => ipcRenderer.send("editor:active", ref, tabId),
    onEditorContentRequest: (listener) =>
      subscribe<{ ref: ProjectRef; reply: string }>("editor:content-request", ({ ref, reply }) =>
        ipcRenderer.send(reply, listener(ref))
      ),
    onOpenEditor: (listener) => subscribe("editor:open", listener)
  },
  commands: {
    list: (projectId) => ipcRenderer.invoke("commands:list", projectId),
    save: (projectId, commands) => ipcRenderer.invoke("commands:save", projectId, commands),
    run: (ref, command) => ipcRenderer.invoke("commands:run", ref, command),
    onChanged: (listener) => subscribe("commands:changed", listener)
  },
  terminals: {
    list: (ref) => ipcRenderer.invoke("terminals:list", ref),
    create: (ref, agentId) => ipcRenderer.invoke("terminals:create", ref, agentId),
    close: (ref, tabIds) => ipcRenderer.invoke("terminals:close", ref, tabIds),
    rename: (ref, tabId, title) => ipcRenderer.invoke("terminals:rename", ref, tabId, title),
    restart: (ref, tabId) => ipcRenderer.invoke("terminals:restart", ref, tabId),
    seen: (ref, tabId) => ipcRenderer.send("terminals:seen", ref, tabId),
    inFront: (ref, tabIds) => ipcRenderer.send("terminals:in-front", ref, tabIds),
    input: (ref, tabId, data) => ipcRenderer.send("terminals:input", ref, tabId, data),
    resize: (ref, tabId, cols, rows) => ipcRenderer.send("terminals:resize", ref, tabId, cols, rows),
    onTabs: (listener) => subscribe("terminals:tabs", listener),
    onOutput: (listener) => subscribe("terminals:output", listener),
    onStatus: (listener) => subscribe("terminals:status", listener),
    onStartupProgress: (listener) => subscribe("terminals:startup-progress", listener),
    onShow: (listener) => subscribe("terminals:show", listener),
    starting: (ref) => ipcRenderer.invoke("terminals:starting", ref)
  },
  agents: {
    list: () => ipcRenderer.invoke("agents:list")
  },
  files: {
    // Replaces File.path (gone since Electron 32); preload-only under contextIsolation.
    pathOf: (file) => webUtils.getPathForFile(file),
    writeTemp: (name, dataBase64) => ipcRenderer.invoke("files:write-temp", name, dataBase64),
    clipboardImage: () => ipcRenderer.invoke("files:clipboard-image")
  },
  shell: {
    openUrl: (url) => ipcRenderer.invoke("shell:open-url", url),
    fetchImage: (url) => ipcRenderer.invoke("shell:fetch-image", url),
    openFile: (ref, filePath) => ipcRenderer.invoke("shell:open-file", ref, filePath),
    revealFile: (ref, filePath) => ipcRenderer.invoke("shell:reveal-file", ref, filePath),
    openFileExternally: (ref, filePath) =>
      ipcRenderer.invoke("shell:open-file-externally", ref, filePath),
    openProject: (ref) => ipcRenderer.invoke("shell:open-project", ref)
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
