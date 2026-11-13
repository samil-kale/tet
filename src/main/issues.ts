import { failure } from "../shared/errors";
import { effectivePrompt } from "../shared/prompts";
import type { AgentId } from "../shared/types/agents";
import { worktreeName, worktreeOf, type ProjectRef } from "../shared/types/project";
import {
  DEFAULT_ISSUE_FILTER,
  isUnread,
  issueFileName,
  type Issue,
  type IssueChange,
  type IssueDetail,
  type IssueFieldValue,
  type IssueFilter,
  type IssueFilterOptions,
  type IssuesLatest,
} from "../shared/types/providers";
import type { HandoverResult, IssueSession } from "../shared/types/terminals";
import { MAX_EDIT_BYTES } from "./git/explorer-read";
import {
  issueMarkdown,
  onTracker,
  readIssueTracker,
  setIssueSource,
  writeOnTracker,
  type IssueAccounts,
  type IssueRepository,
  type IssueTrackerInfo,
} from "./providers/issues";
import { forgetAllIssueSessions, forgetIssueSessions, issueSessionLinks } from "./store/issue-sessions";
import { forgetAllIssuesSeen, forgetIssueSeen, markAllIssuesSeen, readIssuesSeen, setIssueSeen } from "./store/issues-seen";
import type { ProjectStore } from "./store/project-store";
import { notOpenMessage, PROJECT_NOT_FOUND } from "./store/resolved-ref";
import type { SettingsAccess } from "./store/settings";
import { readIssueSource } from "./store/tet-json";
import type { SessionManagerRegistry } from "./terminals/session-registry";
import { imageDataUrl } from "./util/image-response";

/**
 * What the ISSUES section and `tet-ctl`'s issue verbs share, built once in main.ts like
 * `ProjectDeps`. A project's tracker is read through its repository, never a worktree's: the
 * repository and its worktrees share one.
 */
export interface IssueDeps {
  accounts: IssueAccounts;
  dataRoot: string;
  repositories: { get(ref: ProjectRef): IssueRepository | undefined };
  settings: SettingsAccess;
  store: ProjectStore;
  tabManagers: SessionManagerRegistry;
}

/** The project's repository, which its tracker is read through. */
export function issueRepository({ repositories }: Pick<IssueDeps, "repositories">, projectId: string): IssueRepository {
  const repository = repositories.get({ projectId });
  if (!repository) {
    throw new Error(PROJECT_NOT_FOUND);
  }
  return repository;
}

/** Where the project's issues are read from (`readIssueTracker`). */
export async function issueTrackerOf(deps: Pick<IssueDeps, "accounts" | "repositories">, projectId: string): Promise<IssueTrackerInfo> {
  return readIssueTracker(deps.accounts, issueRepository(deps, projectId));
}

/**
 * Saves the project's issue source (`setIssueSource`). What its issue tabs showed (`IssuesSeen`) and
 * the sessions linked to its issues are forgotten once the source changed: their entries are the
 * old source's issue numbers.
 */
export async function changeIssueSource(
  deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">,
  projectId: string,
  source: string,
): Promise<string | undefined> {
  const repository = issueRepository(deps, projectId);
  const before = await readIssueSource(repository.at.path);
  const saved = await setIssueSource(deps.accounts, repository, source);
  if (saved !== before) {
    forgetAllIssuesSeen(deps.dataRoot, projectId);
    forgetAllIssueSessions(deps.dataRoot, projectId);
  }
  return saved;
}

/** The project's issues the tracker created or changed since their tab last showed them (`isUnread`),
 *  among those the ISSUES section lists until its filter is changed. */
export async function unreadIssues(deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">, projectId: string): Promise<Issue[]> {
  const issues = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.listIssues(tracker, DEFAULT_ISSUE_FILTER),
  );
  const seen = readIssuesSeen(deps.dataRoot, projectId);
  return issues.filter((issue) => isUnread(issue, seen));
}

/**
 * Counts the issue as its tab shows it, at the update the tracker has now; without a number, every
 * issue created or changed until now.
 */
export async function markIssuesSeen(
  deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">,
  projectId: string,
  number?: number,
): Promise<void> {
  if (number === undefined) {
    markAllIssuesSeen(deps.dataRoot, projectId);
    return;
  }
  const { updatedAt } = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.readIssue(tracker, number),
  );
  setIssueSeen(deps.dataRoot, projectId, number, updatedAt);
}

/** More than either tracker takes of one file: past this it does not cross to main's memory. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

type TrackerDeps = Pick<IssueDeps, "accounts" | "repositories">;

/**
 * What the ISSUES section and `tet-ctl` do on the project's tracker beyond the above, each throwing
 * what the tracker or the account refused: the callers tell it as their transport does.
 */

/** The project's issues the filter narrows to. */
export function listIssues(deps: TrackerDeps, projectId: string, filter: IssueFilter): Promise<Issue[]> {
  return onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.listIssues(tracker, filter));
}

/** What the tracker says of the filtered list without sending it. */
export function latestIssues(deps: TrackerDeps, projectId: string, filter: IssueFilter): Promise<IssuesLatest> {
  return onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.readLatest(tracker, filter));
}

/** What the filters offer. */
export function issueFilterOptions(deps: TrackerDeps, projectId: string): Promise<Required<Omit<IssueFilterOptions, "error">>> {
  return onTracker(deps.accounts, issueRepository(deps, projectId), async (provider, tracker) => {
    const [labels, people] = await Promise.all([provider.listLabels(tracker), provider.listPeople(tracker)]);
    return { labels, people };
  });
}

