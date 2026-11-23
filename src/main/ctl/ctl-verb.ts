import { errorMessage } from "../../shared/errors";
import type {
  ControlErrorCode,
  ControlEvent,
  ControlRequest,
  ControlResults,
  ControlVerbName,
  HELP_VERB,
  HookEvent,
} from "../../shared/ctl";
import { projectRef } from "../../shared/types/project";
import type { AgentId, AskModelsResult } from "../../shared/types/agents";
import type { EditorListing, EditorReport, NoticeMark, NoticeReport, NoticeSeverity } from "../../shared/types/app";
import type { ExplorerListing, ExplorerSettings } from "../../shared/types/files";
import type { CheckoutTarget, GitActionResult, GitCommandResult, RepositoryState } from "../../shared/types/git";
import type { AddRepositoryResult, Project, ProjectCommand, ProjectRef } from "../../shared/types/project";
import type {
  ChangeRequestFilter,
  ChangeRequestKind,
  ChangeRequestRow,
  ChangeRequestsLatest,
  Issue,
  TrackedChange,
  TrackedFieldValue,
  IssueFilter,
  IssueListResult,
  TrackedLatest,
  TrackedDetail,
  TrackedKind,
  TrackedRef,
} from "../../shared/types/providers";
import type { ActionResult } from "../../shared/types/action";
import type { HandoverResult, TrackedSession, TrackedLinkResult, TabDescriptor, TabRef } from "../../shared/types/terminals";
import type { AgentDefinition } from "../agents/agent";
import type { IssueTrackerInfo } from "../../shared/types/providers";
import type { ListPage } from "../providers/provider";
import type { SbxAccess } from "../sbx/sbx-access";
import type { HookOutcome } from "../terminals/session-manager";
import type { InspectedTab } from "../../shared/types/terminals";
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
export interface Answer<R = unknown> {
  result: R;
  after?: () => void;
}

/** The request's caller, and the side its tab runs on (CallerSide). */
export type Caller = ControlRequest["caller"] & { side: CallerSide };

export type Handler<R = unknown> = (
  args: Record<string, unknown>,
  caller: Caller,
  /** See ControlRequest.at. */
  at: number | undefined,
  /** Aborted once the CLI is gone (Ctrl+C) before its answer: nothing waits for it any more. */
  gone: AbortSignal,
) => Promise<Answer<R>> | Answer<R>;

/** Every verb's handler but `help`, which the CLI answers itself, each held to its answer
 *  (`ControlResults`). */
export type Handlers = { [V in Exclude<ControlVerbName, typeof HELP_VERB>]: Handler<ControlResults[V]> };

/** The handlers of the verbs whose names start with `prefix`, for the verb files beside this one. */
export type HandlersOf<Prefix extends string> = Pick<Handlers, Extract<keyof Handlers, `${Prefix}${string}`>>;

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

/** ctl-verbs.ts's lookup of the tab a verb acts on, checked to exist and to be the caller's to reach. */
export type OwnedTab = (args: Record<string, unknown>, caller: Caller) => TabRef & { tabs: ControlTerminals; own: boolean };

/** Brings the tab a verb opened or started to the front, unless `--background` leaves it behind. */
export function bringToFront(deps: Pick<ControlDeps, "showTab">, args: Record<string, unknown>, ref: ProjectRef, tabId: string): void {
  if (args.background !== true) {
    deps.showTab(ref, tabId);
  }
}

/** A positive whole number as `value` spells it; undefined for anything else. */
export function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** A positive integer flag, or `fallback` when absent. */
export function count(args: Record<string, unknown>, name: string, fallback: number): number {
  if (args[name] === undefined) {
    return fallback;
  }
  const value = positiveInteger(args[name]);
  if (value === undefined) {
    throw new ControlError("bad_args", `--${name} takes a positive whole number`);
  }
  return value;
}

