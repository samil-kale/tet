import writeFileAtomic from "write-file-atomic";
import type { ProjectRef } from "../shared/types/project";
import {
  DEFAULT_ISSUE_FILTER,
  isUnread,
  type Issue,
  type IssueChange,
  type IssueDetail,
  type IssueFieldValue,
  type IssueFilter,
  type IssueFilterOptions,
  type IssueListResult,
  type IssuesLatest,
} from "../shared/types/providers";
import type { IssueOps } from "./ctl/ctl-verb";
import { MAX_EDIT_BYTES } from "./git/explorer-read";
import {
  onTracker,
  readIssueTracker,
  setIssueSource,
  writeOnTracker,
  type IssueAccounts,
  type IssueRepository,
  type IssueTrackerInfo,
} from "./providers/issues";
import { PROVIDERS } from "./providers/index";
import type { ListPage } from "./providers/provider";
import { forgetAllSessionLinks, forgetLinkedSession } from "./store/session-links";
import { forgetAllSeen, forgetSeen, markAllSeen, readSeen, setSeen } from "./store/tracked-seen";
import type { ProjectStore } from "./store/project-store";
import { PROJECT_NOT_FOUND } from "./store/resolved-ref";
import type { SettingsAccess } from "./store/settings";
import { readIssueSource } from "./store/tet-json";
import type { SessionManagerRegistry } from "./terminals/session-registry";
import { imageDataUrl } from "./util/image-response";

/**
 * What the Issues section and `tet-ctl`'s issue verbs share, built once in main.ts like
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

/** The `issues` of the project's tet.json, where it names one. */
export function issueSource(deps: Pick<IssueDeps, "repositories">, projectId: string): Promise<string | undefined> {
  return readIssueSource(issueRepository(deps, projectId).at.path);
}

/**
 * Saves the project's issue source (`setIssueSource`). What its issue tabs showed (`TrackedSeen`) and
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
    forgetAllSeen(deps.dataRoot, projectId, "issue");
    forgetAllSessionLinks(deps.dataRoot, projectId, "issue");
  }
  return saved;
}

/** The project's issues the tracker created or changed since their tab last showed them (`isUnread`),
 *  among those the Issues section lists until its filter is changed. */
export async function unreadIssues(deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">, projectId: string): Promise<Issue[]> {
  const { items } = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.listIssues(tracker, DEFAULT_ISSUE_FILTER),
  );
  const seen = readSeen(deps.dataRoot, projectId, "issue");
  return items.filter((issue) => isUnread(issue, seen));
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
    markAllSeen(deps.dataRoot, projectId, "issue");
    return;
  }
  const { updatedAt } = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.readIssueUpdate(tracker, number),
  );
  setSeen(deps.dataRoot, projectId, "issue", number, updatedAt, false);
}

/** More than either tracker takes of one file: past this it does not cross to main's memory, either way. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

type TrackerDeps = Pick<IssueDeps, "accounts" | "repositories">;

/**
 * What the Issues section and `tet-ctl` do on the project's tracker beyond the above, each throwing
 * what the tracker or the account refused: the callers tell it as their transport does.
 */

/** At least the first `limit` issues the filter narrows to, from `after` where given; read from the
 *  start, with what the tracker said of the list just before, so a change made while the list comes
 *  differs from it at the next read, and where the issues are read from. */
export async function readIssuePage(
  deps: TrackerDeps,
  projectId: string,
  filter: IssueFilter,
  limit: number,
  after?: string,
): Promise<ListPage<Issue> & Pick<IssueListResult, "latest" | "tracker">> {
  const repository = issueRepository(deps, projectId);
  if (after !== undefined) {
    return onTracker(deps.accounts, repository, (provider, tracker) => provider.listIssues(tracker, filter, limit, after));
  }
  const { page, latest, confidentialIssues } = await onTracker(deps.accounts, repository, async (provider, tracker) => ({
    latest: await provider.readLatest(tracker, filter),
    page: await provider.listIssues(tracker, filter, limit),
    confidentialIssues: provider.confidentialIssues,
  }));
  const { provider, host, path } = await readIssueTracker(deps.accounts, repository);
  return { ...page, latest, tracker: provider === null ? undefined : { provider, url: `https://${host}/${path}`, confidentialIssues } };
}

