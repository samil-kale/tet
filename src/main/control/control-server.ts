import * as crypto from "node:crypto";
import * as http from "node:http";
import * as path from "node:path";
import { stripAnsi } from "../../shared/ansi";
import { errorMessage } from "../../shared/errors";
import { CONTROL_HOST, CONTROL_VERBS, HELP_VERB, HOOK_EVENTS, TAB_KEYS } from "../../shared/control";
import type { ControlErrorCode, ControlEvent, ControlRequest, ControlResponse, ControlVerbName, HookEvent } from "../../shared/control";
import { KEYBINDING_PRESETS } from "../../shared/keybinding-presets";
import { THEMES, themeKey } from "../../shared/themes";
import { COLOR_SCHEMES, NOTIFICATION_IDS, PROMPT_IDS, TERMINAL_STATUSES, projectRefKey, projectRef, projectRefsOf, isWorking, sameProjectRef, worktreeOf } from "../../shared/types";
import type {
  AddRepositoryResult,
  AgentId,
  ProjectRef,
  EditorListing,
  EditorReport,
  ExplorerListing,
  GitActionResult,
  NoticeReport,
  Project,
  ProjectCommand,
  RepositoryState,
  SbxAccount,
  SbxKnowledgeConfig,
  SbxLocalSave,
  SbxProblems,
  SbxProjectConfig,
  SbxSaveResult,
  SbxSignInResult,
  SbxStoredLocal,
  SbxValueKind,
  TerminalDescriptor
} from "../../shared/types";
import type { AgentDefinition } from "../agents/agent";
import type { ToastTarget } from "../notifications";
import type { SbxReading } from "../sbx-status";
import { CALLER_SIDES, HOST_CALLER, type CallerSide } from "./caller-side";
import { isEnvName, reservedRefusal } from "../../shared/env-rules";
import { machineName } from "../env-names";
import type { EnvRequests, EnvStore } from "../environment";
import { repositoryRelative } from "../path-inside";
import type { ProjectLookup } from "../projects";
import type { SettingsAccess } from "../settings";
import { tabControlToken } from "./control-token";
import { sbxVerbs } from "./control-sbx-verbs";
import { ControlError, count, list, oneOf, optionalText, text, type Caller, type Handler, type RefFrom } from "./control-verb";
import { canBind } from "../can-bind";
import { isRecord } from "../json-file";

/**
 * Handed over by main.ts, not imported: no electron or node-pty here, so test/control.test.ts runs
 * the server under plain node with these faked. The same singletons ipc/ holds: a second
 * transport onto that logic, never a second implementation (projects.ts's addProject/removeProject).
 */
export interface ControlDeps {
  version: string;
  /** Lets a test tell that restart-app replaced the process. */
  pid: number;
  store: ProjectLookup;
  settings: SettingsAccess;
  sessions: {
    get(ref: ProjectRef): ControlTerminals | undefined;
  };
  repositories: {
    get(ref: ProjectRef):
      | {
          getState(): RepositoryState;
          listExplorer(): Promise<ExplorerListing>;
          merge(ref: string, fastForwardOnto?: string): Promise<GitActionResult>;
          conflictMarkers(base: string): Promise<string[]>;
        }
      | undefined;
  };
  /** See ControlRecords. */
  records: {
    editor(ref: ProjectRef): EditorReport | undefined;
    editors(ref: ProjectRef): EditorListing[];
    notices(): NoticeReport[];
    output(ref: ProjectRef, tabId: string): string | undefined;
  };
  /** A repository's or worktree's folder (project-dirs.ts's projectRefPath); undefined for an
   *  unknown project. */
  projectRefPath(ref: ProjectRef): string | undefined;
  /** Opens a file in the repository's or worktree's preview tab, or a kept tab, and brings it to
   *  the front. */
  openEditor(ref: ProjectRef, path: string, keep: boolean): void;
  /** The active editor tab's text, asked of the window live — the one thing not kept as a report
   *  (see EditorReport). */
  editorContent(ref: ProjectRef): Promise<string | undefined>;
  /** agents/index.ts's listInstalledAgents: the requirements dialog's answer, by id. */
  listAgents(): Promise<{ id: AgentId; name: string; installed: boolean }[]>;
  /** `AGENTS`, so a new agent needs nothing here. */
  agents: readonly AgentDefinition[];
  /** projects.ts's, which tell the window their outcome themselves (projectsChanged). */
  addProject(directory: string): Promise<AddRepositoryResult>;
  removeProject(projectId: string): Promise<GitActionResult>;
  addWorktree(projectId: string, branch: string): Promise<AddRepositoryResult>;
  deleteWorktree(worktree: ProjectRef, force: boolean): Promise<GitActionResult>;
  readCommands(root: string): Promise<ProjectCommand[]>;
  /** main.ts's teardown: ends every session and quits, optionally relaunching. */
  shutdown(relaunch: boolean): void;
  /** Its process starts with the first resize that draws it. */
  showTab(ref: ProjectRef, tabId: string): void;
  /** A desktop toast from this process, which holds the desktop session (a sandboxed hook has
   *  none). Must never throw: `hook` toasts on the way to answering a turn. A click brings
   *  `target` to the front. */
  notify(title: string, body: string, target?: ToastTarget): void;
  /** main.ts's, shared with ipc/environment.ts. */
  environment: Pick<EnvStore, "list" | "remove">;
  envRequests: Pick<EnvRequests, "ask">;
  /** The SBX Settings dialog's reads and Save (ipc/sbx.ts, sbx-settings.ts). */
  sbx: {
    /** sbx-status.ts's readSbxReading: the status, and what the verb's problems check reuses of it. */
    status(project: Project): Promise<SbxReading>;
    /** Whether an agent runs on this machine at all: without one, sandboxing cannot be switched off. */
    anyAgentInstalled(): Promise<boolean>;
    config(project: Project): Promise<SbxProjectConfig>;
    stored(projectId: string): SbxStoredLocal;
    /** sbx-settings.ts's readProjectSbxProblems. */
    problems(
      project: Project,
      config: SbxProjectConfig,
      knowledge: SbxKnowledgeConfig,
      values: Record<SbxValueKind, string[]>,
      reading?: SbxReading
    ): Promise<SbxProblems>;
    /** sbx-settings.ts's saveProjectSbx: takes the status's organization, and lists the rest in its turn. */
    save(project: Project, request: SbxProjectConfig, local: SbxLocalSave, known?: Pick<SbxReading, "status">): Promise<SbxSaveResult>;
    /** The access tokens kept for every project (sbx-accounts.ts), never a token. */
    accounts(): SbxAccount[];
    /** sbx-status.ts's readSbxSignedIn: one `sbx ls`, not the whole status — the question is the
     *  machine's. */
    signedIn(): Promise<boolean>;
    /** sbx-cli.ts's readSbxUser: only once signedIn said so. */
    signedInUser(): Promise<string | undefined>;
    /** sbx-accounts.ts's signInToSbx with the token kept for that account. */
    signIn(account: SbxAccount): Promise<SbxSignInResult>;
  };
}

