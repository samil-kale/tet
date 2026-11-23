import type { ActionDone, ActionRefused } from "./action";

export type ProviderId = "github" | "gitlab";

/** A repository host account. Its token is kept encrypted, main-side. */
export interface ProviderAccount {
  id: string;
  provider: ProviderId;
  /** "github.com", or a self-hosted instance. */
  host: string;
  /** The token's login, read from the API when added. */
  user: string;
  /** The group the list was last narrowed to; "" is all, undefined never picked. */
  namespace?: string;
}

/** A repository the remote tab lists. */
export interface RemoteRepository {
  /** "owner/name". */
  fullName: string;
  /** The clone tab's default folder name. */
  name: string;
  /** The https url; the account's token can authenticate it. */
  cloneUrl: string;
}

/** The account once its token checked out, or the API's message. */
export type AddAccountResult = (ActionDone & { account: ProviderAccount }) | ActionRefused;

export interface ListRepositoriesResult {
  repos?: RemoteRepository[];
  error?: string;
}

/** A row of the Issues or change requests section: what an issue and a change request have alike. */
export interface TrackedRow {
  /** GitHub's `number`, GitLab's `iid`: what the host's pages call it. */
  number: number;
  title: string;
  url: string;
  open: boolean;
  author: string;
  /** The first of them; a row has room for one. */
  assignee?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Of its last change on the tracker: a tab that read it earlier is out of date. */
  updatedAt: string;
  labels: string[];
  /** The picture of whom it names, by login, where the host has one. */
  avatars: Record<string, string>;
}

/** A row of the Issues section: a tracked row as it is, as `ChangeRequestRow` is the other kind's. */
export type Issue = TrackedRow;

/** The states an issue has; `tet-ctl` also filters by `all`. */
export const ISSUE_STATES = ["open", "closed"] as const;
export const ISSUE_STATE_FILTERS = [...ISSUE_STATES, "all"] as const;

/** What the host narrows the Issues section to; a field left out narrows nothing. */
export interface IssueFilter {
  state?: "open" | "closed";
  author?: string;
  assignee?: string;
  /** An issue has to carry all of them. */
  labels: string[];
  /** Words its title has to hold, as the tracker's search matches them; absent for none. */
  text?: string;
}

/** What the Issues section shows until its filter is changed. */
export const DEFAULT_ISSUE_FILTER: IssueFilter = { state: "open", labels: [] };

/** What TET reads off a host and shows in a tab of its own, beside the repository's files: an issue, or a
 *  pull or merge request. A number names one only together with its kind: GitLab counts each apart. */
export const TRACKED_KINDS = ["issue", "change-request"] as const;
export type TrackedKind = (typeof TRACKED_KINDS)[number];

/** One of the project's issues or change requests. */
export interface TrackedRef {
  kind: TrackedKind;
  number: number;
}

export function sameTracked(a: TrackedRef | undefined, b: TrackedRef | undefined): boolean {
  return a?.kind === b?.kind && a?.number === b?.number;
}

/** What its text is called as a file: in its tab, and in a tab opened on it. */
export function trackedFileName({ kind, number }: TrackedRef): string {
  return `${kind}-${number}.md`;
}

/** The states a change request has; `tet-ctl` also filters by `all`. */
export const CHANGE_REQUEST_STATES = ["open", "merged", "closed"] as const;
export const CHANGE_REQUEST_STATE_FILTERS = [...CHANGE_REQUEST_STATES, "all"] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

/** What the host narrows the change requests section to; a field left out narrows nothing. */
export interface ChangeRequestFilter {
  state?: ChangeRequestState;
  author?: string;
  assignee?: string;
  /** Whose review it asks for. */
  reviewer?: string;
  /** A change request has to carry all of them. */
  labels: string[];
  /** As `IssueFilter.text`. */
  text?: string;
}

/** What the change requests section shows until its filter is changed. */
export const DEFAULT_CHANGE_REQUEST_FILTER: ChangeRequestFilter = { state: "open", labels: [] };

/** How the checks of a change request's head commit stand: GitHub's checks, GitLab's pipeline. */
export type ChecksState = "passed" | "running" | "failed";