/** The project's issues the filter narrows to. */
export async function listIssues(deps: TrackerDeps, projectId: string, filter: IssueFilter): Promise<Issue[]> {
  const { items } = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.listIssues(tracker, filter),
  );
  return items;
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

/** The file name of the upload a link of an issue's text leads to; undefined for any other link, and
 *  on a tracker without an account: the browser opens those. */
export async function issueUploadName(deps: TrackerDeps, projectId: string, source: string): Promise<string | undefined> {
  const { provider, host } = await readIssueTracker(deps.accounts, issueRepository(deps, projectId));
  return provider === null ? undefined : PROVIDERS[provider].uploadName(host, source);
}

/** Saves the upload a link of an issue's text leads to as `target`, renamed into place once whole.
 *  `onProgress` gets the share read after each chunk, and nothing when the tracker gives no length. */
export async function saveIssueUpload(
  deps: TrackerDeps,
  projectId: string,
  source: string,
  target: string,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const response = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.readUpload(tracker, source),
  );
  if (!response?.body) {
    throw new Error("The tracker sent no file");
  }
  const length = Number(response.headers.get("content-length"));
  // Held whole until renamed into place: a download cut short leaves nothing at `target`.
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > MAX_UPLOAD_BYTES) {
      throw new Error("The file is larger than either tracker takes");
    }
    chunks.push(chunk);
    if (length > 0) {
      onProgress(Math.min(received / length, 1));
    }
  }
  await writeFileAtomic(target, Buffer.concat(chunks));
}

/** What a pick field of the issue can be set to. */
export function issueFieldOptions(deps: TrackerDeps, projectId: string, number: number, fieldId: string): Promise<string[]> {
  return onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) => provider.listOptions(tracker, number, fieldId));
}

/** A new issue, answered by its number. */
export function createIssue(deps: TrackerDeps, projectId: string, title: string, body: string, confidential: boolean): Promise<number> {
  return writeOnTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.createIssue(tracker, title, body, confidential),
  );
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
  forgetSeen(deps.dataRoot, projectId, "issue", number);
  forgetLinkedSession(deps.dataRoot, projectId, "issue", number);
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
export function issuePrompt(text: string, number: number): string {
  return `${text}\n\nThe issue: #${number}. The file:`;
}

/** What the Issues section and `tet-ctl` do on the project's tracker beyond an issue's tab, for both
 *  transports alike, as `trackedOps` is for what its tab does. */
export function issueOps(deps: IssueDeps): IssueOps {
  return {
    tracker: (projectId) => issueTrackerOf(deps, projectId),
    source: (projectId) => issueSource(deps, projectId),
    setSource: (projectId, source) => changeIssueSource(deps, projectId, source),
    page: (projectId, filter, limit, after) => readIssuePage(deps, projectId, filter, limit, after),
    list: (projectId, filter) => listIssues(deps, projectId, filter),
    latest: (projectId, filter) => latestIssues(deps, projectId, filter),
    filterOptions: (projectId) => issueFilterOptions(deps, projectId),
    unread: (projectId) => unreadIssues(deps, projectId),
    create: (projectId, title, body, confidential) => createIssue(deps, projectId, title, body, confidential),
    delete: (projectId, number) => deleteIssue(deps, projectId, number),
    upload: (projectId, name, bytes) => uploadIssueFile(deps, projectId, name, bytes),
    uploadName: (projectId, source) => issueUploadName(deps, projectId, source),
    saveUpload: (projectId, source, target, onProgress) => saveIssueUpload(deps, projectId, source, target, onProgress),
  };
}
