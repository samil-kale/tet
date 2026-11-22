import { effectivePrompt } from "../../shared/prompts";
import type { WorktreeInfo } from "../../shared/types/git";
import type { ProjectRef } from "../../shared/types/project";
import {
  changeRequestName,
  DEFAULT_CHANGE_REQUEST_FILTER,
  isChangeRequestUnread,
  type ChangeRequestDetail,
  type ChangeRequestFilter,
  type ChangeRequestKind,
  type ChangeRequestRow,
  type ChangeRequestsLatest,
  type IssueChange,
  type IssueFieldValue,
  type IssueFilterOptions,
  type ReviewThread,
} from "../../shared/types/providers";
import { MAX_EDIT_BYTES } from "../git/explorer-read";
import { issueRepository, type IssueDeps } from "../issues";
import { hostProvider, onHost, trackedMarkdown, trackerRemote, WRITE_HANDS_OVER, type TrackerCall } from "../providers/issues";
import type { ListPage } from "../providers/provider";
import { readIssueSource } from "../store/tet-json";
import { markAllSeen, readSeen, setSeen } from "../store/tracked-seen";
import { imageDataUrl } from "../util/image-response";

/**
 * What the change requests section and `tet-ctl`'s change request verbs share: the project's pull or
 * merge requests, read on its repository's own remote (`trackerRemote`) through that host's accounts,
 * never from the issue source tet.json may name. Each throws what the host or the account refused.
 */
type TrackerDeps = Pick<IssueDeps, "accounts" | "repositories">;

/** Runs `call` against the repository's own remote, as `onTracker` runs it against the issue tracker. */
async function onRemote<T>(deps: TrackerDeps, projectId: string, call: TrackerCall<T>, write = false): Promise<T> {
  const remote = await trackerRemote(issueRepository(deps, projectId));
  return onHost(deps.accounts, remote, call, write ? WRITE_HANDS_OVER : undefined);
}

/** What the host of the project's repository's remote calls a change request; undefined without an
 *  account for it. */
export async function changeRequestKind(deps: TrackerDeps, projectId: string): Promise<ChangeRequestKind | undefined> {
  const remote = await trackerRemote(issueRepository(deps, projectId));
  return hostProvider(deps.accounts, remote.host)?.changeRequest;
}

/** At least the first `limit` change requests the filter narrows to, from `after` where given; read
 *  from the start, with what the host said of the list just before, so a change made while the list
 *  comes differs from it at the next read. */
export function readChangeRequestPage(
  deps: TrackerDeps,
  projectId: string,
  filter: ChangeRequestFilter,
  limit: number,
  after?: string,
): Promise<ListPage<ChangeRequestRow> & { latest?: ChangeRequestsLatest }> {
  return onRemote(deps, projectId, async (provider, tracker) => {
    const latest = after === undefined ? await provider.readChangeRequestsLatest(tracker, filter) : undefined;
    return { ...(await provider.listChangeRequests(tracker, filter, limit, after)), latest };
  });
}

/** Every one of the project's change requests the filter narrows to. */
export async function listChangeRequests(deps: TrackerDeps, projectId: string, filter: ChangeRequestFilter): Promise<ChangeRequestRow[]> {
  const { items } = await onRemote(deps, projectId, (provider, tracker) => provider.listChangeRequests(tracker, filter));
  return items;
}

export function latestChangeRequests(deps: TrackerDeps, projectId: string, filter: ChangeRequestFilter): Promise<ChangeRequestsLatest> {
  return onRemote(deps, projectId, (provider, tracker) => provider.readChangeRequestsLatest(tracker, filter));
}

/** What the filters offer. */
export function changeRequestFilterOptions(deps: TrackerDeps, projectId: string): Promise<Required<Omit<IssueFilterOptions, "error">>> {
  return onRemote(deps, projectId, async (provider, tracker) => {
    const [labels, people] = await Promise.all([provider.listLabels(tracker), provider.listPeople(tracker)]);
    return { labels, people };
  });
}

