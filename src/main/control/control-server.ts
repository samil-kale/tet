import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { stripAnsi } from "../../shared/ansi";
import { errorMessage } from "../../shared/errors";
import { CONTROL_HOST, CONTROL_VERBS, HELP_VERB, HOOK_EVENTS } from "../../shared/control";
import type { ControlErrorCode, ControlEvent, ControlRequest, ControlResponse, HookEvent } from "../../shared/control";
import { THEMES, themeKey } from "../../shared/themes";
import { COLOR_SCHEMES, PROMPT_IDS, TERMINAL_STATUSES, closedWith, isSbxAgent, isWorking } from "../../shared/types";
import type {
  AddRepositoryResult,
  AgentId,
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
  SbxStatus,
  SbxStoredLocal,
  SbxValueKind,
  TerminalDescriptor,
  WorktreeRef
} from "../../shared/types";
import { systemPrompt } from "../agents/system-prompt";
import { isEnvName, isReservedName } from "../../shared/env-rules";
import { machineName } from "../env-names";
import type { EnvRequests, EnvStore } from "../environment";
import { relativeInside, repositoryRelative } from "../path-inside";
import type { ProjectLookup } from "../projects";
import type { SettingsAccess } from "../settings";
import { tabControlToken } from "./control-token";
import { sbxVerbs } from "./control-sbx-verbs";
import { ControlError, count, text, type Caller, type Handler } from "./control-verb";
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
    get(projectId: string): ControlTerminals | undefined;
  };
  repositories: {
    get(projectId: string): { getState(): RepositoryState; listExplorer(): Promise<ExplorerListing> } | undefined;
  };
  /** See ControlRecords. */
  records: {
    editor(projectId: string): EditorReport | undefined;
    editors(projectId: string): EditorListing[];
    notices(): NoticeReport[];
    output(projectId: string, tabId: string): string | undefined;
  };
  /** Opens a file in the project's preview tab, or a kept tab, and brings it to the front. */
  openEditor(projectId: string, path: string, keep: boolean): void;
  /** The active editor tab's text, asked of the window live — the one thing not kept as a report
   *  (see EditorReport). */
  editorContent(projectId: string): Promise<string | undefined>;
  /** The requirements dialog's answer, by id. */
  listAgents(): Promise<{ id: AgentId; name: string; installed: boolean }[]>;
  /** `AGENTS`' ids, so a new agent needs nothing here. */
  agentIds: readonly string[];
  /** projects.ts's, which tell the window their outcome themselves (projectsChanged). */
  addProject(directory: string): Promise<AddRepositoryResult>;
  removeProject(projectId: string): void;
  addWorktree(projectId: string, branch: string): Promise<AddRepositoryResult>;
  deleteWorktree(worktree: WorktreeRef, force: boolean): Promise<GitActionResult>;
  readCommands(root: string): Promise<ProjectCommand[]>;
  /** main.ts's teardown: ends every session and quits, optionally relaunching. */
  shutdown(relaunch: boolean): void;
  /** Its process starts with the first resize that draws it. */
  showTab(projectId: string, tabId: string): void;
  /** A desktop toast from this process, which holds the desktop session (a sandboxed hook has
   *  none). Must never throw: `hook` toasts on the way to answering a turn. A click brings
   *  `target` to the front. */
  notify(title: string, body: string, target?: ToastTarget): void;
  /** main.ts's `applyTheme`: returns whether a restart is still needed. */
  applyTheme(): boolean;
  /** main.ts's, shared with ipc/environment.ts. */
  environment: Pick<EnvStore, "list" | "remove">;
  envRequests: Pick<EnvRequests, "ask">;
  /** The SBX Settings dialog's reads and Save (ipc/sbx.ts, sbx-settings.ts). */
  sbx: {
    status(project: Project): Promise<SbxStatus>;
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
      status?: SbxStatus
    ): Promise<SbxProblems>;
    save(project: Project, request: SbxProjectConfig, local: SbxLocalSave, status?: SbxStatus): Promise<SbxSaveResult>;
    /** The access tokens kept for every project (sbx-accounts.ts), never a token. */
    accounts(): SbxAccount[];
    /** sbx.ts's readSbxUser: only once the status said signed in. */
    signedInUser(): Promise<string | undefined>;
    /** sbx-accounts.ts's signInToSbx with the token kept for that account. */
    signIn(account: SbxAccount): Promise<SbxSignInResult>;
  };
}