/** A variadic positional's arguments; none is an empty list. */
export function list(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The `number` positional, the number of the `noun` it names. */
export function numberArg(args: Record<string, unknown>, noun: string): number {
  const typed = text(args, "number", `${noun} number`);
  const number = positiveInteger(typed);
  if (number === undefined) {
    throw new ControlError("bad_args", `not ${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun} number: ${typed}`);
  }
  return number;
}

/** `--label`'s comma-separated names; none narrows nothing. */
export function labelsArg(args: Record<string, unknown>): string[] {
  return (optionalText(args, "label") ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");
}

/** An issue or change request as the CLI answers it: the pictures of the people it names belong to the
 *  section. */
export function withoutAvatars<T extends object>(item: T): Omit<T, "avatars"> {
  // Its own entries but one: what Omit says of it.
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "avatars")) as Omit<T, "avatars">;
}

/** What an issue's tab and a change request's do alike on its host (tracked.ts's `trackedOps`); each
 *  throws what the host or the account refused (`refusable`). */
export interface TrackedOps {
  /** How a sentence names one: `issue #3`, `change request 4`. */
  nameOf(number: number): string;
  /** It, with its text: its tab's, and the file a tab opened on it starts with. */
  read(projectId: string, number: number): Promise<{ detail: TrackedDetail; markdown: string }>;
  /** The text and first prompt of a tab of the repository or worktree `ref` opened on it. */
  agentFile(ref: ProjectRef, number: number): Promise<{ content: string; prompt: string }>;
  /** An image of its text as a data url; null when it takes no token or cannot be read. */
  image(projectId: string, source: string): Promise<string | null>;
  fieldOptions(projectId: string, number: number, fieldId: string): Promise<string[]>;
  setField(projectId: string, number: number, fieldId: string, value: TrackedFieldValue): Promise<void>;
  /** Its title, text or state; a change request is merged by `mergeChangeRequest` alone. */
  update(projectId: string, number: number, change: TrackedChange): Promise<void>;
  /** `internal` where its host has such comments (`TrackedDetail.internalNotes`). */
  comment(projectId: string, number: number, body: string, internal: boolean): Promise<void>;
  editComment(projectId: string, id: string, body: string): Promise<void>;
  deleteComment(projectId: string, id: string): Promise<void>;
  /** Counts it as its tab shows it, as the host has it now; without a number, every one until now. */
  markSeen(projectId: string, number?: number): Promise<void>;
}

/** What the Issues section and `tet-ctl`'s issue verbs do on the project's tracker beyond an issue's
 *  tab (issues.ts's `issueOps`), by project; each throws what the tracker or the account refused
 *  (`refusable`). */
export interface IssueOps {
  /** Where the project's issues are read from (`readIssueTracker`). */
  tracker(projectId: string): Promise<IssueTrackerInfo>;
  /** The `issues` of the project's tet.json, where it names one. */
  source(projectId: string): Promise<string | undefined>;
  /** Saves the project's issue source once the tracker reads it, answering what was saved; "" goes
   *  back to the remote's own. */
  setSource(projectId: string, source: string): Promise<string | undefined>;
  /** At least the first `limit` issues the filter leaves, from `after` where given; read from the
   *  start, with what the tracker said of the list just before and where the issues are read from. */
  page(
    projectId: string,
    filter: IssueFilter,
    limit: number,
    after?: string,
  ): Promise<ListPage<Issue> & Pick<IssueListResult, "latest" | "tracker">>;
  /** Every issue the filter leaves. */
  list(projectId: string, filter: IssueFilter): Promise<Issue[]>;
  /** What the tracker says of the filtered list without sending it. */
  latest(projectId: string, filter: IssueFilter): Promise<TrackedLatest>;
  filterOptions(projectId: string): Promise<{ labels: string[]; people: string[] }>;
  /** Those changed since their tab last showed them (`isUnread`), among the section's first list. */
  unread(projectId: string): Promise<Issue[]>;
  /** A new issue, answered by its number. */
  create(projectId: string, title: string, body: string, confidential: boolean): Promise<number>;
  delete(projectId: string, number: number): Promise<void>;
  /** Answers the Markdown that shows the file in an issue's text. */
  upload(projectId: string, name: string, bytes: Buffer<ArrayBuffer>): Promise<string>;
  /** The file name of the upload a link of an issue's text leads to; undefined for any other link. */
  uploadName(projectId: string, source: string): Promise<string | undefined>;
  /** Saves that upload as `target`; `onProgress` gets the share read after each chunk. */
  saveUpload(projectId: string, source: string, target: string, onProgress: (fraction: number) => void): Promise<void>;
}

