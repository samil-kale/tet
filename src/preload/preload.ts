import { contextBridge, ipcRenderer, webUtils } from "electron";
import { WINDOW_ARGS, type TETApi, type Unsubscribe } from "../shared/api";
import type { EventChannels, InvokeChannels, SendChannels } from "../shared/ipc";
import { DEFAULT_THEME_IDS } from "../shared/themes";

// The window's side of `src/shared/ipc.ts`; main's is `src/main/ipc/channels.ts`.
function invoke<C extends keyof InvokeChannels>(
  channel: C,
  ...args: Parameters<InvokeChannels[C]>
): ReturnType<InvokeChannels[C]> {
  return ipcRenderer.invoke(channel, ...args) as ReturnType<InvokeChannels[C]>;
}

function send<C extends keyof SendChannels>(channel: C, ...args: Parameters<SendChannels[C]>): void {
  ipcRenderer.send(channel, ...args);
}

function subscribe<C extends keyof EventChannels>(
  channel: C,
  listener: (payload: EventChannels[C]) => void
): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: EventChannels[C]): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const initialTheme =
  process.argv.find((arg) => arg.startsWith(WINDOW_ARGS.theme))?.slice(WINDOW_ARGS.theme.length) || DEFAULT_THEME_IDS.dark;
const waylandSession = process.argv.includes(WINDOW_ARGS.wayland);