export interface ToastTarget {
  projectId: string;
  tabId: string;
}

/** See ControlTerminals.hookEvent. */
export interface HookToast {
  title: string;
  body: string;
}

export interface HookOutcome {
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

/** The slice of ProjectSessionManager the verbs use. */
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
  /** `sandboxOnly`: opened from a sandbox, so it never runs on this machine. */
  createTab(agentId: AgentId, sandboxOnly: boolean): TerminalDescriptor;
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined;
  closeTabs(tabIds: string[]): Promise<void>;
  /** The agent's refusal, or nothing when it went through. */
  renameTab(tabId: string, title: string): Promise<string | undefined>;
  /** `at` is when the hook fired, not arrived (ControlRequest.at). An unknown tab is no error: it
   *  may have closed while its CLI ended the turn. */
  hookEvent(tabId: string, event: HookEvent, payload: string, at: number | undefined): HookOutcome;
}

/**
 * The file an answer names (`ControlVerb.sandboxFile`), refused where it is missing or resolves,
 * links followed, outside the repository: a link committed or made in the mounted repository would
 * otherwise hand a sandboxed caller a file of this machine through the editor. Missing too, since
 * the editor still holds what it last read. An answer naming none is nothing to refuse.
 */
async function assertSandboxFile(root: string | undefined, result: unknown, key: string): Promise<void> {
  const named = (result as Record<string, unknown> | null | undefined)?.[key];
  if (named === undefined || named === null) {
    return;
  }
  const relative = typeof named === "string" ? named : undefined;
  const resolved =
    root === undefined || relative === undefined
      ? undefined
      : await Promise.all([root, path.join(root, relative)].map((entry) => fs.promises.realpath(path.resolve(entry)))).catch(
          () => undefined
        );
  if (!resolved || relativeInside(resolved[0], resolved[1]) === undefined) {
    throw new ControlError("unauthorized", `${String(named)} is missing or leads outside the repository`);
  }
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

/**
 * What a hook prints back into its agent. `{}` rather than nothing: Codex parses its Stop hook's
 * stdout as JSON, and every agent takes JSON on hook channels not appended to the prompt
 * (measured). `prompt-submit`'s stdout would be appended to the prompt: "". `session-start`
 * carries TET's system prompt as added context, appended to the user's instructions (measured,
 * Codex 0.154.0: in the first turn, and again on `resume`) — a sandbox's without the environment
 * variables.
 */
const HOOK_STDOUT: Record<HookEvent, (sandboxed: boolean) => string> = {
  "session-start": (sandboxed) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: systemPrompt(sandboxed) }
    }),
  "prompt-submit": () => "",
  stop: () => "{}",
  permission: () => "{}",
  question: () => "{}",
  idle: () => "{}"
};

const DYNAMIC_PORT_START = 49152;
const DYNAMIC_PORT_RANGE = 65535 - DYNAMIC_PORT_START;

/** The preferred port for this data folder, before checking it is free. */
function hashPort(dataRoot: string): number {
  const hash = crypto.createHash("sha1").update(dataRoot).digest("hex");
  return DYNAMIC_PORT_START + (parseInt(hash.slice(0, 8), 16) % DYNAMIC_PORT_RANGE);
}

