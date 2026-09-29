import type { TETApi, Unsubscribe } from "./api";
import type { ProjectRef } from "./types";

/**
 * Every channel between the window and the main process, typed off `TETApi` (`api.ts`): the
 * preload and `src/main/ipc/channels.ts` take channels only from here, so a name, an argument or an
 * answer that differs between the two sides fails to compile.
 */

/** The payload a `TETApi` subscription hands its listener. */
type Payload<S> = S extends (listener: (payload: infer P) => unknown) => Unsubscribe ? P : never;

/** The channel `editor-state`'s answer comes back on, one per request (main.ts's editorContent). */
export type EditorContentReply = `editor:content:${number}`;

/** Renderer to main, answered: `invoke` and `handle`. */
export interface InvokeChannels {
  "startup:check": TETApi["startup"]["check"];
  "startup:any-agent-installed": TETApi["startup"]["anyAgentInstalled"];
  "app:info": TETApi["app"]["info"];
  "sbx:status": TETApi["sbx"]["status"];
  "sbx:login": TETApi["sbx"]["login"];
  "sbx:signed-in-user": TETApi["sbx"]["signedInUser"];
  "sbx:accounts": TETApi["sbx"]["accounts"];
  "sbx:sign-in": TETApi["sbx"]["signIn"];
  "sbx:logout": TETApi["sbx"]["logout"];
  "sbx:save-accounts": TETApi["sbx"]["saveAccounts"];
  "sbx:init-policy": TETApi["sbx"]["initPolicy"];
  "sbx:get-config": TETApi["sbx"]["getConfig"];
  "sbx:stored": TETApi["sbx"]["stored"];
  "sbx:knowledge-sources": TETApi["sbx"]["knowledgeSources"];
  "sbx:save-config": TETApi["sbx"]["saveConfig"];
  "sbx:problems": TETApi["sbx"]["problems"];
  "settings:get": TETApi["settings"]["get"];
  "settings:patch": TETApi["settings"]["patch"];
  "projects:list": TETApi["projects"]["list"];
  "projects:pick-directory": TETApi["projects"]["pickDirectory"];
  "projects:pick-file": TETApi["projects"]["pickFile"];
  "projects:directory-to-remember": TETApi["projects"]["directoryToRemember"];
  "projects:open": TETApi["projects"]["open"];
  "projects:clone": TETApi["projects"]["clone"];
  "projects:create": TETApi["projects"]["create"];
  "projects:initialize": TETApi["projects"]["initialize"];
  "projects:remove": TETApi["projects"]["remove"];
  "projects:add-worktree": TETApi["projects"]["addWorktree"];
  "projects:delete-worktree": TETApi["projects"]["deleteWorktree"];
  "projects:reorder": TETApi["projects"]["reorder"];
  "providers:accounts": TETApi["providers"]["accounts"];
  "providers:add-account": TETApi["providers"]["addAccount"];
  "providers:remove-account": TETApi["providers"]["removeAccount"];
  "providers:set-namespace": TETApi["providers"]["setNamespace"];
  "providers:repos": TETApi["providers"]["repos"];
  "environment:list": TETApi["environment"]["list"];
  "environment:save": TETApi["environment"]["save"];
  "environment:answer": TETApi["environment"]["answer"];
  "repository:state": TETApi["repository"]["state"];
  "repository:refresh": TETApi["repository"]["refresh"];
  "repository:checkout": TETApi["repository"]["checkout"];
  "repository:fetch": TETApi["repository"]["fetch"];
  "repository:pull": TETApi["repository"]["pull"];
  "repository:push": TETApi["repository"]["push"];
  "repository:set-remote-url": TETApi["repository"]["setRemoteUrl"];
  "repository:create-branch": TETApi["repository"]["createBranch"];
  "repository:rename-branch": TETApi["repository"]["renameBranch"];
  "repository:delete-branch": TETApi["repository"]["deleteBranch"];
  "repository:delete-remote-branch": TETApi["repository"]["deleteRemoteBranch"];
  "repository:merge": TETApi["repository"]["merge"];
  "repository:rebase": TETApi["repository"]["rebase"];
  "repository:abort": TETApi["repository"]["abort"];
  "repository:create-tag": TETApi["repository"]["createTag"];
  "repository:push-tag": TETApi["repository"]["pushTag"];
  "repository:delete-tag": TETApi["repository"]["deleteTag"];
  "repository:delete-remote-tag": TETApi["repository"]["deleteRemoteTag"];
  "repository:checkout-tag": TETApi["repository"]["checkoutTag"];
  "repository:commit-all": TETApi["repository"]["commitAll"];
  "repository:commit-paths": TETApi["repository"]["commitPaths"];
  "repository:suggestion-agents": TETApi["repository"]["suggestionAgents"];
  "repository:suggestion-models": TETApi["repository"]["suggestionModels"];
  "repository:suggest-commit-message": TETApi["repository"]["suggestCommitMessage"];
  "repository:stash-push": TETApi["repository"]["stashPush"];
  "repository:stash": TETApi["repository"]["stash"];
  "repository:discard": TETApi["repository"]["discard"];
  "repository:ignore": TETApi["repository"]["ignore"];
  "repository:create-file": TETApi["repository"]["createFile"];
  "repository:create-directory": TETApi["repository"]["createDirectory"];
  "repository:delete-path": TETApi["repository"]["deletePath"];
  "repository:rename-path": TETApi["repository"]["renamePath"];
  "repository:add-folder": TETApi["repository"]["addFolder"];
  "repository:remove-folder": TETApi["repository"]["removeFolder"];
  "repository:exclude-path": TETApi["repository"]["excludePath"];
  "repository:set-explorer-setting": TETApi["repository"]["setExplorerSetting"];
  "repository:list-explorer": TETApi["repository"]["listExplorer"];
  "repository:search-files": TETApi["repository"]["searchFiles"];
  "repository:explorer-settings": TETApi["repository"]["explorerSettings"];
  "repository:read-file": TETApi["repository"]["readFile"];
  "repository:write-file": TETApi["repository"]["writeFile"];
  "repository:watch-files": TETApi["repository"]["watchFiles"];
  "commands:list": TETApi["commands"]["list"];
  "commands:save": TETApi["commands"]["save"];
  "commands:run": TETApi["commands"]["run"];
  "terminals:list": TETApi["terminals"]["list"];
  "terminals:create": TETApi["terminals"]["create"];
  "terminals:close": TETApi["terminals"]["close"];
  "terminals:rename": TETApi["terminals"]["rename"];
  "terminals:handoff": TETApi["terminals"]["handOff"];
  "terminals:restart": TETApi["terminals"]["restart"];
  "terminals:starting": TETApi["terminals"]["starting"];
  "agents:list": TETApi["agents"]["list"];
  "files:write-drop": TETApi["files"]["writeDrop"];
  "files:clipboard-image": TETApi["files"]["clipboardImage"];
  "files:hand-paths": TETApi["files"]["handPaths"];
  "shell:open-url": TETApi["shell"]["openUrl"];
  "shell:fetch-image": TETApi["shell"]["fetchImage"];
  "shell:open-file": TETApi["shell"]["openFile"];
  "shell:reveal-file": TETApi["shell"]["revealFile"];
  "shell:open-file-externally": TETApi["shell"]["openFileExternally"];
  "shell:open-project": TETApi["shell"]["openProject"];
}