/** What the change requests section and `tet-ctl`'s change request verbs do on the repository's own
 *  remote beyond a change request's tab (change-requests/tracker.ts's `changeRequestOps`), by project;
 *  each throws what the host or the account refused (`refusable`). */
export interface ChangeRequestOps {
  /** What the host calls one; undefined without an account for it. */
  kind(projectId: string): Promise<ChangeRequestKind | undefined>;
  /** As `IssueOps.page`. */
  page(
    projectId: string,
    filter: ChangeRequestFilter,
    limit: number,
    after?: string,
  ): Promise<ListPage<ChangeRequestRow> & { latest?: ChangeRequestsLatest }>;
  list(projectId: string, filter: ChangeRequestFilter): Promise<ChangeRequestRow[]>;
  latest(projectId: string, filter: ChangeRequestFilter): Promise<ChangeRequestsLatest>;
  filterOptions(projectId: string): Promise<{ labels: string[]; people: string[] }>;
  /** Those changed, or whose checks failed, since their tab last showed them (`isChangeRequestUnread`). */
  unread(projectId: string): Promise<ChangeRequestRow[]>;
  approve(projectId: string, number: number): Promise<void>;
  /** By the repository's own method; `whenChecksPass` has the host merge it once they did. */
  merge(projectId: string, number: number, whenChecksPass: boolean): Promise<void>;
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
          started(): Promise<void>;
          getState(): RepositoryState;
          listExplorer(settings: ExplorerSettings): Promise<ExplorerListing>;
          merge(target: CheckoutTarget, fastForwardOnto?: string): Promise<GitCommandResult>;
          conflictMarkers(base: CheckoutTarget): Promise<string[]>;
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
   *  the front unless `background`. */
  openEditor(ref: ProjectRef, path: string, keep: boolean, background: boolean): void;
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
  removeProject(projectId: string): Promise<GitCommandResult>;
  addWorktree(projectId: string, branch: string): Promise<AddRepositoryResult>;
  deleteWorktree(worktree: ProjectRef, force: boolean): Promise<GitActionResult>;
  readCommands(root: string): Promise<ProjectCommand[]>;
  /** issues.ts's, the same the window's IPC takes. */
  issues: IssueOps;
  /** change-requests/tracker.ts's, the same the window's IPC takes. */
  changeRequests: ChangeRequestOps;
  /** tracked.ts's: what an issue and a change request do alike, by kind. */
  tracked: Record<TrackedKind, TrackedOps>;
  /** Opens the project's issue or change request in the repository's or worktree's preview tab, or a
   *  kept tab, and brings it to the front unless `background`. */
  openTracked(ref: ProjectRef, tracked: TrackedRef, keep: boolean, background: boolean): void;
  /** `sandboxOnly` as for `ControlTerminals.createTab`. */
  sendTrackedToAgent(ref: ProjectRef, tracked: TrackedRef, agentId: AgentId, sandboxOnly: boolean): Promise<HandoverResult>;
  /** tracked.ts's: the session linked to the project's issue or change request, as its tab shows it. */
  trackedSession(projectId: string, tracked: TrackedRef): TrackedSession | undefined;
  /** main.ts's teardown: ends every session and quits, optionally relaunching. */
  shutdown(relaunch: boolean): void;
  /** Its process starts with the first resize that draws it. */
  showTab(ref: ProjectRef, tabId: string): void;
  /** A desktop notification from this process, which holds the desktop session (a sandboxed hook has
   *  none). Must never throw: `hook` notifications on the way to answering a turn. A click brings
   *  `target` to the front; the notification center lists it with `mark`'s icon. */
  showDesktopNotification(title: string, message: string, target?: TabRef, mark?: NoticeMark, agentId?: AgentId): void;
  /** A notice in the window (Notices.tsx), as every other one main tells the user. */
  notice(severity: NoticeSeverity, message: string, title?: string): void;
  /** main.ts's, shared with ipc/environment.ts. */
  environment: Pick<EnvStore, "list" | "remove">;
  envRequests: Pick<EnvRequests, "ask">;
  /** sbx-access.ts's, built in main.ts. */
  sbx: SbxAccess;
}