const api: TETApi = {
  startup: {
    check: () => invoke("startup:check"),
    anyAgentInstalled: () => invoke("startup:any-agent-installed"),
    quit: () => send("startup:quit")
  },
  app: {
    info: () => invoke("app:info"),
    reportNotice: (report) => send("app:notice-shown", report),
    restart: () => send("app:restart")
  },
  sbx: {
    status: (projectId: string) => invoke("sbx:status", projectId),
    login: () => invoke("sbx:login"),
    signedInUser: () => invoke("sbx:signed-in-user"),
    accounts: () => invoke("sbx:accounts"),
    signIn: (user, token, accountId) => invoke("sbx:sign-in", user, token, accountId),
    logout: () => invoke("sbx:logout"),
    saveAccounts: (edits) => invoke("sbx:save-accounts", edits),
    initPolicy: () => invoke("sbx:init-policy"),
    cancelSetup: () => send("sbx:cancel-setup"),
    getConfig: (projectId) => invoke("sbx:get-config", projectId),
    stored: (projectId) => invoke("sbx:stored", projectId),
    knowledgeSources: () => invoke("sbx:knowledge-sources"),
    saveConfig: (projectId, request, local) => invoke("sbx:save-config", projectId, request, local),
    problems: (projectId, config, knowledge, values, status) =>
      invoke("sbx:problems", projectId, config, knowledge, values, status)
  },
  settings: {
    get: () => invoke("settings:get"),
    patch: (edits) => invoke("settings:patch", edits)
  },
  projects: {
    list: () => invoke("projects:list"),
    pickDirectory: (title, defaultPath) => invoke("projects:pick-directory", title, defaultPath),
    pickFile: (title) => invoke("projects:pick-file", title),
    directoryToRemember: (directory) => invoke("projects:directory-to-remember", directory),
    open: (directory) => invoke("projects:open", directory),
    clone: (url, directory, name, accountId, login) =>
      invoke("projects:clone", url, directory, name, accountId, login),
    create: (directory, name) => invoke("projects:create", directory, name),
    initialize: (directory) => invoke("projects:initialize", directory),
    remove: (projectId) => invoke("projects:remove", projectId),
    addWorktree: (projectId, branch) => invoke("projects:add-worktree", projectId, branch),
    deleteWorktree: (worktree, options) => invoke("projects:delete-worktree", worktree, options),
    reorder: (projectIds) => invoke("projects:reorder", projectIds),
    onChanged: (listener) => subscribe("projects:changed", listener)
  },
  providers: {
    accounts: () => invoke("providers:accounts"),
    addAccount: (provider, host, token) => invoke("providers:add-account", provider, host, token),
    removeAccount: (accountId) => invoke("providers:remove-account", accountId),
    setNamespace: (accountId, namespace) => invoke("providers:set-namespace", accountId, namespace),
    repos: (accountId) => invoke("providers:repos", accountId)
  },
  environment: {
    list: () => invoke("environment:list"),
    save: (rows) => invoke("environment:save", rows),
    answer: (id, answer) => invoke("environment:answer", id, answer),
    onRequest: (listener) => subscribe("environment:request", listener),
    onWithdrawn: (listener) => subscribe("environment:withdrawn", listener)
  },
  repository: {
    state: (ref) => invoke("repository:state", ref),
    refresh: (ref) => invoke("repository:refresh", ref),
    checkout: (ref, target) => invoke("repository:checkout", ref, target),
    fetch: (ref, login) => invoke("repository:fetch", ref, login),
    pull: (ref, login) => invoke("repository:pull", ref, login),
    push: (ref, login) => invoke("repository:push", ref, login),
    setRemoteUrl: (ref, remote, url) => invoke("repository:set-remote-url", ref, remote, url),
    createBranch: (ref, name, startPoint) =>
      invoke("repository:create-branch", ref, name, startPoint),
    renameBranch: (ref, from, to) => invoke("repository:rename-branch", ref, from, to),
    deleteBranch: (ref, name, onRemote) =>
      invoke("repository:delete-branch", ref, name, onRemote),
    deleteRemoteBranch: (ref, remote, name, login) =>
      invoke("repository:delete-remote-branch", ref, remote, name, login),
    merge: (ref, gitRef) => invoke("repository:merge", ref, gitRef),
    rebase: (ref, gitRef, confirmed) => invoke("repository:rebase", ref, gitRef, confirmed),
    abort: (ref) => invoke("repository:abort", ref),
    createTag: (ref, name, target, message) =>
      invoke("repository:create-tag", ref, name, target, message),
    pushTag: (ref, name, login) => invoke("repository:push-tag", ref, name, login),
    deleteTag: (ref, name, onRemote) => invoke("repository:delete-tag", ref, name, onRemote),
    deleteRemoteTag: (ref, name, login) => invoke("repository:delete-remote-tag", ref, name, login),
    checkoutTag: (ref, name) => invoke("repository:checkout-tag", ref, name),
    commitAll: (ref, message) => invoke("repository:commit-all", ref, message),
    commitPaths: (ref, message, paths) => invoke("repository:commit-paths", ref, message, paths),
    suggestionAgents: (ref) => invoke("repository:suggestion-agents", ref),
    suggestionModels: (ref, agentId) => invoke("repository:suggestion-models", ref, agentId),
    suggestCommitMessage: (ref, paths) => invoke("repository:suggest-commit-message", ref, paths),
    cancelCommitSuggestion: () => send("repository:cancel-commit-suggestion"),
    stashPush: (ref, message) => invoke("repository:stash-push", ref, message),
    stash: (ref, command, sha) => invoke("repository:stash", ref, command, sha),
    discard: (ref, paths, permanently) => invoke("repository:discard", ref, paths, permanently),
    ignore: (ref, filePath, scope) => invoke("repository:ignore", ref, filePath, scope),
    createFile: (ref, filePath) => invoke("repository:create-file", ref, filePath),
    createDirectory: (ref, dirPath) => invoke("repository:create-directory", ref, dirPath),
    deletePath: (ref, filePath) => invoke("repository:delete-path", ref, filePath),
    renamePath: (ref, fromPath, toPath) => invoke("repository:rename-path", ref, fromPath, toPath),
    addFolder: (projectId, folderPath) => invoke("repository:add-folder", projectId, folderPath),
    removeFolder: (projectId, folderPath) => invoke("repository:remove-folder", projectId, folderPath),
    excludePath: (projectId, relPath) => invoke("repository:exclude-path", projectId, relPath),
    setExplorerSetting: (projectId, key, value) =>
      invoke("repository:set-explorer-setting", projectId, key, value),
    listExplorer: (ref) => invoke("repository:list-explorer", ref),
    searchFiles: (ref, query) => invoke("repository:search-files", ref, query),
    explorerSettings: (projectId) => invoke("repository:explorer-settings", projectId),
    readFile: (ref, filePath) => invoke("repository:read-file", ref, filePath),
    writeFile: (ref, filePath, content, expectedMtimeMs) =>
      invoke("repository:write-file", ref, filePath, content, expectedMtimeMs),
    onState: (listener) => subscribe("repository:state-changed", listener),
    onFilesChanged: (listener) => subscribe("repository:files-changed", listener),
    watchFiles: (ref, paths) => invoke("repository:watch-files", ref, paths),
    onFileChanged: (listener) => subscribe("repository:file-changed", listener),
    reportEditor: (ref, tabId, report) => send("editor:report", ref, tabId, report),
    reportActiveEditor: (ref, tabId) => send("editor:active", ref, tabId),
    onEditorContentRequest: (listener) =>
      subscribe("editor:content-request", ({ ref, reply }) =>
        send(reply, listener(ref))
      ),
    onOpenEditor: (listener) => subscribe("editor:open", listener)
  },
  commands: {
    list: (projectId) => invoke("commands:list", projectId),
    save: (projectId, commands) => invoke("commands:save", projectId, commands),
    run: (ref, command) => invoke("commands:run", ref, command),
    onChanged: (listener) => subscribe("commands:changed", listener)
  },
  terminals: {
    list: (ref) => invoke("terminals:list", ref),
    create: (ref, agentId) => invoke("terminals:create", ref, agentId),
    close: (ref, tabIds) => invoke("terminals:close", ref, tabIds),
    rename: (ref, tabId, title) => invoke("terminals:rename", ref, tabId, title),
    handOff: (ref, tabId, agentId) => invoke("terminals:handoff", ref, tabId, agentId),
    restart: (ref, tabId) => invoke("terminals:restart", ref, tabId),
    seen: (ref, tabId) => send("terminals:seen", ref, tabId),
    inFront: (ref, tabIds) => send("terminals:in-front", ref, tabIds),
    input: (ref, tabId, data) => send("terminals:input", ref, tabId, data),
    resize: (ref, tabId, cols, rows) => send("terminals:resize", ref, tabId, cols, rows),
    onTabs: (listener) => subscribe("terminals:tabs", listener),
    onOutput: (listener) => subscribe("terminals:output", listener),
    onStatus: (listener) => subscribe("terminals:status", listener),
    onStartupProgress: (listener) => subscribe("terminals:startup-progress", listener),
    onShow: (listener) => subscribe("terminals:show", listener),
    onTextRequest: (listener) =>
      subscribe("terminals:text-request", ({ ref, tabId, reply }) => {
        void listener(ref, tabId).then((text) => send(reply, text));
      }),
    starting: (ref) => invoke("terminals:starting", ref)
  },
  agents: {
    list: () => invoke("agents:list")
  },
  files: {
    // The file's path, which the renderer cannot read; preload-only under contextIsolation.
    pathOf: (file) => webUtils.getPathForFile(file),
    writeDrop: (ref, tabId, name, dataBase64) => invoke("files:write-drop", ref, tabId, name, dataBase64),
    clipboardImage: (ref, tabId) => invoke("files:clipboard-image", ref, tabId),
    handPaths: (ref, tabId, paths) => invoke("files:hand-paths", ref, tabId, paths)
  },
  shell: {
    openUrl: (url) => invoke("shell:open-url", url),
    fetchImage: (url) => invoke("shell:fetch-image", url),
    openFile: (ref, filePath) => invoke("shell:open-file", ref, filePath),
    revealFile: (ref, filePath) => invoke("shell:reveal-file", ref, filePath),
    openFileExternally: (ref, filePath) =>
      invoke("shell:open-file-externally", ref, filePath),
    openProject: (ref) => invoke("shell:open-project", ref)
  },
  // Lets main release the notices it held back (`send` in window.ts).
  onNotice: (listener) => {
    const unsubscribe = subscribe("app:notice", listener);
    send("app:notice-listening");
    return unsubscribe;
  },
  onNoticeProgress: (listener) => subscribe("app:notice-progress", listener),
  initialTheme,
  onTheme: (listener) => subscribe("app:theme", listener),
  waylandSession
};

contextBridge.exposeInMainWorld("tet", api);