/** One issue with what its tab shows beside it. */
export function readIssue(deps: TrackerDeps, projectId: string, number: number): Promise<IssueDetail> {
  return onTracker(deps.accounts, issueRepository(deps, projectId), async (provider, tracker, viewer) => ({
    ...(await provider.readIssue(tracker, number)),
    viewer,
    uploads: provider.uploads(tracker.host),
    internalNotes: provider.internalNotes,
  }));
}

/** An image of an issue's text as a data url; null when it takes no token or cannot be read: the text
 *  stands without it, as a preview's does. */
export async function issueImage(deps: TrackerDeps, projectId: string, source: string): Promise<string | null> {
  try {
    const response = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
      provider.readImage(tracker, source),
    );
    return response ? await imageDataUrl(response, MAX_EDIT_BYTES) : null;
  } catch {
    return null;
  }
}

/** What a pick field of the issue can be set to. */
export function issueFieldOptions(deps: TrackerDeps, projectId: string, number: number, fieldId: string): Promise<string[]> {
  return onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.listOptions(tracker, number, fieldId));
}

/** A new issue, answered by its number. */
export function createIssue(deps: TrackerDeps, projectId: string, title: string, body: string): Promise<number> {
  return writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.createIssue(tracker, title, body));
}

export async function commentIssue(deps: TrackerDeps, projectId: string, number: number, body: string, internal: boolean): Promise<void> {
  await writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.addComment(tracker, number, body, internal),
  );
}

export async function editIssueComment(deps: TrackerDeps, projectId: string, id: string, body: string): Promise<void> {
  await writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.editComment(tracker, id, body));
}

export async function deleteIssueComment(deps: TrackerDeps, projectId: string, id: string): Promise<void> {
  await writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.deleteComment(tracker, id));
}

export async function updateIssue(deps: TrackerDeps, projectId: string, number: number, change: IssueChange): Promise<void> {
  await writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.updateIssue(tracker, number, change),
  );
}

export async function setIssueField(
  deps: TrackerDeps,
  projectId: string,
  number: number,
  fieldId: string,
  value: IssueFieldValue,
): Promise<void> {
  await writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.setField(tracker, number, fieldId, value),
  );
}

/** Deletes the issue; its entry of what the tabs showed and its sessions' links go with it. */
export async function deleteIssue(
  deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">,
  projectId: string,
  number: number,
): Promise<void> {
  await writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.deleteIssue(tracker, number));
  forgetIssueSeen(deps.dataRoot, projectId, number);
  forgetIssueSessions(deps.dataRoot, projectId, number);
}

/** Uploads a file to the tracker, answered by what shows it in an issue's text. */
export function uploadIssueFile(deps: TrackerDeps, projectId: string, name: string, bytes: Buffer<ArrayBuffer>): Promise<string> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return Promise.reject(new Error(`${name} is too large to upload`));
  }
  return writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.uploads(tracker.host)
      ? provider.uploadFile(tracker, name, bytes)
      : Promise.reject(new Error(`${tracker.host} takes no upload`)),
  );
}

/** The first prompt of a tab opened on an issue: the settings' text, then which issue it is, ended
 *  by its file's path. */
function issuePrompt(text: string, number: number): string {
  return `${text}\n\nThe issue: #${number}. The file:`;
}

/**
 * A new tab of the agent in the repository or worktree, read from the tracker, the issue its first
 * prompt; the tab shows it as a file, and its session is linked to the issue once it has one. The
 * caller checks that the agent takes a prompt. `sandboxOnly`: opened from a sandbox, so it never runs
 * on this machine (`TabSessionManager.createTab`).
 */
export async function openIssueInAgent(
  deps: Pick<IssueDeps, "accounts" | "repositories" | "settings" | "store" | "tabManagers">,
  ref: ProjectRef,
  number: number,
  agentId: AgentId,
  sandboxOnly = false,
): Promise<HandoverResult> {
  try {
    const manager = deps.tabManagers.get(ref);
    if (!manager) {
      throw new Error(notOpenMessage(deps.store, ref));
    }
    const issue = await onTracker(deps.accounts, issueRepository(deps, ref.projectId), (provider, tracker) =>
      provider.readIssue(tracker, number),
    );
    const file = {
      name: issueFileName(number),
      content: issueMarkdown(issue),
      prompt: issuePrompt(effectivePrompt(deps.settings.get().prompts.texts, "issue"), number),
    };
    const tab = manager.createTabOnFile(agentId, file, sandboxOnly);
    // A fresh tab has no session yet, so this only notes the issue on it.
    manager.linkIssue(tab.tabId, number);
    return { ok: true, tab };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The sessions linked to the project's issue that its repository or worktrees list, on the strip or
 * archived, oldest link first: what is shown of them is read off their tabs, so a rename or archive
 * shows at once. One no tab lists (a worktree closed, a session gone) is left out.
 */
export function issueSessions(
  deps: Pick<IssueDeps, "dataRoot" | "store" | "tabManagers">,
  projectId: string,
  number: number,
): IssueSession[] {
  const project = deps.store.get(projectId);
  if (!project) {
    throw new Error(PROJECT_NOT_FOUND);
  }
  return issueSessionLinks(deps.dataRoot, projectId, number).flatMap(({ ref, sessionId }) => {
    const manager = deps.tabManagers.get(ref);
    const open = manager?.snapshot().find((tab) => tab.sessionId === sessionId);
    const tab = open ?? manager?.archivedSnapshot().find((candidate) => candidate.sessionId === sessionId);
    if (!tab) {
      return [];
    }
    const worktree = worktreeOf(project, ref);
    return [
      {
        ref,
        ...(worktree && { worktree: worktreeName(worktree) }),
        tabId: tab.tabId,
        agentId: tab.agentId,
        title: tab.title,
        archived: open === undefined,
      },
    ];
  });
}