/** The slice of TabSessionManager the verbs use. */
export interface ControlTerminals {
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
  handOver(tabId: string, agentId: AgentId, sandboxOnly: boolean): Promise<HandoverResult>;
  createCommandTab(command: ProjectCommand): TabDescriptor;
  closeTabs(tabIds: string[]): Promise<void>;
  /** Host paths where the tab sees them, mounted into its sandbox where it would not; unquoted. */
  seenPaths(tabId: string, hostPaths: string[]): Promise<string[]>;
  /** The agent's refusal, or nothing when it went through. */
  renameTab(tabId: string, title: string): Promise<ActionResult>;
  /** Links the tab's session to the project's issue or change request, or the one it gets; answers
   *  what refused it. */
  link(tabId: string, tracked: TrackedRef): TrackedLinkResult;
  /** Takes the tab's session off the project's issue or change request; answers what refused it. */
  unlink(tabId: string, tracked: TrackedRef): ActionResult;
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
  const project = projectById(store, projectId);
  const asked = optionalText(args, "worktree");
  if (asked === undefined) {
    return { project, ref: projectRef(projectId, askedProject === undefined ? caller.worktree : undefined) };
  }
  return { project, ref: tetWorktree(project, asked).ref };
}

/** The project of `id`, one TET has. */
export function projectById(store: ProjectLookup, id: string): Project {
  const project = store.get(id);
  if (!project) {
    throw new ControlError("not_found", PROJECT_NOT_FOUND);
  }
  return project;
}

/** The agent of `id`, one TET has. */
export function agentById(deps: Pick<ControlDeps, "agents">, id: string): AgentDefinition {
  const agent = deps.agents.find((candidate) => candidate.id === id);
  if (!agent) {
    throw new ControlError("bad_args", `unknown agent: ${id} (see agents-list)`);
  }
  return agent;
}

/** `--agent`, one TET has. */
export function agentFlag(deps: Pick<ControlDeps, "agents">, args: Record<string, unknown>): AgentDefinition {
  return agentById(deps, text(args, "agent", "agent: pass --agent <id> (see agents-list)"));
}

/** What the tracker or the account refused, answered as a call the caller can mend. */
export async function refusable<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new ControlError("bad_args", errorMessage(error));
  }
}

/** `--agent`, one the caller may open a tab of: a shell would run on this machine, so a sandbox
 *  opens only an sbx agent's tab, held to the sandbox (`CallerSide.holdsTabs`). */
export function openableAgent(deps: Pick<ControlDeps, "agents">, args: Record<string, unknown>, caller: Caller): AgentDefinition {
  const agent = agentFlag(deps, args);
  if (!caller.side.opens(agent)) {
    throw new ControlError("unauthorized", `a ${agent.id} tab does not run in a sandbox, so a sandbox cannot open one`);
  }
  return agent;
}

/** The repository's or worktree's terminals; one closed meanwhile is an internal error. */
export function terminalsOf(deps: Pick<ControlDeps, "tabManagers" | "store">, ref: ProjectRef): ControlTerminals {
  const terminals = deps.tabManagers.get(ref);
  if (!terminals) {
    throw new ControlError("internal", notOpenMessage(deps.store, ref));
  }
  return terminals;
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