/** A row of the change requests section: a tracked row, and where the request stands. */
export interface ChangeRequestRow extends TrackedRow {
  state: ChangeRequestState;
  draft: boolean;
  /** Absent where its head commit has no checks. */
  checks?: ChecksState;
  /** Its head commit's id: a pipeline that fails is told of once for each. */
  headSha?: string;
}

/** One check or job of a change request's head commit; `skipped` is one that did not run or does not count. */
export interface ChangeRequestCheck {
  name: string;
  state: ChecksState | "skipped";
  /** What the host says of it besides its state: a commit status's description, a job's stage. */
  detail?: string;
  /** The host's page of it. */
  url?: string;
  /** Merging waits for it; absent where the host does not say. */
  required?: boolean;
}

/** Where one reviewer stands: an approval that stands, a request for changes, or a review still asked for. */
export interface ChangeRequestReviewer {
  login: string;
  state: "approved" | "changes-requested" | "requested";
}

/** What a change request's tab says of it above its text, beside what its row says. */
export interface ChangeRequestStatus {
  /** Every check or job of its head commit, empty where it has none. */
  checks: ChangeRequestCheck[];
  /** The host's page of its checks or pipeline. */
  checksUrl?: string;
  /** What else keeps it from merging, in words, beside its checks, approvals and conflicts: the
   *  branch behind its base, changes requested, a rule of the host's. */
  blockers: string[];
  /** Approvals it still needs; absent where none is outstanding, `left` absent where the host does not
   *  say how many. */
  approvalsOutstanding?: { left?: number };
  /** It cannot merge into its base before they are resolved. */
  conflicts: boolean;
  /** The host merges it once nothing is outstanding. */
  autoMerge: boolean;
  /** The host would set it to auto-merge now: something is outstanding, and the account may. */
  autoMergeable: boolean;
  /** Who approved, asked for changes or is asked for a review, by login; one of them once. */
  reviewers: ChangeRequestReviewer[];
  /** Its source branch and the branch it merges into. */
  head: string;
  base: string;
  commits: number;
  additions?: number;
  deletions?: number;
  mergedBy?: string;
  /** ISO 8601. */
  mergedAt?: string;
}

/** A thread of comments on a file of a change request's changes: GitHub's review thread, GitLab's
 *  discussion on its diff. Its comments are none the tab edits or deletes. */
export interface ReviewThread {
  /** What the host addresses it by. */
  id: string;
  /** The file, as the changes name it. */
  path: string;
  /** In the file's new text, else in its old; absent for one on the whole file. */
  line?: number;
  resolved: boolean;
  /** The lines it was written on have changed since; only GitHub tells. */
  outdated?: boolean;
  /** Oldest first, never empty. */
  comments: TrackedNote[];
}

/** One change request with what its row leaves out, for its tab: a tracked detail, its status, its
 *  review threads, and what its host calls it. */
export interface ChangeRequestDetail extends TrackedDetail, ChangeRequestRow {
  status: ChangeRequestStatus;
  reviewThreads: ReviewThread[];
  kind: ChangeRequestKind;
  /** Whether the project's issues are read from this same repository, so a linked issue opens in its
   *  tab rather than the browser. */
  ownIssues: boolean;
}

/** Whether a tab's detail is a change request's rather than an issue's. */
export function isChangeRequest(detail: TrackedDetail): detail is ChangeRequestDetail {
  return "status" in detail;
}

/** How its host names one: `#142`, `!42`. */
export function changeRequestName(kind: ChangeRequestKind, number: number): string {
  return `${kind.prefix}${number}`;
}

