import { contextBridge, ipcRenderer, webUtils } from "electron";
import { WINDOW_ARGS, type TETApi, type Unsubscribe } from "../shared/api";
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
    renameWorktree: (worktree, branch) => ipcRenderer.invoke("projects:rename-worktree", worktree, branch),
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
    state: (projectId) => ipcRenderer.invoke("repository:state", projectId),
    refresh: (projectId) => ipcRenderer.invoke("repository:refresh", projectId),
    checkout: (projectId, target) => ipcRenderer.invoke("repository:checkout", projectId, target),
    fetch: (projectId, login) => ipcRenderer.invoke("repository:fetch", projectId, login),
    pull: (projectId, login) => ipcRenderer.invoke("repository:pull", projectId, login),
    push: (projectId, login) => ipcRenderer.invoke("repository:push", projectId, login),
    setRemoteUrl: (projectId, remote, url) => ipcRenderer.invoke("repository:set-remote-url", projectId, remote, url),
    createBranch: (projectId, name, startPoint) =>
      ipcRenderer.invoke("repository:create-branch", projectId, name, startPoint),
    renameBranch: (projectId, from, to) => ipcRenderer.invoke("repository:rename-branch", projectId, from, to),
    deleteBranch: (projectId, name, onRemote) =>
      ipcRenderer.invoke("repository:delete-branch", projectId, name, onRemote),
    deleteRemoteBranch: (projectId, remote, name, login) =>
      ipcRenderer.invoke("repository:delete-remote-branch", projectId, remote, name, login),
    merge: (projectId, ref) => ipcRenderer.invoke("repository:merge", projectId, ref),
    rebase: (projectId, ref, confirmed) => ipcRenderer.invoke("repository:rebase", projectId, ref, confirmed),
    abort: (projectId) => ipcRenderer.invoke("repository:abort", projectId),
    createTag: (projectId, name, target, message) =>
      ipcRenderer.invoke("repository:create-tag", projectId, name, target, message),
    pushTag: (projectId, name, login) => ipcRenderer.invoke("repository:push-tag", projectId, name, login),
    deleteTag: (projectId, name, onRemote) => ipcRenderer.invoke("repository:delete-tag", projectId, name, onRemote),
    deleteRemoteTag: (projectId, name, login) => ipcRenderer.invoke("repository:delete-remote-tag", projectId, name, login),
    checkoutTag: (projectId, name) => ipcRenderer.invoke("repository:checkout-tag", projectId, name),
    commitAll: (projectId, message) => ipcRenderer.invoke("repository:commit-all", projectId, message),
    commitPaths: (projectId, message, paths) => ipcRenderer.invoke("repository:commit-paths", projectId, message, paths),
    suggestCommitMessage: (projectId, paths) => ipcRenderer.invoke("repository:suggest-commit-message", projectId, paths),
    stashPush: (projectId, message) => ipcRenderer.invoke("repository:stash-push", projectId, message),
    stash: (projectId, command, sha) => ipcRenderer.invoke("repository:stash", projectId, command, sha),
    discard: (projectId, paths, permanently) => ipcRenderer.invoke("repository:discard", projectId, paths, permanently),
    ignore: (projectId, filePath, scope) => ipcRenderer.invoke("repository:ignore", projectId, filePath, scope),
    createFile: (projectId, filePath) => ipcRenderer.invoke("repository:create-file", projectId, filePath),
    createDirectory: (projectId, dirPath) => ipcRenderer.invoke("repository:create-directory", projectId, dirPath),
    deletePath: (projectId, filePath) => ipcRenderer.invoke("repository:delete-path", projectId, filePath),
    renamePath: (projectId, fromPath, toPath) => ipcRenderer.invoke("repository:rename-path", projectId, fromPath, toPath),
    addFolder: (projectId, folderPath) => ipcRenderer.invoke("repository:add-folder", projectId, folderPath),
    removeFolder: (projectId, folderPath) => ipcRenderer.invoke("repository:remove-folder", projectId, folderPath),
    excludePath: (projectId, relPath) => ipcRenderer.invoke("repository:exclude-path", projectId, relPath),
    setExplorerSetting: (projectId, key, value) =>
      ipcRenderer.invoke("repository:set-explorer-setting", projectId, key, value),
    listExplorer: (projectId) => ipcRenderer.invoke("repository:list-explorer", projectId),
    searchFiles: (projectId, query) => ipcRenderer.invoke("repository:search-files", projectId, query),
    explorerSettings: (projectId) => ipcRenderer.invoke("repository:explorer-settings", projectId),
    readFile: (projectId, filePath) => ipcRenderer.invoke("repository:read-file", projectId, filePath),
    writeFile: (projectId, filePath, content, expectedMtimeMs) =>
      ipcRenderer.invoke("repository:write-file", projectId, filePath, content, expectedMtimeMs),
    onState: (listener) => subscribe("repository:state-changed", listener),
    onFilesChanged: (listener) => subscribe("repository:files-changed", listener),
    watchFiles: (projectId, paths) => ipcRenderer.invoke("repository:watch-files", projectId, paths),
    onFileChanged: (listener) => subscribe("repository:file-changed", listener),
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
    list: (projectId) => ipcRenderer.invoke("terminals:list", projectId),
    create: (projectId, agentId) => ipcRenderer.invoke("terminals:create", projectId, agentId),
    close: (projectId, tabIds) => ipcRenderer.invoke("terminals:close", projectId, tabIds),
    rename: (projectId, tabId, title) => ipcRenderer.invoke("terminals:rename", projectId, tabId, title),
    restart: (projectId, tabId) => ipcRenderer.invoke("terminals:restart", projectId, tabId),
    seen: (projectId, tabId) => ipcRenderer.send("terminals:seen", projectId, tabId),
    inFront: (projectId, tabIds) => ipcRenderer.send("terminals:in-front", projectId, tabIds),
    input: (projectId, tabId, data) => ipcRenderer.send("terminals:input", projectId, tabId, data),
    resize: (projectId, tabId, cols, rows) => ipcRenderer.send("terminals:resize", projectId, tabId, cols, rows),
    resolveUrl: (projectId, tabId, fragment) =>
      ipcRenderer.invoke("terminals:resolve-url", projectId, tabId, fragment),
    onTabs: (listener) => subscribe("terminals:tabs", listener),
    onOutput: (listener) => subscribe("terminals:output", listener),
    onStatus: (listener) => subscribe("terminals:status", listener),
    onStartupProgress: (listener) => subscribe("terminals:startup-progress", listener),
    onShow: (listener) => subscribe("terminals:show", listener),
    starting: (projectId) => ipcRenderer.invoke("terminals:starting", projectId)
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