/** Renderer to main, unanswered: `send` and `on`. */
export interface SendChannels {
  "startup:quit": TETApi["startup"]["quit"];
  "app:notice-shown": TETApi["app"]["reportNotice"];
  "app:restart": TETApi["app"]["restart"];
  /** The window's `onNotice` listens: main releases the notices it held. */
  "app:notice-listening": () => void;
  "sbx:cancel-setup": TETApi["sbx"]["cancelSetup"];
  "repository:cancel-commit-suggestion": TETApi["repository"]["cancelCommitSuggestion"];
  "editor:report": TETApi["repository"]["reportEditor"];
  "editor:active": TETApi["repository"]["reportActiveEditor"];
  "terminals:seen": TETApi["terminals"]["seen"];
  "terminals:in-front": TETApi["terminals"]["inFront"];
  "terminals:input": TETApi["terminals"]["input"];
  "terminals:resize": TETApi["terminals"]["resize"];
  [reply: EditorContentReply]: (content: string | undefined) => void;
}

/** Main to renderer: `webContents.send` and the preload's subscriptions, by payload. */
export interface EventChannels {
  "app:notice": Payload<TETApi["onNotice"]>;
  "app:notice-progress": Payload<TETApi["onNoticeProgress"]>;
  "app:theme": Payload<TETApi["onTheme"]>;
  "projects:changed": Payload<TETApi["projects"]["onChanged"]>;
  "environment:request": Payload<TETApi["environment"]["onRequest"]>;
  "environment:withdrawn": Payload<TETApi["environment"]["onWithdrawn"]>;
  "repository:state-changed": Payload<TETApi["repository"]["onState"]>;
  "repository:files-changed": Payload<TETApi["repository"]["onFilesChanged"]>;
  "repository:file-changed": Payload<TETApi["repository"]["onFileChanged"]>;
  /** `onEditorContentRequest`'s question; the answer goes back on `reply`. */
  "editor:content-request": { ref: ProjectRef; reply: EditorContentReply };
  "editor:open": Payload<TETApi["repository"]["onOpenEditor"]>;
  "commands:changed": Payload<TETApi["commands"]["onChanged"]>;
  "terminals:tabs": Payload<TETApi["terminals"]["onTabs"]>;
  "terminals:output": Payload<TETApi["terminals"]["onOutput"]>;
  "terminals:status": Payload<TETApi["terminals"]["onStatus"]>;
  "terminals:startup-progress": Payload<TETApi["terminals"]["onStartupProgress"]>;
  "terminals:show": Payload<TETApi["terminals"]["onShow"]>;
}
