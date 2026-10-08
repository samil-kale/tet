import type { ControlErrorCode, ControlEvent, ControlRequest, HookEvent } from "../../shared/ctl";
import { projectRef } from "../../shared/types/project";
import type { AgentId, AskModelsResult } from "../../shared/types/agents";
import type { EditorListing, EditorReport, NoticeReport } from "../../shared/types/app";
import type { ExplorerListing, ExplorerSettings } from "../../shared/types/files";
import type { GitActionResult, RepositoryState } from "../../shared/types/git";
import type { AddRepositoryResult, Project, ProjectCommand, ProjectRef } from "../../shared/types/project";
import type {
  SbxAccount,
  SbxKnowledgeSettings,
  SbxLocalSave,
  SbxProblems,
  SbxProjectSettings,
  SbxSaveResult,
  SbxSignInResult,
  SbxStoredLocal,
  SbxValueKind,
} from "../../shared/types/sbx";
import type { TabDescriptor } from "../../shared/types/terminals";
import type { AgentDefinition } from "../agents/agent";
import type { BrowserAutomation } from "../browser/browser-client";
import type { BrowserSandbox, BrowserTabs } from "../browser/browser-tabs";
import type { NotificationTarget } from "../util/notifications";
import type { SbxReading } from "../sbx/sbx-status";
import type { HookOutcome, InspectedTab } from "../terminals/session-manager";
import type { CallerSide } from "./caller-side";
import type { EnvStore } from "../store/environment";
import type { EnvRequests } from "./env-requests";
import type { ProjectLookup } from "../store/project-store";
import { notOpenMessage, PROJECT_NOT_FOUND } from "../store/resolved-ref";
import type { SettingsAccess } from "../store/settings";

/** What a verb is made of, shared by ctl-server.ts and the verb files beside it: the handler,
 *  its dependencies (ControlDeps) and the lookups every verb file uses. */

export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** `after` runs once the response reached the CLI: a verb ending the caller's process must reply
 *  first, or the CLI dies with an empty stdout. */
export interface Answer {
  result: unknown;
  after?: () => void;
}

/** The request's caller, and the side its tab runs on (CallerSide). */
export type Caller = ControlRequest["caller"] & { side: CallerSide };

export type Handler = (
  args: Record<string, unknown>,
  caller: Caller,
  /** See ControlRequest.at. */
  at: number | undefined,
  /** Aborted once the CLI is gone (Ctrl+C) before its answer: nothing waits for it any more. */
  gone: AbortSignal,
) => Promise<Answer> | Answer;

export function text(args: Record<string, unknown>, name: string, what: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new ControlError("bad_args", `missing ${what}`);
  }
  return value;
}

/** One of `values`, typed as it: anything else is refused with the list to pick from. */
export function oneOf<T extends string>(args: Record<string, unknown>, name: string, what: string, values: readonly T[]): T {
  const value = text(args, name, what);
  const known = values.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new ControlError("bad_args", `unknown ${what}: ${value} (one of ${values.join(", ")})`);
  }
  return known;
}

/** A switch's `on` or `off`, as true or false. */
export function onOff(args: Record<string, unknown>, name: string): boolean {
  return oneOf(args, name, "value", ["on", "off"]) === "on";
}

/** A text flag or positional, undefined when absent or empty. */
export function optionalText(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The server's lookup of the repository or worktree a verb acts on (resolveCallerRef). */
export type RefFrom = (args: Record<string, unknown>, caller: ControlRequest["caller"]) => { project: Project; ref: ProjectRef };

/** A positive integer flag, or `fallback` when absent. */
export function count(args: Record<string, unknown>, name: string, fallback: number): number {
  if (args[name] === undefined) {
    return fallback;
  }
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ControlError("bad_args", `--${name} takes a positive whole number`);
  }
  return value;
}