/**
 * Derived from the data folder (data-root.ts), so two accounts, or a test profile beside the tet it
 * runs in, get ports of their own. Probed by binding: Windows excludes dynamic-range pieces for
 * Hyper-V/WSL/Docker NAT (`netsh int ipv4 show excludedportrange`), failing with `EACCES` — static
 * enough to reuse the probed port. Not OS-assigned: the port must be in every terminal's
 * environment (setControlEnv) before the server starts.
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

function verbs(deps: ControlDeps): Record<string, Handler> {
  const { store, settings, sessions } = deps;

  const projectById = (id: string): Project => {
    const found = store.get(id);
    if (!found) {
      throw new ControlError("not_found", `unknown project: ${id}`);
    }
    return found;
  };

  const project = (args: Record<string, unknown>, caller: ControlRequest["caller"]): Project => {
    const id = typeof args.project === "string" && args.project ? args.project : caller.projectId;
    if (!id) {
      throw new ControlError("bad_args", "no project: pass --project <id> (see projects-list)");
    }
    return projectById(id);
  };

  const terminals = (found: Project): ControlTerminals => {
    const manager = sessions.get(found.id);
    if (!manager) {
      throw new ControlError("internal", `project ${found.id} has no terminals`);
    }
    return manager;
  };

  const repository = (found: Project): NonNullable<ReturnType<ControlDeps["repositories"]["get"]>> => {
    const repo = deps.repositories.get(found.id);
    if (!repo) {
      throw new ControlError("internal", `project ${found.id} has no repository`);
    }
    return repo;
  };

  /** A tab id checked to exist, with its project and terminals. */
  const knownTab = (args: Record<string, unknown>, caller: ControlRequest["caller"]): { tabs: ControlTerminals; tabId: string; found: Project } => {
    const found = project(args, caller);
    const tabId = text(args, "tabId", "tab id");
    const tabs = terminals(found);
    if (!tabs.snapshot().some((tab) => tab.tabId === tabId)) {
      throw new ControlError("not_found", `unknown tab: ${tabId} (see tabs-list)`);
    }
    return { tabs, tabId, found };
  };

  /** `knownTab` for a verb reaching into the tab (its output, its session): from a sandbox, only its
   *  own tab or one known to run there — a host tab is this machine's, which a sandbox never reaches,
   *  and its output may print the host's control token. */
  const ownedTab = (args: Record<string, unknown>, caller: Caller) => {
    const known = knownTab(args, caller);
    const own = known.found.id === caller.projectId && known.tabId === caller.tabId;
    const tab = known.tabs.inspect().find((entry) => entry.tabId === known.tabId);
    if (caller.sandboxed && !own && tab?.sandbox === undefined && tab?.sandboxOnly !== true) {
      throw new ControlError("bad_args", `${known.tabId} runs on this machine, not in the sandbox`);
    }
    return known;
  };

  return {
    ...sbxVerbs(deps, project),

    version: () => ({ result: { version: deps.version, pid: deps.pid } }),

    "list-themes": () => ({ result: THEMES.map(({ id, label, kind }) => ({ id, label, kind })) }),

    "list-agents": async () => ({ result: await deps.listAgents() }),

    "settings-get": () => ({ result: settings.get() }),

    "settings-set-theme": (args) => {
      const id = text(args, "theme", "theme id");
      // The store keeps any string and silently falls back (settings.ts); refuse it here instead.
      const theme = THEMES.find((candidate) => candidate.id === id);
      if (!theme) {
        throw new ControlError("bad_args", `unknown theme: ${id} (see list-themes)`);
      }
      settings.patch({ [themeKey(theme.kind)]: id });
      // Shown at once if the window is in that kind. The flag is for the agent to relay; restarting
      // is the user's call.
      return { result: { saved: true, restartRequired: deps.applyTheme() } };
    },

    "settings-set-color-scheme": (args) => {
      const value = text(args, "scheme", "color scheme");
      const colorScheme = COLOR_SCHEMES.find((candidate) => candidate === value);
      if (!colorScheme) {
        throw new ControlError("bad_args", `unknown color scheme: ${value} (one of ${COLOR_SCHEMES.join(", ")})`);
      }
      settings.patch({ colorScheme });
      // A kind the window is not drawn in waits for a restart (main.ts's applyTheme).
      return { result: { saved: true, restartRequired: deps.applyTheme() } };
    },

    "settings-set-prompt": (args) => {
      const id = text(args, "id", "prompt id");
      if (!PROMPT_IDS.some((candidate) => candidate === id)) {
        throw new ControlError("bad_args", `unknown prompt: ${id} (one of ${PROMPT_IDS.join(", ")})`);
      }
      // No text resets: "" means tet's own prompt, read by ipc/repository.ts when asking.
      const value = args.text;
      settings.patch({ prompts: { [id]: typeof value === "string" ? value : "" } });
      return { result: { saved: true } };
    },

    // A sandbox sees its own project only: the others' paths are outside what it mounts.
    "projects-list": (_args, caller) => ({
      result: store.list().filter((entry) => !caller.sandboxed || entry.id === caller.projectId)
    }),

    "repo-state": (args, caller) => ({ result: repository(project(args, caller)).getState() }),

    "projects-add": async (args) => {
      const added = await deps.addProject(text(args, "path", "path"));
      if (!added.project) {
        throw new ControlError("bad_args", added.error ?? "could not open the folder");
      }
      return { result: added.project };
    },

    "projects-remove": (args, caller) => {
      const id = text(args, "projectId", "project id");
      projectById(id);
      const closing = closedWith(store.list(), id);
      // Only the window asks about unsaved edits (App's closeProject); from here they would be lost.
      const unsaved = closing.flatMap((closed) => deps.records.editors(closed)).filter((editor) => editor.dirty);
      if (unsaved.length > 0) {
        throw new ControlError("bad_args", `unsaved changes in ${unsaved.map((editor) => editor.path).join(", ")} — save or close them in TET first`);
      }
      // The caller's own project takes the caller's tab with it — answer first.
      if (caller.projectId !== undefined && closing.includes(caller.projectId)) {
        return { result: { removed: id }, after: () => deps.removeProject(id) };
      }
      deps.removeProject(id);
      return { result: { removed: id } };
    },

    "worktree-add": async (args, caller) => {
      const added = await deps.addWorktree(project(args, caller).id, text(args, "branch", "branch"));
      if (!added.project) {
        throw new ControlError("bad_args", added.error ?? "could not create the worktree");
      }
      return { result: added.project };
    },

    // Named by its branch within the project's repository, as worktree-add names it, so a worktree
    // of another repository cannot be reached. Not the caller's own: it would end the caller's tab
    // before the folder can go.
    "worktree-delete": async (args, caller) => {
      const found = project(args, caller);
      const branch = text(args, "branch", "branch");
      const { worktrees } = repository(found).getState();
      const main = worktrees.find((entry) => entry.main);
      const worktree = worktrees.find((entry) => !entry.main && entry.branch === branch);
      if (!main || !worktree) {
        throw new ControlError("not_found", `${found.name} has no worktree of branch ${branch}`);
      }
      if (worktree.path === store.get(caller.projectId ?? "")?.path) {
        throw new ControlError("bad_args", "a worktree cannot delete itself: run this from another project's tab");
      }
      const deleted = await deps.deleteWorktree({ path: worktree.path, mainPath: main.path }, args.force === true);
      if (deleted.needsConfirmation === "uncommitted") {
        throw new ControlError("bad_args", `${branch} has uncommitted changes: pass --force to delete them too`);
      }
      if (!deleted.ok) {
        throw new ControlError("bad_args", deleted.error ?? "could not delete the worktree");
      }
      return { result: { deleted: branch } };
    },

    "env-request": async (args, caller, _at, gone) => {
      const names = Array.isArray(args.names) ? args.names.filter((name): name is string => typeof name === "string" && name !== "") : [];
      if (names.length === 0) {
        throw new ControlError("bad_args", "missing variable names: env-request NAME [NAME...]");
      }
      const invalid = names.find((name) => !isEnvName(name));
      if (invalid) {
        throw new ControlError("bad_args", `not an environment variable name: ${invalid}`);
      }
      const reserved = names.find(isReservedName);
      if (reserved) {
        throw new ControlError("bad_args", `${reserved} is TET's own to set in a tab (PATH, TET_*)`);
      }
      // Once per variable as the machine counts them: on win32 `a` and `A` are one.
      const unique = names.filter((name, index) => names.findIndex((other) => machineName(other) === machineName(name)) === index);
      const saved = await deps.envRequests.ask(
        { projectId: caller.projectId, tabId: caller.tabId, names: unique },
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

    "tabs-list": (args, caller) => ({ result: terminals(project(args, caller)).inspect() }),

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
      const status = args.status;
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
      if (typeof status === "string") {
        if (!TERMINAL_STATUSES.some((candidate) => candidate === status)) {
          throw new ControlError("bad_args", `unknown status: ${status} (one of ${TERMINAL_STATUSES.join(", ")})`);
        }
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

    "tabs-send": (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      const value = args.text;
      if (typeof value !== "string" && args.enter !== true) {
        throw new ControlError("bad_args", "missing text (or --enter for Enter alone)");
      }
      tabs.write(tabId, `${typeof value === "string" ? value : ""}${args.enter === true ? "\r" : ""}`);
      return { result: { sent: tabId } };
    },

    "tabs-output": (args, caller) => {
      const { tabId, found } = ownedTab(args, caller);
      const output = shownText(deps.records.output(found.id, tabId) ?? "");
      return { result: { output: output.slice(-count(args, "kb", OUTPUT_KB) * 1024) } };
    },

    "events-tail": (args, caller) => ({
      result: terminals(project(args, caller)).events().slice(-count(args, "tail", EVENTS_TAIL))
    }),

    "editor-open": async (args, caller) => {
      const found = project(args, caller);
      const typed = text(args, "path", "path");
      const filePath = repositoryRelative(found.path, path.resolve(found.path, typed));
      if (filePath === undefined) {
        throw new ControlError("bad_args", `not inside the repository: ${typed}`);
      }
      const keep = args.keep === true;
      // In `after`, so a file the sandbox check refuses is never opened.
      return { result: { opened: filePath, keep }, after: () => deps.openEditor(found.id, filePath, keep) };
    },

    "editor-state": async (args, caller) => {
      const found = project(args, caller);
      const report = deps.records.editor(found.id);
      return { result: report ? { ...report, content: await deps.editorContent(found.id) } : null };
    },

    "editor-list": (args, caller) => ({ result: deps.records.editors(project(args, caller).id) }),

    "explorer-list": async (args, caller) => ({ result: await repository(project(args, caller)).listExplorer() }),

    "notices-list": () => ({ result: deps.records.notices() }),

    "tabs-create": (args, caller) => {
      const found = project(args, caller);
      const agent = text(args, "agent", "agent: pass --agent <id> (see list-agents)");
      if (!deps.agentIds.includes(agent)) {
        throw new ControlError("bad_args", `unknown agent: ${agent} (see list-agents)`);
      }
      // A shell would run on this machine; an sbx agent's tab is held to the sandbox (createTab).
      if (caller.sandboxed && !isSbxAgent(agent)) {
        throw new ControlError("unauthorized", `a ${agent} tab does not run in a sandbox, so a sandbox cannot open one`);
      }
      const tab = terminals(found).createTab(agent as AgentId, caller.sandboxed);
      deps.showTab(found.id, tab.tabId);
      return { result: tab };
    },

    "tabs-run-command": async (args, caller) => {
      const found = project(args, caller);
      const name = text(args, "name", "command name");
      const commands = await deps.readCommands(found.path);
      // By name or by the line itself — an agent reading tet.json may hold either.
      const command = commands.find((candidate) => candidate.name === name || candidate.command === name);
      if (!command) {
        throw new ControlError("not_found", `no saved command named ${name} in ${found.name}'s tet.json`);
      }
      const tab = terminals(found).createCommandTab(command);
      if (!tab) {
        // createCommandTab already showed a notice saying why.
        throw new ControlError("bad_args", `${name} cannot be run without a shell — see the notice in TET`);
      }
      deps.showTab(found.id, tab.tabId);
      return { result: tab };
    },

    "tabs-close": (args, caller) => {
      const { tabs, tabId, found } = ownedTab(args, caller);
      const close = (): void => void tabs.closeTabs([tabId]);
      // Closing the tab the CLI runs in kills the CLI — answer first.
      if (found.id === caller.projectId && tabId === caller.tabId) {
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
      const target = caller.projectId && caller.tabId ? { projectId: caller.projectId, tabId: caller.tabId } : undefined;
      deps.notify(text(args, "title", "title"), typeof body === "string" ? body : "", target);
      return { result: { notified: true } };
    },

    hook: (args, caller, at) => {
      const event = text(args, "event", "hook event");
      if (!HOOK_EVENTS.some((candidate) => candidate === event)) {
        throw new ControlError("bad_args", `unknown hook event: ${event} (one of ${HOOK_EVENTS.join(", ")})`);
      }
      if (!caller.tabId) {
        throw new ControlError("bad_args", "a hook reports for the tab it runs in, and this is not one");
      }
      const payload = typeof args.payload === "string" ? args.payload : "";
      // The caller's own, never `--project`: the token vouches for its tab in its project only, and
      // tab ids like `new-1` repeat across projects.
      const where = project({}, caller);
      const outcome = terminals(where).hookEvent(caller.tabId, event as HookEvent, payload, at);
      if (outcome.toast) {
        deps.notify(outcome.toast.title, outcome.toast.body, { projectId: where.id, tabId: caller.tabId });
      }
      return { result: { stdout: HOOK_STDOUT[event as HookEvent](caller.sandboxed) } };
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
 * a sandbox reaches `host.docker.internal` through sbx's HTTP-only proxy (measured: raw TCP
 * connects but no bytes arrive; curl works). Every request must carry this run's token from
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
      tabId: typeof request.caller?.tabId === "string" ? request.caller.tabId : undefined
    };
    // A caller's ids count only with the token made for them; the run's own token speaks for no
    // tab, and no terminal has it (control-token.ts).
    const given = Buffer.from(typeof request.token === "string" ? request.token : "");
    const matches = (expected: string): boolean => {
      const want = Buffer.from(expected);
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    };
    // A caller naming no tab is the run itself. For a tab, which of its two tokens matches says
    // whether it runs in a sandbox: read off the token, not looked up, so a tab closed with its
    // project is still answered by the rules it started under (control-token.ts).
    const ofTab = caller.projectId !== undefined || caller.tabId !== undefined;
    const tokenOf = (sandbox: boolean): string => tabControlToken(token, caller.projectId ?? "", caller.tabId ?? "", sandbox);
    const sandboxed = ofTab && matches(tokenOf(true));
    if (!(ofTab ? sandboxed || matches(tokenOf(false)) : matches(token))) {
      return { response: reject("unauthorized", "not a terminal of this TET") };
    }
    const entry = request.verb === HELP_VERB ? undefined : CONTROL_VERBS.find((candidate) => candidate.verb === request.verb);
    const handler = entry && handlers[entry.verb];
    if (!entry || !handler) {
      return { response: reject("unknown_verb", `unknown verb: ${String(request.verb)} (see tet-ctl help)`) };
    }
    if (sandboxed && !entry.sandbox) {
      return { response: reject("unauthorized", `${request.verb} does not answer from inside a sandbox`) };
    }
    if (entry.ownProjectOnly || (sandboxed && entry.sandbox === "ownProject")) {
      const own = caller.projectId;
      const asked = request.args?.project;
      if (!own || (typeof asked === "string" && asked !== "" && asked !== own)) {
        return { response: reject("unauthorized", `${request.verb} only answers for a tab of the caller's own project`) };
      }
    }
    try {
      const answer = await handler(request.args ?? {}, { ...caller, sandboxed }, request.at, gone);
      if (sandboxed && entry.sandboxFile !== undefined) {
        await assertSandboxFile(deps.store.get(caller.projectId ?? "")?.path, answer.result, entry.sandboxFile);
      }
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
      // request (`tabs-send`'s text) and nowhere near what would hurt.
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
    // closeAllConnections (Node 18.2+): else an unfinished request holds server.close() open forever.
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