/** One change request with what its tab shows beside it. */
export async function readChangeRequest(deps: TrackerDeps, projectId: string, number: number): Promise<ChangeRequestDetail> {
  const [source, detail] = await Promise.all([
    readIssueSource(issueRepository(deps, projectId).at.path),
    onRemote(deps, projectId, async (provider, tracker, viewer) => ({ ...(await provider.readChangeRequest(tracker, number)), viewer })),
  ]);
  return { ...detail, ownIssues: source === undefined };
}

/** An image of a change request's text as a data url; null when it takes no token or cannot be read. */
export async function changeRequestImage(deps: TrackerDeps, projectId: string, source: string): Promise<string | null> {
  try {
    const response = await onRemote(deps, projectId, (provider, tracker) => provider.readImage(tracker, source));
    return response ? await imageDataUrl(response, MAX_EDIT_BYTES) : null;
  } catch {
    return null;
  }
}

export function changeRequestFieldOptions(deps: TrackerDeps, projectId: string, number: number, fieldId: string): Promise<string[]> {
  return onRemote(deps, projectId, (provider, tracker) => provider.listChangeRequestOptions(tracker, number, fieldId));
}

export async function setChangeRequestField(
  deps: TrackerDeps,
  projectId: string,
  number: number,
  fieldId: string,
  value: IssueFieldValue,
): Promise<void> {
  await onRemote(deps, projectId, (provider, tracker) => provider.setChangeRequestField(tracker, number, fieldId, value), true);
}

export async function updateChangeRequest(deps: TrackerDeps, projectId: string, number: number, change: IssueChange): Promise<void> {
  await onRemote(deps, projectId, (provider, tracker) => provider.updateChangeRequest(tracker, number, change), true);
}

export async function commentChangeRequest(deps: TrackerDeps, projectId: string, number: number, body: string): Promise<void> {
  await onRemote(deps, projectId, (provider, tracker) => provider.commentChangeRequest(tracker, number, body), true);
}

export async function editChangeRequestComment(deps: TrackerDeps, projectId: string, id: string, body: string): Promise<void> {
  await onRemote(deps, projectId, (provider, tracker) => provider.editComment(tracker, id, body), true);
}

export async function deleteChangeRequestComment(deps: TrackerDeps, projectId: string, id: string): Promise<void> {
  await onRemote(deps, projectId, (provider, tracker) => provider.deleteComment(tracker, id), true);
}

export async function approveChangeRequest(deps: TrackerDeps, projectId: string, number: number): Promise<void> {
  await onRemote(deps, projectId, (provider, tracker) => provider.approveChangeRequest(tracker, number), true);
}

/** Merges it by the repository's own method; `whenChecksPass` has the host merge it once they did. */
export async function mergeChangeRequest(deps: TrackerDeps, projectId: string, number: number, whenChecksPass: boolean): Promise<void> {
  await onRemote(deps, projectId, (provider, tracker) => provider.mergeChangeRequest(tracker, number, whenChecksPass), true);
}

/** The project's open change requests, with the login of the account that read them and what the host
 *  calls one: what `ChangeRequestWatch` compares from one round to the next. */
export function openChangeRequests(
  deps: TrackerDeps,
  projectId: string,
): Promise<{ rows: ChangeRequestRow[]; viewer: string; kind: ChangeRequestKind }> {
  return onRemote(deps, projectId, async (provider, tracker, viewer) => ({
    rows: (await provider.listChangeRequests(tracker, DEFAULT_CHANGE_REQUEST_FILTER)).items,
    viewer,
    kind: provider.changeRequest,
  }));
}

/** The project's open change requests the host created or changed, or whose checks failed, since their
 *  tab last showed them (`isChangeRequestUnread`), among those the section lists until its filter is
 *  changed. */