/** See ControlTerminals.hookEvent. */
export interface HookToast {
  title: string;
  body: string;
}

export interface HookOutcome {
  /** What the hook prints back into its agent (AgentTurns.hookReply). */
  stdout: string;
  /** None where the notification settings say so. */
  toast?: HookToast;
}

/** A `tabs-list` entry: the window's descriptor plus what only the session manager knows. */
export interface InspectedTab extends TerminalDescriptor {
  /** The session this tab's hooks named, claimed or not. */
  reportedSessionId?: string;
  sandbox?: string;
  /** Opened from a sandbox, so it runs there or not at all. */
  sandboxOnly?: true;
}

/** The slice of TabSessionManager the verbs use. */
export interface ControlTerminals {
  snapshot(): TerminalDescriptor[];
  inspect(): InspectedTab[];
  /** At the last fitted size or a default; false unless the tab awaits its first start. */
  start(tabId: string): boolean;
  /** False for a tab that neither stopped nor failed to start. */
  restart(tabId: string): boolean;
  write(tabId: string, data: string): void;
  /** Oldest first. */
  events(): ControlEvent[];
  /** `sandboxOnly`: opened from a sandbox, so it never runs on this machine. `prompt`: its first,
   *  for an agent that takes one. */
  createTab(agentId: AgentId, sandboxOnly: boolean, prompt?: string): TerminalDescriptor;
  /** The new tab taking over the tab's session, or why there is none. */
  handOff(tabId: string, agentId: AgentId, sandboxOnly: boolean): Promise<TerminalDescriptor | string>;
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined;
  closeTabs(tabIds: string[]): Promise<void>;
  /** Host paths as the tab types them, mounted into its sandbox where it would not see them. */
  handPaths(tabId: string, hostPaths: string[]): Promise<string[]>;
  /** The agent's refusal, or nothing when it went through. */
  renameTab(tabId: string, title: string): Promise<string | undefined>;
  /** `at` is when the hook fired, not arrived (ControlRequest.at). An unknown tab is no error: it
   *  may have closed while its CLI ended the turn. */
  hookEvent(tabId: string, event: HookEvent, payload: string, at: number | undefined, side: CallerSide): HookOutcome;
}

/** Strips escape sequences; CRLF to LF. */
function plainText(data: string): string {
  return stripAnsi(data).replace(/\r\n/g, "\n");
}

/**
 * A tab's output with its lines as finally shown: each keeps what follows its last bare `\r`, so a
 * progress bar's redraws leave one line. Over the whole output at once, a redraw split across
 * chunks included; the `\r` of a `\r\n` not yet complete is no redraw.
 */