/** A variadic positional's arguments; none is an empty list. */
export function list(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Handed over by main.ts, not imported: no electron or node-pty here, so test/main/ctl.test.ts
 * runs the server under plain node with these faked. The same singletons ipc/ holds: a second
 * transport onto that logic, never a second implementation (projects.ts's
 * addProject/removeProject).
 */
export interface ControlDeps {
  version: string;
  /** Lets a test tell that app-restart replaced the process. */
  pid: number;
  store: ProjectLookup;
  settings: SettingsAccess;
  tabManagers: {
    get(ref: ProjectRef): ControlTerminals | undefined;
  };
  repositories: {
    get(ref: ProjectRef):
      | {
          at: { path: string };
          getState(): RepositoryState;
          listExplorer(settings: ExplorerSettings): Promise<ExplorerListing>;
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
  /** What a tab's terminal shows, asked of the window live: its xterm has parsed the output.
   *  undefined when the window does not answer. */
  terminalText(ref: ProjectRef, tabId: string): Promise<string | undefined>;
  /** agents/index.ts's listInstalledAgents: the requirements dialog's answer, by id. */
  listAgents(): Promise<{ id: AgentId; name: string; installed: boolean }[]>;
  /** `AGENTS`, so a new agent needs nothing here. */
  agents: readonly AgentDefinition[];
  /** agents/index.ts's listAskModels, the commit prompt's list. */
  askModels(agent: AgentDefinition, cwd: string): Promise<AskModelsResult>;
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
  /** A desktop notification from this process, which holds the desktop session (a sandboxed hook has
   *  none). Must never throw: `hook` notifications on the way to answering a turn. A click brings
   *  `target` to the front. */
  showDesktopNotification(title: string, body: string, target?: NotificationTarget): void;
  /** The browser tabs (browser/browser-tabs.ts) and Playwright driving their pages
   *  (browser/browser-client.ts). */
  browser: {
    tabs: Pick<BrowserTabs, "list" | "page" | "create" | "navigate" | "close" | "capture" | "downloads">;
    automation: BrowserAutomation["api"];
  };
  /** main.ts's, shared with ipc/environment.ts. */
  environment: Pick<EnvStore, "list" | "remove">;
  envRequests: Pick<EnvRequests, "ask">;
  /** The SBX Settings dialog's reads and Save (ipc/sbx.ts, sbx-settings.ts). */
  sbx: {
    /** sbx-status.ts's readSbxReading: the status, and what the verb's problems check reuses of it. */
    status(project: Project): Promise<SbxReading>;
    /** Whether an agent runs on this machine at all: without one, SBX cannot be disabled. */
    anyAgentInstalled(): Promise<boolean>;
    settings(project: Project): Promise<SbxProjectSettings>;
    stored(projectId: string): SbxStoredLocal;
    /** sbx-settings.ts's readProjectSbxProblems. */
    problems(
      project: Project,
      settings: SbxProjectSettings,
      knowledge: SbxKnowledgeSettings,
      values: Record<SbxValueKind, string[]>,
      reading?: SbxReading,
    ): Promise<SbxProblems>;
    /** sbx-settings.ts's saveProjectSbx: takes the status's organization, and lists the rest in its turn. */
    save(project: Project, request: SbxProjectSettings, local: SbxLocalSave, known?: Pick<SbxReading, "status">): Promise<SbxSaveResult>;
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

/** The slice of TabSessionManager the verbs use. */
export interface ControlTerminals {
  snapshot(): TabDescriptor[];
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
  createTab(agentId: AgentId, sandboxOnly: boolean, prompt?: string): TabDescriptor;
  /** The new tab taking over the tab's session, or why there is none. */
  handOver(tabId: string, agentId: AgentId, sandboxOnly: boolean): Promise<TabDescriptor | string>;
  createCommandTab(command: ProjectCommand): TabDescriptor | undefined;
  closeTabs(tabIds: string[]): Promise<void>;
  /** Where content without a path of its own lands for the tab (store/drops.ts). */
  dropsDir(tabId: string): string;
  /** The sandbox the tab's browser tabs load through; none on this machine (TabPlace.browserSandbox). */
  browserSandbox(tabId: string): BrowserSandbox | undefined;
  /** Host paths where the tab sees them, mounted into its sandbox where it would not; unquoted. */
  seenPaths(tabId: string, hostPaths: string[]): Promise<string[]>;
  /** The agent's refusal, or nothing when it went through. */
  renameTab(tabId: string, title: string): Promise<string | undefined>;
  /** `at` is when the hook fired, not arrived (ControlRequest.at). An unknown tab is no error: it
   *  may have closed while its CLI ended the turn. */
  hookEvent(tabId: string, event: HookEvent, payload: string, at: number | undefined, side: CallerSide): HookOutcome;
}

/** The repository or worktree the caller's tab runs in; undefined for the run itself. */
export function callerRef(caller: ControlRequest["caller"]): ProjectRef | undefined {
  return caller.projectId === undefined ? undefined : projectRef(caller.projectId, caller.worktree);
}

/** The caller's own tab and the terminals holding it; none for a caller outside a tab. */
export function callerTab(
  deps: Pick<ControlDeps, "tabManagers">,
  caller: Caller,
): { terminals: ControlTerminals; tabId: string } | undefined {
  const own = callerRef(caller);
  const terminals = own && deps.tabManagers.get(own);
  return terminals && caller.tabId !== undefined ? { terminals, tabId: caller.tabId } : undefined;
}

/** A path of this machine where the caller's tab sees it (TabPlace.handPaths): mounted into its
 *  sandbox where it would not; as it is where it is not handed, or for a caller outside a tab. */
export async function seenPath(deps: Pick<ControlDeps, "tabManagers">, caller: Caller, hostPath: string): Promise<string> {
  const own = callerTab(deps, caller);
  return (own && (await own.terminals.seenPaths(own.tabId, [hostPath]))[0]) ?? hostPath;
}

/** A worktree of the project TET made, named as `tet-ctl` names one: by its branch, or else by
 *  its key. One made elsewhere cannot be addressed: TET never opens it. */
export function tetWorktree(project: Project, name: string): { worktree: Project["worktrees"][number]; ref: ProjectRef } {
  const worktree = project.worktrees.find((entry) => entry.branch === name) ?? project.worktrees.find((entry) => entry.key === name);
  if (!worktree) {
    throw new ControlError("not_found", `${project.name} has no worktree ${name} (see projects-list)`);
  }
  if (worktree.key === undefined) {
    throw new ControlError("bad_args", `the worktree of ${name} was made elsewhere, which TET cannot reach: use git`);
  }
  return { worktree, ref: projectRef(project.id, worktree.key) };
}

/**
 * The repository or worktree a verb acts on: without flags the caller's own; `--project` alone that
 * project's repository; `--worktree` one of its worktrees TET made (tetWorktree). Also the gate's
 * answer to "is this the caller's own".
 */
export function resolveCallerRef(
  store: ProjectLookup,
  args: Record<string, unknown>,
  caller: ControlRequest["caller"],
): { project: Project; ref: ProjectRef } {
  const askedProject = optionalText(args, "project");
  const projectId = askedProject ?? caller.projectId;
  if (!projectId) {
    throw new ControlError("bad_args", "no project: pass --project <id> (see projects-list)");
  }
  const project = store.get(projectId);
  if (!project) {
    throw new ControlError("not_found", PROJECT_NOT_FOUND);
  }
  const asked = optionalText(args, "worktree");
  if (asked === undefined) {
    return { project, ref: projectRef(projectId, askedProject === undefined ? caller.worktree : undefined) };
  }
  return { project, ref: tetWorktree(project, asked).ref };
}

/** The repository's or worktree's git state; one closed meanwhile is an internal error. */
export function repositoryOf(
  deps: Pick<ControlDeps, "repositories" | "store">,
  ref: ProjectRef,
): NonNullable<ReturnType<ControlDeps["repositories"]["get"]>> {
  const repo = deps.repositories.get(ref);
  if (!repo) {
    throw new ControlError("internal", notOpenMessage(deps.store, ref));
  }
  return repo;
}

/** Only the window asks about unsaved edits; from here they would be lost, whatever --force says. */
export function refuseUnsaved(deps: Pick<ControlDeps, "records">, refs: ProjectRef[], outcome: string): void {
  const unsaved = refs.flatMap((ref) => deps.records.editors(ref)).filter((editor) => editor.dirty);
  if (unsaved.length > 0) {
    throw new ControlError(
      "bad_args",
      `unsaved changes in ${unsaved.map((editor) => editor.path).join(", ")}, ${outcome}: ask the user to save or close them in TET`,
    );
  }
}