export async function unreadChangeRequests(
  deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">,
  projectId: string,
): Promise<ChangeRequestRow[]> {
  const changeRequests = await listChangeRequests(deps, projectId, DEFAULT_CHANGE_REQUEST_FILTER);
  const seen = readSeen(deps.dataRoot, projectId, "change-request");
  return changeRequests.filter((row) => isChangeRequestUnread(row, seen));
}

/** Counts it as its tab shows it, at the update and checks the host has now; without a number, every
 *  one created or changed until now. */
export async function markChangeRequestsSeen(
  deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">,
  projectId: string,
  number?: number,
): Promise<void> {
  if (number === undefined) {
    markAllSeen(deps.dataRoot, projectId, "change-request");
    return;
  }
  const { updatedAt, checks } = await onRemote(deps, projectId, (provider, tracker) => provider.readChangeRequestUpdate(tracker, number));
  setSeen(deps.dataRoot, projectId, "change-request", number, updatedAt, checks === "failed");
}

/** A review thread as the change request's text gives it: where it was written, then its comments. */
function threadText(thread: ReviewThread): string {
  const where = `${thread.path}${thread.line === undefined ? "" : `:${thread.line}`}${thread.outdated ? " (outdated)" : ""}`;
  return [`### ${where}`, ...thread.comments.map((comment) => `#### ${comment.author}, ${comment.createdAt}\n\n${comment.body}`)].join(
    "\n\n",
  );
}

/** The change request as text, for an agent (`trackedMarkdown`): where it stands, and the review threads
 *  not yet resolved after its comments. */
export function changeRequestMarkdown(request: ChangeRequestDetail): string {
  const { status } = request;
  const facts = [
    `State: ${request.draft && request.state === "open" ? "draft" : request.state}`,
    `Branch: ${status.head} into ${status.base}`,
    `Author: ${request.author}`,
    `Created: ${request.createdAt}`,
    ...(request.checks ? [`Checks: ${request.checks}${status.failedChecks.length > 0 ? ` (${status.failedChecks.join(", ")})` : ""}`] : []),
    ...(status.conflicts ? ["Conflicts with its base"] : []),
  ];
  const threads = request.reviewThreads.filter((thread) => !thread.resolved).map(threadText);
  return trackedMarkdown(
    request,
    changeRequestName(request.kind, request.number),
    `the ${request.kind.noun}'s host`,
    facts,
    threads.length === 0 ? [] : ["## Open review threads", ...threads],
  );
}

/** Where the change request's branch is checked out, as told to a tab in the repository or worktree
 *  `ref`: TET's knowledge, not the host's, so it is no part of the file. */
export function checkoutSentence(worktrees: WorktreeInfo[], ref: ProjectRef, head: string): string {
  const at = worktrees.find((worktree) => worktree.branch === head);
  const here = at !== undefined && (at.isRepository ? ref.worktree === undefined : at.key !== undefined && at.key === ref.worktree);
  const where = !at
    ? "nowhere in this project"
    : here
      ? "here"
      : at.isRepository
        ? "in the project's repository"
        : `in the worktree ${at.path}`;
  return `Its branch \`${head}\` is checked out ${where}.`;
}

/** The first prompt of a tab opened on a change request in the repository or worktree `ref`: the
 *  settings' text, then which one it is and where its branch is checked out, ended by its file's path. */
export function changeRequestPrompt(
  deps: Pick<IssueDeps, "repositories" | "settings">,
  ref: ProjectRef,
  request: ChangeRequestDetail,
): string {
  const text = effectivePrompt(deps.settings.get().prompts.texts, "changeRequestTab");
  const { worktrees } = issueRepository(deps, ref.projectId).getState();
  const name = changeRequestName(request.kind, request.number);
  return `${text}\n\nThe ${request.kind.noun}: ${name}. ${checkoutSentence(worktrees, ref, request.status.head)} The file:`;
}