function shownText(data: string): string {
  return plainText(data)
    .replace(/\r$/, "")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** `tabs-wait` default timeout and poll interval. */
const WAIT_TIMEOUT_S = 30;
const WAIT_POLL_MS = 100;
/** `events-tail` default. */
const EVENTS_TAIL = 50;
/** `tabs-output` default. */
const OUTPUT_KB = 16;
/** What `tabs-keys` presses, for its refusals. */
const KEY_NAMES = Object.keys(TAB_KEYS).join(", ");

const DYNAMIC_PORT_START = 49152;
const DYNAMIC_PORT_RANGE = 65535 - DYNAMIC_PORT_START;

/** The preferred port for this data folder, before checking it is free. */
function hashPort(dataRoot: string): number {
  const hash = crypto.createHash("sha1").update(dataRoot).digest("hex");
  return DYNAMIC_PORT_START + (parseInt(hash.slice(0, 8), 16) % DYNAMIC_PORT_RANGE);
}

/**
 * Derived from the data folder (data-root.ts), so two accounts, or a test profile beside the tet it
 * runs in, get ports of their own. Probed by binding: Windows excludes pieces of the dynamic range,
 * failing with `EACCES`, and keeps them long enough to reuse the probed port. Not OS-assigned: the
 * port must be in every terminal's environment (setControlEnv) before the server starts.
 */
export async function findControlPort(dataRoot: string): Promise<number> {
  const start = hashPort(dataRoot);
  for (let offset = 0; offset < DYNAMIC_PORT_RANGE; offset += 1) {
    const port = DYNAMIC_PORT_START + ((start - DYNAMIC_PORT_START + offset) % DYNAMIC_PORT_RANGE);
    if (await canBind(port)) {
      return port;
    }
  }
  throw new Error("no free loopback port in the dynamic range");
}

/** The repository or worktree the caller's tab runs in; undefined for the run itself. */
function callerRef(caller: ControlRequest["caller"]): ProjectRef | undefined {
  return caller.projectId === undefined ? undefined : projectRef(caller.projectId, caller.worktree);
}

/** A worktree of the project TET made, named as `tet-ctl` names one: by its branch, or else by
 *  its key. One made elsewhere cannot be addressed: TET never opens it. */
function tetWorktree(project: Project, name: string): { worktree: Project["worktrees"][number]; ref: ProjectRef } {
  const worktree = project.worktrees.find((entry) => entry.branch === name) ?? project.worktrees.find((entry) => entry.key === name);
  if (!worktree) {
    throw new ControlError("not_found", `${project.name} has no worktree ${name} (see projects-list)`);
  }
  if (worktree.key === undefined) {
    throw new ControlError("bad_args", `the worktree of ${name} was not made by TET, which cannot reach it: use git`);
  }
  return { worktree, ref: projectRef(project.id, worktree.key) };
}

/**
 * The repository or worktree a verb acts on: without flags the caller's own; `--project` alone that
 * project's repository; `--worktree` one of its worktrees TET made (tetWorktree). Also the gate's
 * answer to "is this the caller's own".
 */
function resolveCallerRef(
  store: ProjectLookup,
  args: Record<string, unknown>,
  caller: ControlRequest["caller"]
): { project: Project; ref: ProjectRef } {
  const askedProject = optionalText(args, "project");
  const projectId = askedProject ?? caller.projectId;
  if (!projectId) {
    throw new ControlError("bad_args", "no project: pass --project <id> (see projects-list)");
  }
  const project = store.get(projectId);
  if (!project) {
    throw new ControlError("not_found", `unknown project: ${projectId}`);
  }
  const asked = optionalText(args, "worktree");
  if (asked === undefined) {
    return { project, ref: projectRef(projectId, askedProject === undefined ? caller.worktree : undefined) };
  }
  return { project, ref: tetWorktree(project, asked).ref };
}

/** Every verb's handler but `help`, which the CLI answers itself. */
type Handlers = Record<Exclude<ControlVerbName, typeof HELP_VERB>, Handler>;

function verbs(deps: ControlDeps): Handlers {
  const { store, settings, sessions } = deps;

  const projectById = (id: string): Project => {
    const found = store.get(id);
    if (!found) {
      throw new ControlError("not_found", `unknown project: ${id}`);
    }
    return found;
  };

  const refFrom: RefFrom = (args, caller) => resolveCallerRef(store, args, caller);

  const project = (args: Record<string, unknown>, caller: ControlRequest["caller"]): Project => refFrom(args, caller).project;

  const terminals = (ref: ProjectRef): ControlTerminals => {
    const manager = sessions.get(ref);
    if (!manager) {
      throw new ControlError("internal", `${projectRefKey(ref)} has no terminals`);
    }
    return manager;
  };

  const repository = (ref: ProjectRef): NonNullable<ReturnType<ControlDeps["repositories"]["get"]>> => {
    const repo = deps.repositories.get(ref);
    if (!repo) {
      throw new ControlError("internal", `${projectRefKey(ref)} has no repository`);
    }
    return repo;
  };

  /** A tab id checked to exist, with its repository or worktree and terminals. */
  const knownTab = (
    args: Record<string, unknown>,
    caller: ControlRequest["caller"]
  ): { tabs: ControlTerminals; tabId: string; ref: ProjectRef } => {
    const { ref } = refFrom(args, caller);
    const tabId = text(args, "tabId", "tab id");
    const tabs = terminals(ref);
    if (!tabs.snapshot().some((tab) => tab.tabId === tabId)) {
      throw new ControlError("not_found", `unknown tab: ${tabId} (see tabs-list)`);
    }
    return { tabs, tabId, ref };
  };

  /** `knownTab` for a verb reaching into the tab (its output, its session): from a sandbox, only its
   *  own tab or one known to run there — a host tab is this machine's, which a sandbox never reaches,
   *  and its output may print the host's control token. `own`: the caller's own tab. */
  const ownedTab = (args: Record<string, unknown>, caller: Caller) => {
    const known = knownTab(args, caller);
    const own = sameProjectRef(known.ref, callerRef(caller)) && known.tabId === caller.tabId;
    const tab = known.tabs.inspect().find((entry) => entry.tabId === known.tabId);
    if (!caller.side.reachesTab(tab, own)) {
      throw new ControlError("bad_args", `${known.tabId} runs on this machine, not in the sandbox`);
    }
    return { ...known, own };
  };

  /** `--agent`, one the caller may open a tab of: a shell would run on this machine, so a sandbox
   *  opens only an sbx agent's tab, held to the sandbox (createTab, handOff). */
  const openableAgent = (args: Record<string, unknown>, caller: Caller): AgentDefinition => {
    const id = text(args, "agent", "agent: pass --agent <id> (see list-agents)");
    const agent = deps.agents.find((candidate) => candidate.id === id);
    if (!agent) {
      throw new ControlError("bad_args", `unknown agent: ${id} (see list-agents)`);
    }
    if (!caller.side.opens(agent)) {
      throw new ControlError("unauthorized", `a ${id} tab does not run in a sandbox, so a sandbox cannot open one`);
    }
    return agent;
  };

  return {
    ...sbxVerbs(deps, refFrom),

    version: () => ({ result: { version: deps.version, pid: deps.pid } }),

    "list-themes": () => ({ result: THEMES.map(({ id, label, kind }) => ({ id, label, kind })) }),

    "list-keybinding-presets": () => ({ result: KEYBINDING_PRESETS.map(({ id, label }) => ({ id, label })) }),

    "list-agents": async () => ({ result: await deps.listAgents() }),

    "settings-get": () => ({ result: settings.get() }),

    "settings-set-theme": (args) => {
      const id = text(args, "theme", "theme id");
      // The store keeps any string and silently falls back (settings.ts); refuse it here instead.
      const theme = THEMES.find((candidate) => candidate.id === id);
      if (!theme) {
        throw new ControlError("bad_args", `unknown theme: ${id} (see list-themes)`);
      }
      // Shown at once if the window is in that kind. The flag is for the agent to relay; restarting
      // is the user's call.
      return { result: { saved: true, restartRequired: settings.patch({ [themeKey(theme.kind)]: id }) } };
    },

    "settings-set-color-scheme": (args) => {
      const colorScheme = oneOf(args, "scheme", "color scheme", COLOR_SCHEMES);
      // A kind the window is not drawn in waits for a restart (main.ts's applyTheme).
      return { result: { saved: true, restartRequired: settings.patch({ colorScheme }) } };
    },

    "settings-set-prompt": (args) => {
      const id = oneOf(args, "id", "prompt", PROMPT_IDS);
      // No text resets: "" means tet's own prompt, read by ipc/repository.ts when asking.
      const value = args.text;
      settings.patch({ prompts: { [id]: typeof value === "string" ? value : "" } });
      return { result: { saved: true } };
    },

    "settings-set-keybindings": (args) => {
      const id = text(args, "preset", "keybinding preset id");
      // The store keeps any string and the editor falls back (settings.ts); refuse it here instead.
      if (!KEYBINDING_PRESETS.some((preset) => preset.id === id)) {
        throw new ControlError("bad_args", `unknown keybinding preset: ${id} (see list-keybinding-presets)`);
      }
      // An editor reads its keybindings once, when it is made (editor-views.ts's editorSetup).
      settings.patch({ editorKeybindingPreset: id });
      return { result: { saved: true } };
    },

    "settings-set-notification": (args) => {
      const id = oneOf(args, "id", "notification", NOTIFICATION_IDS);
      const value = oneOf(args, "value", "value", ["on", "off"]);
      settings.patch({ notifications: { [id]: value === "on" } });
      return { result: { saved: true } };
    },

    "projects-list": (_args, caller) => ({ result: caller.side.projects(store.list(), caller) }),

    "repo-state": (args, caller) => ({ result: repository(refFrom(args, caller).ref).getState() }),

    "projects-add": async (args) => {
      const added = await deps.addProject(text(args, "path", "path"));
      if (!added.project) {
        throw new ControlError("bad_args", added.error ?? "could not open the folder");
      }
      return { result: added.project };
    },

    "projects-remove": async (args, caller) => {
      const id = text(args, "projectId", "project id");
      const found = projectById(id);
      // Only the window asks about unsaved edits (App's removeProject); from here they would be lost.
      const unsaved = projectRefsOf(found)
        .flatMap((ref) => deps.records.editors(ref))
        .filter((editor) => editor.dirty);
      if (unsaved.length > 0) {
        throw new ControlError("bad_args", `unsaved changes in ${unsaved.map((editor) => editor.path).join(", ")} — save or close them in TET first`);
      }
      // What the window's question says (ProjectList's remove), here as a flag.
      const worktrees = found.worktrees.filter((worktree) => worktree.key !== undefined).length;
      if (worktrees > 0 && args.confirm !== true) {
        throw new ControlError(
          "bad_args",
          `removing ${found.name} deletes its ${worktrees} worktree${worktrees === 1 ? "" : "s"} with their branches. Ask the user, then pass --confirm.`
        );
      }
      // The caller's own project takes the caller's tab with it — answer first.
      if (caller.projectId === id) {
        return { result: { removed: id }, after: () => void deps.removeProject(id) };
      }
      const removed = await deps.removeProject(id);
      if (!removed.ok) {
        throw new ControlError("bad_args", removed.error ?? "could not remove the project");
      }
      return { result: { removed: id } };
    },

    "worktree-add": async (args, caller) => {
      const branch = text(args, "branch", "branch");
      const added = await deps.addWorktree(project(args, caller).id, branch);
      const worktree = added.project && worktreeOf(added.project, projectRef(added.project.id, added.worktree));
      if (!added.project || !worktree) {
        throw new ControlError("bad_args", added.error ?? "could not create the worktree");
      }
      return { result: { projectId: added.project.id, worktree: worktree.key, branch: worktree.branch ?? branch, path: worktree.path } };
    },

    // Named by its branch within the project, as worktree-add names it, so a worktree of another
    // repository cannot be reached. Not the caller's own: it would end the caller's tab before the
    // folder can go.
    "worktree-delete": async (args, caller) => {
      const found = project(args, caller);
      const branch = text(args, "branch", "branch");
      const { ref } = tetWorktree(found, branch);
      if (sameProjectRef(ref, callerRef(caller))) {
        throw new ControlError("bad_args", "a worktree cannot delete itself: run this from another tab of its project");
      }
      const deleted = await deps.deleteWorktree(ref, args.force === true);
      if (deleted.needsConfirmation === "uncommitted") {
        throw new ControlError("bad_args", `${branch} has uncommitted changes: pass --force to delete them too`);
      }
      if (!deleted.ok) {
        throw new ControlError("bad_args", deleted.error ?? "could not delete the worktree");
      }
      return { result: { deleted: branch } };
    },

    // From the repository alone: the worktree goes at the end, which would end a caller inside it.
    // Every step before the fast-forward leaves nothing to undo, so each refusal says what to do
    // and that running it again picks up where it stopped.
    "worktree-merge": async (args, caller) => {
      const found = project(args, caller);
      const name = text(args, "branch", "branch");
      if (caller.worktree !== undefined) {
        const own = worktreeOf(found, projectRef(found.id, caller.worktree));
        throw new ControlError(
          "bad_args",
          `worktree-merge runs only from the project's repository: it deletes the worktree when done, which would close this tab. Run "tet-ctl worktree-merge ${own?.branch ?? name}" from a tab of the repository, or ask the user to.`
        );
      }
      const { worktree, ref } = tetWorktree(found, name);
      const branch = worktree.branch;
      if (branch === undefined) {
        throw new ControlError("bad_args", `the worktree ${name} has no branch checked out, so there is nothing to merge: check one out there or delete the worktree`);
      }
      const main = repository(projectRef(found.id));
      const listed = main.getState().worktrees;
      const base = listed.find((entry) => entry.key === worktree.key)?.base;
      if (base === undefined) {
        throw new ControlError("bad_args", `${branch} has no recorded base, so TET cannot tell where it goes: merge it with git yourself`);
      }
      const checkedOut = listed.find((entry) => entry.main)?.branch;
      if (checkedOut !== base) {
        throw new ControlError(
          "bad_args",
          `the repository has ${checkedOut ?? "a detached HEAD"} checked out, not ${branch}'s base ${base}: run "git switch ${base}" there, or ask the user, then run this again`
        );
      }
      const own = repository(ref);
      const state = own.getState();
      if (state.operation !== undefined) {
        throw new ControlError(
          "bad_args",
          `a ${state.operation} is in progress in ${worktree.path}: resolve and commit it (or abort it with git), then run this again`
        );
      }
      if (state.changes.length > 0) {
        throw new ControlError(
          "bad_args",
          `${branch} has uncommitted changes, nothing was merged: have them committed or stashed there (by its agent or the user), then run this again`
        );
      }
      const working = sessions.get(ref)?.inspect().find(isWorking);
      if (working) {
        throw new ControlError("bad_args", `an agent in ${branch} is mid-turn (tab ${working.tabId}), nothing was merged: wait until it is done, then run this again`);
      }
      const unsaved = deps.records.editors(ref).filter((editor) => editor.dirty);
      if (unsaved.length > 0) {
        throw new ControlError(
          "bad_args",
          `unsaved changes in ${unsaved.map((editor) => editor.path).join(", ")}, nothing was merged: ask the user to save or close them in TET`
        );
      }

      const merged = await own.merge(base);
      if (!merged.ok) {
        const conflicts = own.getState();
        if (conflicts.operation !== "merge") {
          throw new ControlError("bad_args", `${merged.error ?? "the merge failed"} — ${branch} is unchanged`);
        }
        // Where the caller sees the worktree: mounted into its sandbox if it would not.
        const [handed] = caller.tabId === undefined ? [] : ((await sessions.get(projectRef(found.id))?.handPaths(caller.tabId, [worktree.path])) ?? []);
        const at = handed ?? worktree.path;
        return {
          result: {
            status: "conflicts",
            path: at,
            files: conflicts.changes.filter((change) => change.status === "conflicted").map((change) => change.path),
            next: `resolve the conflicts in ${at}, git add and git commit them there (or git merge --abort), then run "tet-ctl worktree-merge ${branch}" again`
          }
        };
      }
      const markers = await own.conflictMarkers(base);
      if (markers.length > 0) {
        throw new ControlError(
          "bad_args",
          `conflict markers are left in ${markers.join(", ")} of ${branch}, ${base} is unchanged: remove them, commit, then run this again`
        );
      }
      const forwarded = await main.merge(branch, base);
      if (!forwarded.ok) {
        throw new ControlError(
          "bad_args",
          `${forwarded.error ?? "the fast-forward failed"} — the merge is committed in ${branch}, ${base} is unchanged: commit or stash what is in the way in the repository if anything is, then run this again`
        );
      }
      const deleted = await deps.deleteWorktree(ref, false);
      if (!deleted.ok) {
        const why =
          deleted.needsConfirmation === "uncommitted"
            ? `it has uncommitted changes since: look at them, then run "tet-ctl worktree-delete ${branch}" (--force if they can go)`
            : `${deleted.error ?? "unknown error"}: run "tet-ctl worktree-delete ${branch}"`;
        throw new ControlError("bad_args", `${branch} is merged into ${base}, but its worktree could not be deleted — ${why}`);
      }
      return { result: { status: "merged", base, branch } };
    },

    "env-request": async (args, caller, _at, gone) => {
      const names = list(args, "names").filter((name) => name !== "");
      if (names.length === 0) {
        throw new ControlError("bad_args", "missing variable names: env-request NAME [NAME...]");
      }
      const invalid = names.find((name) => !isEnvName(name));
      if (invalid) {
        throw new ControlError("bad_args", `not an environment variable name: ${invalid}`);
      }
      const reserved = names.map(reservedRefusal).find((refusal) => refusal !== undefined);
      if (reserved) {
        throw new ControlError("bad_args", reserved);
      }
      // Once per variable as the machine counts them: on win32 `a` and `A` are one.
      const unique = names.filter((name, index) => names.findIndex((other) => machineName(other) === machineName(name)) === index);
      const saved = await deps.envRequests.ask(
        { ref: callerRef(caller), tabId: caller.tabId, names: unique },
        gone
      );
      return { result: saved === undefined ? { cancelled: true } : { saved, restartRequired: true } };
    },

    "env-list": () => ({ result: deps.environment.list() }),

    "env-remove": (args) => {
      const name = text(args, "name", "variable name");
      if (!deps.environment.remove(name)) {
        throw new ControlError("not_found", `TET keeps no environment variable named ${name}`);
      }
      return { result: { removed: name } };
    },

    "tabs-list": (args, caller) => ({ result: terminals(refFrom(args, caller).ref).inspect() }),

    "tabs-start": (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      if (!tabs.start(tabId)) {
        throw new ControlError("bad_args", `tab ${tabId} is not waiting for its first start (see tabs-list; tabs-restart for one that stopped)`);
      }
      return { result: { started: tabId } };
    },

    "tabs-restart": (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      if (!tabs.restart(tabId)) {
        throw new ControlError("bad_args", `tab ${tabId} has nothing to restart: it neither stopped nor failed to start (see tabs-list)`);
      }
      return { result: { restarted: tabId } };
    },

    "tabs-wait": async (args, caller, _at, gone) => {
      const { tabs, tabId } = knownTab(args, caller);
      const status = args.status === undefined ? undefined : oneOf(args, "status", "status", TERMINAL_STATUSES);
      const conditions: [string, (tab: InspectedTab) => boolean][] = [];
      if (args.session === true) {
        conditions.push(["bound to a session", (tab) => tab.sessionId !== undefined]);
      }
      if (args.busy === true) {
        conditions.push(["working a turn", isWorking]);
      }
      if (args.idle === true) {
        conditions.push(["idle", (tab) => !isWorking(tab)]);
      }
      if (status !== undefined) {
        conditions.push([status, (tab) => tab.status === status]);
      }
      if (conditions.length === 0) {
        throw new ControlError("bad_args", "nothing to wait for: pass --session, --busy, --idle or --status <status>");
      }
      const deadline = Date.now() + count(args, "timeout", WAIT_TIMEOUT_S) * 1000;
      while (!gone.aborted) {
        const tab = tabs.inspect().find((candidate) => candidate.tabId === tabId);
        if (!tab) {
          throw new ControlError("not_found", `tab ${tabId} was closed while waiting`);
        }
        if (conditions.every(([, holds]) => holds(tab))) {
          return { result: tab };
        }
        if (Date.now() >= deadline) {
          const missing = conditions.filter(([, holds]) => !holds(tab)).map(([what]) => what);
          throw new ControlError("timeout", `tab ${tabId} is still not ${missing.join(" and not ")} (status ${tab.status})`);
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      }
      // Answered to no one.
      throw new ControlError("timeout", `stopped waiting for tab ${tabId}: the caller is gone`);
    },

    // One write per key: a TUI reads a burst of them as a paste.
    "tabs-keys": (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      const keys = list(args, "keys");
      if (keys.length === 0) {
        throw new ControlError("bad_args", `missing keys: one or more of ${KEY_NAMES}`);
      }
      const unknown = keys.find((key) => !Object.hasOwn(TAB_KEYS, key));
      if (unknown !== undefined) {
        throw new ControlError("bad_args", `unknown key: ${unknown} (one of ${KEY_NAMES})`);
      }
      for (const key of keys) {
        tabs.write(tabId, TAB_KEYS[key]);
      }
      return { result: { pressed: tabId } };
    },

    "tabs-output": (args, caller) => {
      const { tabId, ref } = ownedTab(args, caller);
      const output = shownText(deps.records.output(ref, tabId) ?? "");
      return { result: { output: output.slice(-count(args, "kb", OUTPUT_KB) * 1024) } };
    },

    "events-tail": (args, caller) => ({
      result: terminals(refFrom(args, caller).ref).events().slice(-count(args, "tail", EVENTS_TAIL))
    }),

    "editor-open": async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const root = deps.projectRefPath(ref);
      if (root === undefined) {
        throw new ControlError("not_found", `${projectRefKey(ref)} is not open`);
      }
      const typed = text(args, "path", "path");
      const filePath = repositoryRelative(root, path.resolve(root, typed));
      if (filePath === undefined) {
        throw new ControlError("bad_args", `not inside the repository: ${typed}`);
      }
      const keep = args.keep === true;
      // In `after`, so a file the sandbox check refuses is never opened.
      return { result: { opened: filePath, keep }, after: () => deps.openEditor(ref, filePath, keep) };
    },

    "editor-state": async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const report = deps.records.editor(ref);
      return { result: report ? { ...report, content: await deps.editorContent(ref) } : null };
    },

    "editor-list": (args, caller) => ({ result: deps.records.editors(refFrom(args, caller).ref) }),

    "explorer-list": async (args, caller) => ({ result: await repository(refFrom(args, caller).ref).listExplorer() }),

    "notices-list": () => ({ result: deps.records.notices() }),

    "tabs-create": (args, caller) => {
      const { ref } = refFrom(args, caller);
      const agent = openableAgent(args, caller);
      const prompt = args.prompt;
      if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim() === "")) {
        throw new ControlError("bad_args", "missing text after --prompt");
      }
      if (prompt !== undefined && !agent.terminal) {
        throw new ControlError("bad_args", `a ${agent.id} tab takes no prompt`);
      }
      const tab = terminals(ref).createTab(agent.id, caller.side.holdsTabs, prompt);
      deps.showTab(ref, tab.tabId);
      return { result: tab };
    },

    "tabs-handoff": async (args, caller) => {
      const { tabs, tabId, ref } = ownedTab(args, caller);
      const handed = await tabs.handOff(tabId, openableAgent(args, caller).id, caller.side.holdsTabs);
      if (typeof handed === "string") {
        // A state the tab is in, not a mistyped call — as tabs-rename's refusal.
        throw new ControlError("internal", handed);
      }
      deps.showTab(ref, handed.tabId);
      return { result: handed };
    },

    "tabs-run-command": async (args, caller) => {
      const { project: found, ref } = refFrom(args, caller);
      const name = text(args, "name", "command name");
      const commands = await deps.readCommands(found.path);
      // By name or by the line itself — an agent reading tet.json may hold either.
      const command = commands.find((candidate) => candidate.name === name || candidate.command === name);
      if (!command) {
        throw new ControlError("not_found", `no saved command named ${name} in ${found.name}'s tet.json`);
      }
      const tab = terminals(ref).createCommandTab(command);
      if (!tab) {
        // createCommandTab already showed a notice saying why.
        throw new ControlError("bad_args", `${name} cannot be run without a shell — see the notice in TET`);
      }
      deps.showTab(ref, tab.tabId);
      return { result: tab };
    },

    "tabs-close": (args, caller) => {
      const { tabs, tabId, own } = ownedTab(args, caller);
      const close = (): void => void tabs.closeTabs([tabId]);
      // Closing the tab the CLI runs in kills the CLI — answer first.
      if (own) {
        return { result: { closed: tabId }, after: close };
      }
      close();
      return { result: { closed: tabId } };
    },

    "tabs-rename": async (args, caller) => {
      const { tabs, tabId } = ownedTab(args, caller);
      const refused = await tabs.renameTab(tabId, text(args, "title", "title"));
      if (refused !== undefined) {
        throw new ControlError("internal", refused);
      }
      return { result: { renamed: tabId } };
    },

    "restart-app": (args) => {
      if (args.confirm !== true) {
        throw new ControlError(
          "bad_args",
          "restart-app ends every terminal in every open project, this one included. Ask the user, then pass --confirm."
        );
      }
      return { result: { restarting: true }, after: () => deps.shutdown(true) };
    },

    notify: (args, caller) => {
      const body = args.body;
      // From one of tet's terminals, the toast is about that tab.
      const own = callerRef(caller);
      const target = own && caller.tabId ? { ref: own, tabId: caller.tabId } : undefined;
      deps.notify(text(args, "title", "title"), typeof body === "string" ? body : "", target);
      return { result: { notified: true } };
    },

    hook: (args, caller, at) => {
      const event = oneOf(args, "event", "hook event", HOOK_EVENTS);
      if (!caller.tabId) {
        throw new ControlError("bad_args", "a hook reports for the tab it runs in, and this is not one");
      }
      const payload = typeof args.payload === "string" ? args.payload : "";
      // The caller's own, never `--project`: the token vouches for its tab in its repository or
      // worktree only, and tab ids like `new-1` repeat across repositories and worktrees.
      const where = refFrom({}, caller).ref;
      const outcome = terminals(where).hookEvent(caller.tabId, event, payload, at, caller.side);
      if (outcome.toast) {
        deps.notify(outcome.toast.title, outcome.toast.body, { ref: where, tabId: caller.tabId });
      }
      return { result: { stdout: outcome.stdout } };
    }
  };
}

