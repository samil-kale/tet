import type { TETApi, Unsubscribe } from "./api";
import type { ShortcutKey } from "./shortcuts";
import type { ProjectRef } from "./types/project";

/**
 * Every channel between the window and the main process, typed off `TETApi` (`api.ts`): the
 * preload and `src/main/ipc/channels.ts` take channels only from here, so a name, an argument or an
 * answer that differs between the two sides fails to compile.
 */

/** The payload a `TETApi` subscription hands its listener. */
type Payload<S> = S extends (listener: (payload: infer P) => unknown) => Unsubscribe ? P : never;

/** The channel the window's answer to a question from main comes back on, one per question
 *  (window.ts's askWindow). */
export type WindowReply = `window:reply:${number}`;

/** Renderer to main, answered: `invoke` and `handle`. */
export interface InvokeChannels {
  "startup:check": TETApi["startup"]["check"];
  "startup:any-agent-installed": TETApi["startup"]["anyAgentInstalled"];
  "app:info": TETApi["app"]["info"];
  "sbx:status": TETApi["sbx"]["status"];
  "sbx:sign-in-browser": TETApi["sbx"]["signInInBrowser"];
  "sbx:signed-in-user": TETApi["sbx"]["signedInUser"];
  "sbx:accounts": TETApi["sbx"]["accounts"];
  "sbx:sign-in": TETApi["sbx"]["signIn"];
  "sbx:sign-out": TETApi["sbx"]["signOut"];
  "sbx:save-accounts": TETApi["sbx"]["saveAccounts"];
  "sbx:init-policy": TETApi["sbx"]["initPolicy"];
  "sbx:get-settings": TETApi["sbx"]["getSettings"];
  "sbx:stored": TETApi["sbx"]["stored"];
  "sbx:knowledge-sources": TETApi["sbx"]["knowledgeSources"];
  "sbx:save-settings": TETApi["sbx"]["saveSettings"];
  "sbx:problems": TETApi["sbx"]["problems"];
  "settings:get": TETApi["settings"]["get"];
  "settings:patch": TETApi["settings"]["patch"];
  "projects:list": TETApi["projects"]["list"];
  "projects:pick-directory": TETApi["projects"]["pickDirectory"];
  "projects:pick-file": TETApi["projects"]["pickFile"];
  "projects:directory-to-remember": TETApi["projects"]["directoryToRemember"];
  "projects:open": TETApi["projects"]["open"];
  "projects:clone": TETApi["projects"]["clone"];
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
  "env:list": TETApi["env"]["list"];
  "env:save": TETApi["env"]["save"];
  "env:answer": TETApi["env"]["answer"];
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
  "repository:commit-refusal": TETApi["repository"]["commitRefusal"];
  "repository:commit-all": TETApi["repository"]["commitAll"];
  "repository:commit-paths": TETApi["repository"]["commitPaths"];
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
  "repository:list-explorer": TETApi["repository"]["listExplorer"];
  "repository:search-files": TETApi["repository"]["searchFiles"];
  "repository:read-file": TETApi["repository"]["readFile"];
  "repository:log": TETApi["repository"]["log"];
  "repository:commit-files": TETApi["repository"]["commitFiles"];
  "repository:read-commit-file": TETApi["repository"]["readCommitFile"];
  "repository:write-file": TETApi["repository"]["writeFile"];
  "repository:watch-files": TETApi["repository"]["watchFiles"];
  "commands:list": TETApi["commands"]["list"];
  "commands:save": TETApi["commands"]["save"];
  "commands:run": TETApi["commands"]["run"];
  "tabs:list": TETApi["tabs"]["list"];
  "tabs:create": TETApi["tabs"]["create"];
  "tabs:close": TETApi["tabs"]["close"];
  "tabs:rename": TETApi["tabs"]["rename"];
  "tabs:handover": TETApi["tabs"]["handOver"];
  "tabs:restart": TETApi["tabs"]["restart"];
  "tabs:starting": TETApi["tabs"]["starting"];
  "browser:list": TETApi["browser"]["list"];
  "browser:create": TETApi["browser"]["create"];
  "browser:close": TETApi["browser"]["close"];
  "browser:still": TETApi["browser"]["still"];
  "agents:list": TETApi["agents"]["list"];
  "agents:askable": TETApi["agents"]["askable"];
  "agents:ask-models": TETApi["agents"]["askModels"];
  "drops:write-drop": TETApi["drops"]["writeDrop"];
  "drops:clipboard-image": TETApi["drops"]["clipboardImage"];
  "drops:hand-paths": TETApi["drops"]["handPaths"];
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
  "tabs:seen": TETApi["tabs"]["seen"];
  "tabs:on-screen": TETApi["tabs"]["reportOnScreen"];
  "tabs:input": TETApi["tabs"]["input"];
  "tabs:resize": TETApi["tabs"]["resize"];
  "browser:navigate": TETApi["browser"]["navigate"];
  "browser:go": TETApi["browser"]["go"];
  "browser:answer-login": TETApi["browser"]["answerLogin"];
  "browser:place": TETApi["browser"]["place"];
  "browser:active": TETApi["browser"]["reportActive"];
  /** From a browser tab's page (page-preload.ts), not the window: a key press the page left alone. */
  "browser:page-key": (key: ShortcutKey) => void;
  [reply: WindowReply]: (answer: string | undefined) => void;
}

/** Main to renderer: `webContents.send` and the preload's subscriptions, by payload. */
export interface EventChannels {
  "app:notice": Payload<TETApi["onNotice"]>;
  "app:notice-progress": Payload<TETApi["onNoticeProgress"]>;
  "app:theme": Payload<TETApi["onTheme"]>;
  "app:lanes": Payload<TETApi["onLanes"]>;
  "projects:changed": Payload<TETApi["projects"]["onChanged"]>;
  "env:request": Payload<TETApi["env"]["onRequest"]>;
  "env:withdrawn": Payload<TETApi["env"]["onWithdrawn"]>;
  "repository:state-changed": Payload<TETApi["repository"]["onState"]>;
  "repository:files-changed": Payload<TETApi["repository"]["onFilesChanged"]>;
  "repository:file-changed": Payload<TETApi["repository"]["onFileChanged"]>;
  /** `onEditorContentRequest`'s question; the answer goes back on `reply`. */
  "editor:content-request": { ref: ProjectRef; reply: WindowReply };
  "editor:open": Payload<TETApi["repository"]["onOpenEditor"]>;
  "commands:changed": Payload<TETApi["commands"]["onChanged"]>;
  "tabs:changed": Payload<TETApi["tabs"]["onTabs"]>;
  "tabs:output": Payload<TETApi["tabs"]["onOutput"]>;
  "tabs:status": Payload<TETApi["tabs"]["onStatus"]>;
  "tabs:startup-progress": Payload<TETApi["tabs"]["onStartupProgress"]>;
  "tabs:show": Payload<TETApi["tabs"]["onShow"]>;
  /** `onTextRequest`'s question; the answer goes back on `reply`. */
  "tabs:text-request": { ref: ProjectRef; tabId: string; reply: WindowReply };
  "browser:changed": Payload<TETApi["browser"]["onTabs"]>;
  "browser:shortcut": Payload<TETApi["browser"]["onShortcut"]>;
  "browser:focused": Payload<TETApi["browser"]["onFocused"]>;
  "browser:open-link": Payload<TETApi["browser"]["onOpenLink"]>;
  "browser:login": Payload<TETApi["browser"]["onLogin"]>;
}