/** The text with its first letter in upper case: "pull request" as "Pull request". */
export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The text with each word's first letter in upper case: "pull request" as "Pull Request". */
export function titleCased(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** A linked issue as its field names it: its number, then its title. */
export function linkedIssueName(number: number, title: string): string {
  return `#${number} ${title}`;
}

/** The number of a linked issue, as `linkedIssueName` named it; undefined for any other text. */
export function linkedIssueNumber(name: string): number | undefined {
  const match = /^#(\d+) /.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** What the tracker says of a list of issues without sending it: how many it holds and when the most
 *  recently changed one changed. Two reads that agree found nothing new in it. */
export interface TrackedLatest {
  total: number;
  /** ISO 8601; absent for an empty list. */
  updatedAt?: string;
}

/** What the project's tabs of one kind showed, against what the host says now. One is unread once its
 *  `updatedAt` is past its entry in `shown` or, with none, past `since`: one created or changed since
 *  then counts without ever having been shown, an older one does not. */
export interface TrackedSeen {
  /** ISO 8601. From when one without an entry counts as unread. */
  since: string;
  /** Each one's `updatedAt` as its tab last showed it, by number. */
  shown: Record<number, string>;
  /** Those whose tab last showed their checks failed; an issue has none. */
  failed: number[];
}

/** `seen` once a tab showed one at `updatedAt`, its checks `failed` or not. */
export function withSeen(seen: TrackedSeen, number: number, updatedAt: string, failed: boolean): TrackedSeen {
  const others = seen.failed.filter((entry) => entry !== number);
  return { ...seen, shown: { ...seen.shown, [number]: updatedAt }, failed: failed ? [...others, number] : others };
}

/** Whether `seen` holds that already, so nothing needs keeping. */
export function holdsSeen(seen: TrackedSeen, number: number, updatedAt: string, failed: boolean): boolean {
  return seen.shown[number] === updatedAt && seen.failed.includes(number) === failed;
}

/** Whether the host created or changed the open issue or change request after its tab last showed it
 *  or, if none did, after `seen.since`; a closed one needs no attention, closing it being a change too.
 *  Dates are compared as times: the hosts spell them differently. */
export function isUnread(row: TrackedRow, seen: TrackedSeen | undefined): boolean {
  return seen !== undefined && row.open && Date.parse(row.updatedAt) > Date.parse(seen.shown[row.number] ?? seen.since);
}

/** `isUnread`, or its checks failed since its tab last showed it with them not failed: a check that ends
 *  changes no `updatedAt`. One its tab never showed is unread by `isUnread` alone. */
export function isChangeRequestUnread(row: ChangeRequestRow, seen: TrackedSeen | undefined): boolean {
  return (
    isUnread(row, seen) ||
    (seen !== undefined && row.open && row.checks === "failed" && seen.shown[row.number] !== undefined && !seen.failed.includes(row.number))
  );
}

export type TrackedSeenResult = (ActionDone & { seen: TrackedSeen }) | ActionRefused;

/** A list of a section as it came: read from its start, or a page more (`after`). */
export interface TrackedListResult<T extends TrackedRow, L extends TrackedLatest> {
  items?: T[];
  /** Read from the start alone. */
  seen?: TrackedSeen;
  /** Read from the start alone, just before `items`, so that a change made while the list came is
   *  found by the next read. */
  latest?: L;
  /** Where the next page starts; absent once the host has no more. */
  after?: string;
  error?: string;
  /** `error` is that no account is added for the host. */
  noAccount?: boolean;
}

export interface IssueListResult extends TrackedListResult<Issue, TrackedLatest> {
  /** The `issues` of the project's tet.json, where it has one. */
  source?: string;
  /** Where the issues are read from, for what a text that is not yet an issue's links to. */
  tracker?: {
    provider: ProviderId;
    /** The repository's address on its host. */
    url: string;
    /** Whether a new issue can be made confidential (`GitProviderIssues.confidential`). */
    confidentialIssues: boolean;
  };
}

export interface IssueLatestResult {
  latest?: TrackedLatest;
  error?: string;
}

/** What the Issues section's filters offer. */
export interface TrackedFilterOptions {
  labels?: string[];
  /** Offered for both author and assignee. */
  people?: string[];
  error?: string;
}

/** A comment of an issue, oldest first in `TrackedDetail.notes`. */
export interface TrackedNote {
  /** What the tracker addresses it by, its GraphQL id. */
  id: string;
  author: string;
  /** ISO 8601. */
  createdAt: string;
  body: string;
  /** Visible to the project's members alone; absent where the tracker has no such comments. */
  internal?: boolean;
  /** The text of a review, which is no comment the tab edits or deletes. */
  fixed?: true;
}

/** What happened to an issue, shown between its comments. */
export type TrackedEvent = { actor: string; /** ISO 8601. */ createdAt: string } & (
  | { kind: "closed" | "reopened" }
  | { kind: "assigned" | "unassigned"; login: string }
  | { kind: "labeled" | "unlabeled"; label: string }
  | { kind: "milestoned" | "demilestoned"; milestone: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "linked"; number: number; title: string; url: string }
  /** A change request's alone. */
  | { kind: "review-requested"; login: string }
  | { kind: "reviewed"; review: "approved" | "changes-requested" | "commented" }
  | { kind: "pushed"; commits: number }
  | { kind: "merged" }
  /** As the tracker worded it, where it says no more than that. */
  | { kind: "text"; text: string }
);

/**
 * One field of an issue, as the tab's side column lists them: what the tracker keeps of an issue
 * beside its text and comments, in the tracker's own words and order. A field the tracker does not
 * have for this issue (its type or plan lacks it) is not listed.
 */
export type TrackedField = {
  /** What the provider addresses it by in `listOptions` and `setField`. */
  id: string;
  name: string;
  /** Whether the tracker takes a change of it; its rights can still refuse one. */
  editable: boolean;
  /** Fields of one group are one section, titled by it, at the place of the first; only typed ones
   *  (text, number, date, duration, timelog) go in one, as the section's one button asks for them. */
  group?: string;
} & (
  | {
      kind: "pick";
      /** What it names, each as `listOptions` lists it. */
      value: string[];
      several: boolean;
      /** How its values are drawn: as labels, as labels of people, whose field offers the viewer to add
       *  themselves, as issues named by `linkedIssueName`, each opening its tab, or as plain text. */
      shown: "text" | "people" | "labels" | "issues";
    }
  | { kind: "text"; value?: string }
  | { kind: "number"; value?: number }
  | { kind: "date"; /** YYYY-MM-DD. */ value?: string }
  | { kind: "duration"; /** As the tracker words it, "1h 30m". */ value?: string }
  /** Time booked to the issue: `value` is the total, `entries` the bookings, newest first; `setField`
   *  takes a new entry, or the removal of one. */
  | { kind: "timelog"; value?: string; entries: IssueTimeLog[] }
  | { kind: "flag"; value: boolean }
);

/** A booking of time already made to an issue. */
export interface IssueTimeLog {
  /** What an `IssueTimeRemoval` names it by. */
  id: string;
  author: string;
  /** As the tracker words a duration, "1h 30m". */
  timeSpent: string;
  /** YYYY-MM-DD. */
  spentAt?: string;
  summary?: string;
  /** Whether the viewer's rights take it back. */
  removable: boolean;
}

/** The taking back of a booking, by its `IssueTimeLog.id`. */
export interface IssueTimeRemoval {
  remove: string;
}

/** One booking of time to an issue: how long, when and what was done. */
export interface IssueTimeEntry {
  /** As the tracker takes a duration, "1h 30m". */
  timeSpent: string;
  /** YYYY-MM-DD; left out, it is now. */
  spentAt?: string;
  summary?: string;
}

/** What `setField` sets, by the field's kind: a pick's values; a text, number, date or duration, null
 *  taking it off; a flag's state; a timelog's new entry or the removal of one. */
export type TrackedFieldValue = string[] | number | string | boolean | IssueTimeEntry | IssueTimeRemoval | null;

export function isTimeRemoval(value: TrackedFieldValue): value is IssueTimeRemoval {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "remove" in value;
}

export interface TrackedFieldOptionsResult {
  /** What a pick field can be set to, by the names `TrackedField.value` uses. */
  options?: string[];
  error?: string;
}

/** One issue or change request with what its row leaves out, for its tab. */
export interface TrackedDetail extends TrackedRow {
  /** Whose Markdown its texts are written in (`issueTextHtml`). */
  provider: ProviderId;
  fields: TrackedField[];
  body: string;
  notes: TrackedNote[];
  events: TrackedEvent[];
  /** The login of the account it was read through. */
  viewer?: string;
  /** What its tracker takes for its text; absent where it takes no file. */
  uploads?: IssueUploads;
  /** Whether a comment can be made internal (`GitProviderIssues.internalNotes`). */
  internalNotes?: boolean;
}

/** One issue with what its row leaves out, for its tab: a tracked detail as it is, as
 *  `ChangeRequestDetail` is the other kind's. */
export type IssueDetail = TrackedDetail;

/** What a tracker takes of a file for an issue's text. */
export interface IssueUploads {
  /** File name extensions, without the dot; absent takes any file. */
  extensions?: string[];
}

/** What the issue's tab sets of the issue itself; a part left out stays as it is. Its fields are set
 *  one at a time (`TrackedField`). */
export interface TrackedChange {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

export type IssueCreateResult = (ActionDone & { number: number }) | ActionRefused;

/** What a host calls a request to merge a branch, and how it writes one's number: GitHub's pull
 *  request `#128`, GitLab's merge request `!42`. The code says "change request" for either. */
export interface ChangeRequestKind {
  noun: string;
  prefix: string;
  /** What it calls what runs on its commits: GitHub's "checks", GitLab's "pipeline". */
  checks: string;
  /** Whether its author may approve one: GitHub refuses that, GitLab lets the project decide. */
  selfApproval: boolean;
  /** Whether it can be set to delete its source branch once merged: GitHub has that only as a
   *  repository setting, GitLab per merge request. */
  deletesSourceBranch: boolean;
}

/** Where the checked-out branch's pull or merge request can go: the host's kind, the branches of
 *  its remote it can merge into, and the one offered first (`change-requests.ts`: the base TET
 *  recorded, else the default branch). */
export interface ChangeRequestTarget {
  kind: ChangeRequestKind;
  into: string;
  branches: string[];
}

/** The target, or why the checked-out branch has none. */
export type ChangeRequestTargetResult = ChangeRequestTarget | { refusal: string };

/** A pull or merge request, by its number and its page. */
export interface ChangeRequest {
  number: number;
  url: string;
}

/** The checked-out branch's open pull or merge request, `open` absent where it has none. */
export type ChangeRequestFindResult = (ActionDone & { open?: ChangeRequest }) | ActionRefused;

/** What the dialog asks for: its text, and what is done with it once it is open. */
export interface ChangeRequestInput {
  /** The branch it merges into, one of `ChangeRequestTarget.branches`. */
  into: string;
  title: string;
  description: string;
  /** Approved by its author, offered where the host lets one (`ChangeRequestKind.selfApproval`). */
  approve: boolean;
  /** Merged by the host once nothing is outstanding; never at once. */
  autoMerge: boolean;
  /** Squashed when the host merges it; only with `autoMerge`, which is where the host takes the method. */
  squash: boolean;
  /** Opened as a draft, which the host does not merge: never with `autoMerge`. */
  draft: boolean;
  /** Its source branch deleted by the host once merged, offered where the host can
   *  (`ChangeRequestKind.deletesSourceBranch`). */
  deleteSourceBranch: boolean;
}

/** Opened, with why what was to follow did not: the request stands either way. */
export type ChangeRequestCreateResult = (ActionDone & ChangeRequest & ChangeRequestFollowUps) | ActionRefused;

/** Why an approval or auto-merge asked for did not happen; absent where it did or was not asked. */
export interface ChangeRequestFollowUps {
  approveError?: string;
  autoMergeError?: string;
}

export interface IssueUploadResult {
  /** What shows the file in an issue's text. */
  markdown?: string;
  error?: string;
}

/** A link of an issue's text handed to `issues.saveUpload`. */
export interface IssueUploadSaveResult {
  /** Whether it leads to an upload the account reads, asked for and saved there; false for any
   *  other link, which the browser opens. */
  upload: boolean;
  /** What stopped the download, for the caller to notify. */
  error?: string;
}

export interface TrackedReadResult {
  /** An issue's, or a change request's (`isChangeRequest`). */
  detail?: TrackedDetail;
  /** It as its tab's text, what an agent reading the tab is answered (`editorContent`). */
  markdown?: string;
  error?: string;
}

/** What the host says of a list of change requests without sending it whole: `TrackedLatest`, and how
 *  each one's checks stand, as a check that ends changes no `updatedAt`. Two reads that agree found
 *  nothing new in it. */
export interface ChangeRequestsLatest extends TrackedLatest {
  /** Each one's number and checks, in one text. */
  checks: string;
}

export interface ChangeRequestListResult extends TrackedListResult<ChangeRequestRow, ChangeRequestsLatest> {
  /** What the host calls a change request, for the section's title. */
  kind?: ChangeRequestKind;
}

export interface ChangeRequestLatestResult {
  latest?: ChangeRequestsLatest;
  error?: string;
}
