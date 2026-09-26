import { contextBridge, ipcRenderer, webUtils } from "electron";
import { WINDOW_ARGS, type TETApi, type Unsubscribe } from "../shared/api";
import type { CheckoutRef } from "../shared/types";
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
    state: (checkout) => ipcRenderer.invoke("repository:state", checkout),
    refresh: (checkout) => ipcRenderer.invoke("repository:refresh", checkout),
    checkout: (checkout, target) => ipcRenderer.invoke("repository:checkout", checkout, target),
    fetch: (checkout, login) => ipcRenderer.invoke("repository:fetch", checkout, login),
    pull: (checkout, login) => ipcRenderer.invoke("repository:pull", checkout, login),
    push: (checkout, login) => ipcRenderer.invoke("repository:push", checkout, login),
    setRemoteUrl: (checkout, remote, url) => ipcRenderer.invoke("repository:set-remote-url", checkout, remote, url),
    createBranch: (checkout, name, startPoint) =>
      ipcRenderer.invoke("repository:create-branch", checkout, name, startPoint),
    renameBranch: (checkout, from, to) => ipcRenderer.invoke("repository:rename-branch", checkout, from, to),
    deleteBranch: (checkout, name, onRemote) =>
      ipcRenderer.invoke("repository:delete-branch", checkout, name, onRemote),
    deleteRemoteBranch: (checkout, remote, name, login) =>
      ipcRenderer.invoke("repository:delete-remote-branch", checkout, remote, name, login),
    merge: (checkout, ref) => ipcRenderer.invoke("repository:merge", checkout, ref),
    rebase: (checkout, ref, confirmed) => ipcRenderer.invoke("repository:rebase", checkout, ref, confirmed),
    abort: (checkout) => ipcRenderer.invoke("repository:abort", checkout),
    createTag: (checkout, name, target, message) =>
      ipcRenderer.invoke("repository:create-tag", checkout, name, target, message),
    pushTag: (checkout, name, login) => ipcRenderer.invoke("repository:push-tag", checkout, name, login),
    deleteTag: (checkout, name, onRemote) => ipcRenderer.invoke("repository:delete-tag", checkout, name, onRemote),
    deleteRemoteTag: (checkout, name, login) => ipcRenderer.invoke("repository:delete-remote-tag", checkout, name, login),
    checkoutTag: (checkout, name) => ipcRenderer.invoke("repository:checkout-tag", checkout, name),
    commitAll: (checkout, message) => ipcRenderer.invoke("repository:commit-all", checkout, message),
    commitPaths: (checkout, message, paths) => ipcRenderer.invoke("repository:commit-paths", checkout, message, paths),
    suggestCommitMessage: (checkout, paths) => ipcRenderer.invoke("repository:suggest-commit-message", checkout, paths),
    stashPush: (checkout, message) => ipcRenderer.invoke("repository:stash-push", checkout, message),
    stash: (checkout, command, sha) => ipcRenderer.invoke("repository:stash", checkout, command, sha),
    discard: (checkout, paths, permanently) => ipcRenderer.invoke("repository:discard", checkout, paths, permanently),
    ignore: (checkout, filePath, scope) => ipcRenderer.invoke("repository:ignore", checkout, filePath, scope),
    createFile: (checkout, filePath) => ipcRenderer.invoke("repository:create-file", checkout, filePath),
    createDirectory: (checkout, dirPath) => ipcRenderer.invoke("repository:create-directory", checkout, dirPath),
    deletePath: (checkout, filePath) => ipcRenderer.invoke("repository:delete-path", checkout, filePath),
    renamePath: (checkout, fromPath, toPath) => ipcRenderer.invoke("repository:rename-path", checkout, fromPath, toPath),
    addFolder: (projectId, folderPath) => ipcRenderer.invoke("repository:add-folder", projectId, folderPath),
    removeFolder: (projectId, folderPath) => ipcRenderer.invoke("repository:remove-folder", projectId, folderPath),
    excludePath: (projectId, relPath) => ipcRenderer.invoke("repository:exclude-path", projectId, relPath),
    setExplorerSetting: (projectId, key, value) =>
      ipcRenderer.invoke("repository:set-explorer-setting", projectId, key, value),
    listExplorer: (checkout) => ipcRenderer.invoke("repository:list-explorer", checkout),
    searchFiles: (checkout, query) => ipcRenderer.invoke("repository:search-files", checkout, query),
    explorerSettings: (projectId) => ipcRenderer.invoke("repository:explorer-settings", projectId),
    readFile: (checkout, filePath) => ipcRenderer.invoke("repository:read-file", checkout, filePath),
    writeFile: (checkout, filePath, content, expectedMtimeMs) =>
      ipcRenderer.invoke("repository:write-file", checkout, filePath, content, expectedMtimeMs),
    onState: (listener) => subscribe("repository:state-changed", listener),
    onFilesChanged: (listener) => subscribe("repository:files-changed", listener),
    watchFiles: (checkout, paths) => ipcRenderer.invoke("repository:watch-files", checkout, paths),
    onFileChanged: (listener) => subscribe("repository:file-changed", listener),
    reportEditor: (checkout, tabId, report) => ipcRenderer.send("editor:report", checkout, tabId, report),
    reportActiveEditor: (checkout, tabId) => ipcRenderer.send("editor:active", checkout, tabId),
    onEditorContentRequest: (listener) =>
      subscribe<{ checkout: CheckoutRef; reply: string }>("editor:content-request", ({ checkout, reply }) =>
        ipcRenderer.send(reply, listener(checkout))
      ),
    onOpenEditor: (listener) => subscribe("editor:open", listener)
  },
  commands: {
    list: (projectId) => ipcRenderer.invoke("commands:list", projectId),
    save: (projectId, commands) => ipcRenderer.invoke("commands:save", projectId, commands),
    run: (checkout, command) => ipcRenderer.invoke("commands:run", checkout, command),
    onChanged: (listener) => subscribe("commands:changed", listener)
  },
  terminals: {
    list: (checkout) => ipcRenderer.invoke("terminals:list", checkout),
    create: (checkout, agentId) => ipcRenderer.invoke("terminals:create", checkout, agentId),
    close: (checkout, tabIds) => ipcRenderer.invoke("terminals:close", checkout, tabIds),
    rename: (checkout, tabId, title) => ipcRenderer.invoke("terminals:rename", checkout, tabId, title),
    restart: (checkout, tabId) => ipcRenderer.invoke("terminals:restart", checkout, tabId),
    seen: (checkout, tabId) => ipcRenderer.send("terminals:seen", checkout, tabId),
    inFront: (checkout, tabIds) => ipcRenderer.send("terminals:in-front", checkout, tabIds),
    input: (checkout, tabId, data) => ipcRenderer.send("terminals:input", checkout, tabId, data),
    resize: (checkout, tabId, cols, rows) => ipcRenderer.send("terminals:resize", checkout, tabId, cols, rows),
    resolveUrl: (checkout, tabId, fragment) =>
      ipcRenderer.invoke("terminals:resolve-url", checkout, tabId, fragment),
    onTabs: (listener) => subscribe("terminals:tabs", listener),
    onOutput: (listener) => subscribe("terminals:output", listener),
    onStatus: (listener) => subscribe("terminals:status", listener),
    onStartupProgress: (listener) => subscribe("terminals:startup-progress", listener),
    onShow: (listener) => subscribe("terminals:show", listener),
    starting: (checkout) => ipcRenderer.invoke("terminals:starting", checkout)
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
    openFile: (checkout, filePath) => ipcRenderer.invoke("shell:open-file", checkout, filePath),
    revealFile: (checkout, filePath) => ipcRenderer.invoke("shell:reveal-file", checkout, filePath),
    openFileExternally: (checkout, filePath) =>
      ipcRenderer.invoke("shell:open-file-externally", checkout, filePath),
    openProject: (checkout) => ipcRenderer.invoke("shell:open-project", checkout)
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