function reject(code: ControlErrorCode, message: string): ControlResponse {
  return { ok: false, error: { code, message } };
}

/** A tet-ctl writes its request at once. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long a request may be, checked while it arrives — see the read in `startControlServer`. */
const MAX_REQUEST_CHARS = 1024 * 1024;

/**
 * The server `tet-ctl` talks to: one POST per connection on 127.0.0.1. HTTP, not raw TCP, because
 * a sandbox reaches `host.docker.internal` through sbx's HTTP-only proxy. Every request must
 * carry this run's token from
 * main.ts, or its tab's token for the caller ids it names (control-token.ts), else `unauthorized`.
 */
export async function startControlServer(
  deps: ControlDeps,
  token: string,
  port: number
): Promise<{ close: () => Promise<void> }> {
  const handlers = verbs(deps);

  const handle = async (
    request: ControlRequest,
    gone: AbortSignal
  ): Promise<{ response: ControlResponse; after?: () => void }> => {
    const caller: ControlRequest["caller"] = {
      projectId: typeof request.caller?.projectId === "string" ? request.caller.projectId : undefined,
      worktree: typeof request.caller?.worktree === "string" && request.caller.worktree ? request.caller.worktree : undefined,
      tabId: typeof request.caller?.tabId === "string" ? request.caller.tabId : undefined
    };
    // A caller's ids count only with the token made for them; the run's own token speaks for no
    // tab, and no terminal has it (control-token.ts).
    const given = Buffer.from(typeof request.token === "string" ? request.token : "");
    const matches = (expected: string): boolean => {
      const want = Buffer.from(expected);
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    };
    // A caller naming no tab is the run itself, on this machine. For a tab, which side's token
    // matches says where it runs: read off the token, not looked up, so a tab closed with its
    // repository or worktree is still answered by the rules it started under (control-token.ts).
    const ofTab = caller.projectId !== undefined || caller.worktree !== undefined || caller.tabId !== undefined;
    const side = ofTab
      ? CALLER_SIDES.find((candidate) =>
          matches(tabControlToken(token, { projectId: caller.projectId ?? "", worktree: caller.worktree }, caller.tabId ?? "", candidate))
        )
      : matches(token)
        ? HOST_CALLER
        : undefined;
    if (!side) {
      return { response: reject("unauthorized", "not a terminal of this TET") };
    }
    const entry = request.verb === HELP_VERB ? undefined : CONTROL_VERBS.find((candidate) => candidate.verb === request.verb);
    // Widened to look up by the request's name: every listed verb has its handler (Handlers).
    const handler = entry && (handlers as Record<string, Handler | undefined>)[entry.verb];
    if (!entry || !handler) {
      return { response: reject("unknown_verb", `unknown verb: ${String(request.verb)} (see tet-ctl help)`) };
    }
    if (!side.admits(entry)) {
      return { response: reject("unauthorized", `${request.verb} ${side.refusal}`) };
    }
    // A host tab reaches every repository and worktree of its project (a worktree belongs to it); a
    // sandboxed one only its own, the one its sandbox mounts — but for an `ownProject` verb.
    const own = callerRef(caller);
    const reach = side.reach(entry);
    if (reach !== "any") {
      const ownOnly = reach === "ownRef";
      let target: ProjectRef | undefined;
      try {
        target = own && resolveCallerRef(deps.store, request.args ?? {}, caller).ref;
      } catch (error) {
        return { response: error instanceof ControlError ? reject(error.code, error.message) : reject("internal", errorMessage(error)) };
      }
      const allowed = own !== undefined && target !== undefined && (ownOnly ? sameProjectRef(target, own) : target.projectId === own.projectId);
      if (!allowed) {
        const whose = ownOnly ? "the caller's own repository or worktree" : "the caller's own project";
        return { response: reject("unauthorized", `${request.verb} only answers for ${whose}`) };
      }
    }
    try {
      const answer = await handler(request.args ?? {}, { ...caller, side }, request.at, gone);
      await side.checkAnswer(entry, answer.result, own && deps.projectRefPath(own));
      return { response: { ok: true, result: answer.result }, after: answer.after };
    } catch (error) {
      if (error instanceof ControlError) {
        return { response: reject(error.code, error.message) };
      }
      return { response: reject("internal", errorMessage(error)) };
    }
  };

  const respond = (res: http.ServerResponse, response: ControlResponse, after?: () => void): void => {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    if (after) {
      // `close` means flushed and disconnected, not merely handed to the OS.
      res.once("close", after);
    }
    res.end(JSON.stringify(response) + "\n");
  };

  const server = http.createServer({ requestTimeout: REQUEST_TIMEOUT_MS }, (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Connection: "close" }).end();
      return;
    }
    req.setEncoding("utf8");
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk: string) => {
      if (tooLarge) {
        return;
      }
      body += chunk;
      // The token is only checked once the body is whole, so an unauthenticated caller would
      // otherwise decide how much of this process's memory to take. Well past the longest real
      // request (`tabs-create`'s prompt) and nowhere near what would hurt.
      //
      // Nothing is kept from here on, but the rest is still read and dropped, and the answer waits
      // for `end` like any other: closing the connection early (`req.destroy()`, or answering while
      // the caller still writes) reaches it as ECONNRESET instead of the refusal.
      if (body.length > MAX_REQUEST_CHARS) {
        tooLarge = true;
        body = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        respond(res, reject("bad_args", `the request is longer than ${MAX_REQUEST_CHARS} characters`));
        return;
      }
      let request: ControlRequest;
      try {
        request = JSON.parse(body) as ControlRequest;
      } catch {
        respond(res, reject("bad_args", "not a JSON request"));
        return;
      }
      // A non-object would throw inside `handle`, leaving the connection unanswered.
      if (!isRecord(request)) {
        respond(res, reject("bad_args", "not a JSON request"));
        return;
      }
      // A response closed before it ended is a caller gone mid-answer (Ctrl+C on a waiting CLI).
      const gone = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) {
          gone.abort();
        }
      });
      void handle(request, gone.signal).then(({ response, after }) => respond(res, response, after));
    });
    req.on("error", () => undefined);
    // A response write failing after hand-over (CLI gone, reset, or this process exiting) is
    // otherwise an uncaught exception, e.g. `write EAGAIN`.
    res.on("error", () => undefined);
  });

  // The OS reclaims a killed run's port, so EADDRINUSE means another tet is listening: let it surface.
  await bind(server, port);

  return {
    // closeAllConnections: else an unfinished request holds server.close() open forever.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

function bind(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, CONTROL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
