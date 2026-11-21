import { ownValue } from "../../shared/own-value";
import {
  linkedIssueName,
  type ChangeRequest,
  type ChangeRequestFilter,
  type ChangeRequestRow,
  type ChangeRequestState,
  type ChecksState,
  type Issue,
  type IssueChange,
  type IssueEvent,
  type IssueField,
  type IssueFilter,
  type IssueNote,
  type RemoteRepository,
} from "../../shared/types/providers";
import {
  allNodes,
  ApiError,
  checksText,
  fetchImageOk,
  fetchOk,
  fetchUploadOk,
  fieldMethods,
  firstNodes,
  numberOf,
  pickField,
  pickHandler,
  sendGraphql,
  sendMutation,
  textOf,
  valueHandler,
  type FieldContext,
  type FieldHandler,
  type GitProvider,
  type GraphqlPage,
  type GraphqlSend,
  type NamedId,
  type Write,
} from "./provider";

// All of it GraphQL, but for what it does not carry: a file going up, through the upload's own
// endpoint, and an image coming down.

/** GitHub rejects requests without a User-Agent. */
function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tet",
  };
}

/** Whether an image of an issue's text may be asked for with the token: on the account's host alone,
 *  as anyone can write any address into a text. */
export function readsWithToken(host: string, source: string): boolean {
  const url = URL.parse(source);
  return url?.protocol === "https:" && url.host.toLowerCase() === host.toLowerCase();
}

/** The file name of an upload in an issue's text, on the account's host alone as `readsWithToken`:
 *  under `user-attachments/`, or an older one under its repository's `files/` or `assets/`. */
export function attachmentName(host: string, source: string): string | undefined {
  const match = readsWithToken(host, source)
    ? /^\/(?:user-attachments|[^/]+\/[^/]+)\/(?:files|assets)\/(?:[^/]+\/)*([^/]+)$/.exec(new URL(source).pathname)
    : null;
  try {
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** A user as GraphQL says it; null for a deleted account. */
interface GitHubUser {
  login: string;
  avatarUrl: string;
}

/** An issue as GraphQL says it; only one read alone has its body, milestone and participants. */
export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  author: GitHubUser | null;
  assignees: { nodes: (GitHubUser | null)[] };
  labels: { nodes: { name: string }[] };
  body?: string | null;
  milestone?: { title: string } | null;
  participants?: { nodes: (GitHubUser | null)[] };
}

/** A parent as GraphQL says it. */
export interface GitHubParent {
  number: number;
  title: string;
  repository: { nameWithOwner: string };
}

/** An issue field of a repository's organization, by the type it is: `__typename` tells which, and
 *  `options` are a select's. */
export interface GitHubFieldDefinition {
  __typename: string;
  id: string;
  name: string;
  options?: NamedId[];
}

/** What an issue holds in one issue field: a select's `value` is its option's name, a multi select's
 *  are its `options`. */
export interface GitHubFieldValue {
  field: { name: string };
  value?: string | number | null;
  options?: NamedId[];
}

/** What an issue has of the fields only some hosts have, a GitHub Enterprise Server lacking them
 *  until a version: each is read on its own (`readExtras`), and left out where the host refuses it. */
export interface GitHubExtras {
  /** What the issue's type is, which the repository offers, and whether the viewer may change it. */
  issueType?: { current: string | null; available: string[]; editable: boolean };
  /** Null for an issue with no parent. */
  parent?: GitHubParent | null;
  /** `pinned` are the names of the fields shown for the issue whatever they hold: those pinned to its
   *  type or, if it has none, to issues without one, in the order they are shown. */
  issueFields?: { definitions: GitHubFieldDefinition[]; values: GitHubFieldValue[]; pinned: string[]; editable: boolean };
}

/** A comment as GraphQL says it. */
export interface GitHubComment {
  id: string;
  body: string;
  createdAt: string;
  author: GitHubUser | null;
}

/** A timeline item as GraphQL says it; which of the rest it has goes by its `__typename`. */
export interface GitHubEvent {
  __typename: string;
  createdAt: string;
  actor: GitHubUser | null;
  assignee?: { login?: string } | null;
  label?: { name: string };
  milestoneTitle?: string;
  previousTitle?: string;
  currentTitle?: string;
  source?: { number?: number; title?: string; url?: string };
  /** A pull request's items: whose review was asked for, a review's own, a commit's. */
  requestedReviewer?: { login?: string; name?: string } | null;
  id?: string;
  state?: string;
  body?: string;
  commit?: { committedDate: string; author: { user: GitHubUser | null } | null };
}

/** How a commit's checks stand, as GraphQL rolls them up; `contexts` read for a pull request's tab alone. */
interface GitHubCheckRollup {
  state: string;
  contexts?: { nodes: { __typename: string; name?: string; conclusion?: string | null; context?: string; state?: string }[] };
}

/** A pull request as a row reads it (`PULL_REQUEST_ROW`); `headRepository` null for a deleted fork. */
export interface GitHubPullRequestRow extends GitHubIssue {
  isDraft: boolean;
  headRepository: { nameWithOwner: string } | null;
  head: { nodes: { commit: { oid: string; statusCheckRollup: GitHubCheckRollup | null } }[] };
}

/** A pull request as its tab reads it (`PULL_REQUEST_QUERY`). */
export interface GitHubPullRequestDetail extends GitHubPullRequestRow {
  body: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  mergeable: string;
  mergeStateStatus: string;
  mergedAt: string | null;
  mergedBy: { login: string } | null;
  autoMergeRequest: { enabledAt: string | null } | null;
  viewerCanEnableAutoMerge: boolean;
  commitCount: { totalCount: number };
  reviewRequests: { nodes: { requestedReviewer: GitHubUser | null }[] };
  latestReviews: { nodes: { author: GitHubUser | null }[] };
  closingIssuesReferences: { nodes: { number: number; title: string }[] } | null;
  participants: { nodes: (GitHubUser | null)[] };
  commentPage: GraphqlPage<GitHubComment>;
  timelineItems: GraphqlPage<GitHubEvent>;
}

const ISSUE_ROW = `number title url state createdAt updatedAt
  author { login avatarUrl }
  assignees(first: 100) { nodes { login avatarUrl } }
  labels(first: 100) { nodes { name } }`;

const COMMENT_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { id body createdAt author { login avatarUrl } }`;

const ACTOR = "createdAt actor { login avatarUrl }";

/** The kinds of timeline item the tab draws, as `toEvent` reads them. */
const EVENT_KINDS: Record<string, Exclude<IssueEvent["kind"], "text"> | undefined> = {
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
  AssignedEvent: "assigned",
  UnassignedEvent: "unassigned",
  LabeledEvent: "labeled",
  UnlabeledEvent: "unlabeled",
  MilestonedEvent: "milestoned",
  DemilestonedEvent: "demilestoned",
  RenamedTitleEvent: "renamed",
  CrossReferencedEvent: "linked",
};

const TIMELINE_ARGUMENTS = `itemTypes: [CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, LABELED_EVENT, UNLABELED_EVENT,
  MILESTONED_EVENT, DEMILESTONED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT]`;

/** The timeline items an issue and a pull request both have, as `toEvent` reads them. */
const EVENT_SELECTION = `__typename
    ... on ClosedEvent { ${ACTOR} }
    ... on ReopenedEvent { ${ACTOR} }
    ... on AssignedEvent { ${ACTOR} assignee { ... on Actor { login } } }
    ... on UnassignedEvent { ${ACTOR} assignee { ... on Actor { login } } }
    ... on LabeledEvent { ${ACTOR} label { name } }
    ... on UnlabeledEvent { ${ACTOR} label { name } }
    ... on MilestonedEvent { ${ACTOR} milestoneTitle }
    ... on DemilestonedEvent { ${ACTOR} milestoneTitle }
    ... on RenamedTitleEvent { ${ACTOR} previousTitle currentTitle }
    ... on CrossReferencedEvent {
      ${ACTOR}
      source { ... on Issue { number title url } ... on PullRequest { number title url } }
    }`;

const TIMELINE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { ${EVENT_SELECTION} }`;

const ISSUES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $cursor: String, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }, filterBy: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ROW} }
    }
  }
}`;

const LATEST_QUERY = `query($owner: String!, $name: String!, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }, filterBy: $filter) {
      totalCount
      nodes { updatedAt }
    }
  }
}`;

/** `ISSUES_QUERY` and `LATEST_QUERY` for a filter with text, which `issues` cannot search
 *  (`issueSearch`). */
const ISSUE_SEARCH_QUERY = `query($query: String!, $first: Int!, $cursor: String) {
  search(query: $query, type: ISSUE, first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${ISSUE_ROW} } }
  }
}`;

const ISSUE_SEARCH_LATEST_QUERY = `query($query: String!) {
  search(query: $query, type: ISSUE, first: 1) {
    issueCount
    nodes { ... on Issue { updatedAt } }
  }
}`;

const ISSUE_VARIABLES = "$owner: String!, $name: String!, $number: Int!";

const ISSUE_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ${ISSUE_ROW}
      body
      milestone { title }
      participants(first: 100) { nodes { login avatarUrl } }
      commentPage: comments(first: 100) { ${COMMENT_PAGE} }
      timelineItems(first: 100, ${TIMELINE_ARGUMENTS}) { ${TIMELINE_PAGE} }
    }
  }
}`;

/** The issue fields an organization defines, by the type each is; a select's options only where a
 *  list is made of them. */
function fieldDefinitions(withOptions: boolean): string {
  const options = withOptions ? " options { id name }" : "";
  return `__typename
  ... on IssueFieldText { id name }
  ... on IssueFieldNumber { id name }
  ... on IssueFieldDate { id name }
  ... on IssueFieldSingleSelect { id name${options} }
  ... on IssueFieldMultiSelect { id name${options} }`;
}

const FIELD_VALUES = `... on IssueFieldTextValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldNumberValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldDateValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldSingleSelectValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldMultiSelectValue { options { id name } field { ... on IssueFieldCommon { name } } }`;

const TYPE_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 50) { nodes { name isEnabled } }
    issue(number: $number) { viewerCanType issueType { name } }
  }
}`;

const PARENT_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) { issue(number: $number) { parent { number title repository { nameWithOwner } } } }
}`;

const FIELDS_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) {
    issueFields(first: 50) { nodes { ${fieldDefinitions(false)} } }
    owner { ... on Organization { pinnedIssueFields(first: 50) { nodes { ... on IssueFieldCommon { name } } } } }
    issue(number: $number) {
      viewerCanSetFields
      issueType { pinnedFields { ... on IssueFieldCommon { name } } }
      issueFieldValues(first: 50) { nodes { ${FIELD_VALUES} } }
    }
  }
}`;

const COMMENTS_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) { issue(number: $number) { comments(first: 100, after: $cursor) { ${COMMENT_PAGE} } } }
}`;

const TIMELINE_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { timelineItems(first: 100, after: $cursor, ${TIMELINE_ARGUMENTS}) { ${TIMELINE_PAGE} } }
  }
}`;

/** A pull request as a row reads it: an issue's, its draft state, where its branch is, and how its head
 *  commit's checks stand. */
const PULL_REQUEST_ROW = `${ISSUE_ROW} isDraft headRepository { nameWithOwner }
  head: commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`;

/** GraphQL's `pullRequests` narrows by no person, so a list is GitHub's search (`pullRequestSearch`). */
const PULL_REQUESTS_QUERY = `query($query: String!, $first: Int!, $cursor: String) {
  search(query: $query, type: ISSUE, first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PULL_REQUEST_ROW} } }
  }
}`;

const PULL_REQUESTS_LATEST_QUERY = `query($query: String!) {
  search(query: $query, type: ISSUE, first: 100) {
    issueCount
    nodes {
      ... on PullRequest { number updatedAt headRepository { nameWithOwner } head: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }
}`;

const PULL_REQUEST_TIMELINE_ARGUMENTS = `itemTypes: [CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, LABELED_EVENT,
  UNLABELED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT, REVIEW_REQUESTED_EVENT,
  PULL_REQUEST_REVIEW, MERGED_EVENT, PULL_REQUEST_COMMIT]`;

const PULL_REQUEST_TIMELINE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes {
    ${EVENT_SELECTION}
    ... on ReviewRequestedEvent { ${ACTOR} requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } }
    ... on PullRequestReview { id createdAt actor: author { login avatarUrl } state body }
    ... on MergedEvent { ${ACTOR} }
    ... on PullRequestCommit { commit { committedDate author { user { login avatarUrl } } } }
  }`;

const PULL_REQUEST_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${ISSUE_ROW}
      isDraft body baseRefName headRefName additions deletions mergeable mergeStateStatus mergedAt
      mergedBy { login }
      autoMergeRequest { enabledAt } viewerCanEnableAutoMerge
      commitCount: commits { totalCount }
      head: commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } }
            }
          }
        }
      }
      reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login avatarUrl } ... on Bot { login avatarUrl } } } }
      latestReviews(first: 50) { nodes { author { login avatarUrl } } }
      closingIssuesReferences(first: 25) { nodes { number title } }
      participants(first: 100) { nodes { login avatarUrl } }
      commentPage: comments(first: 100) { ${COMMENT_PAGE} }
      timelineItems(first: 100, ${PULL_REQUEST_TIMELINE_ARGUMENTS}) { ${PULL_REQUEST_TIMELINE_PAGE} }
    }
  }
}`;

const PULL_REQUEST_COMMENTS_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(first: 100, after: $cursor) { ${COMMENT_PAGE} } } }
}`;

const PULL_REQUEST_TIMELINE_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $cursor, ${PULL_REQUEST_TIMELINE_ARGUMENTS}) { ${PULL_REQUEST_TIMELINE_PAGE} }
    }
  }
}`;

/** What a timeline item shows, for those the tab draws; a comment is read on its own. */
function toEvent(item: GitHubEvent): IssueEvent | undefined {
  const base = { actor: item.actor?.login ?? "ghost", createdAt: item.createdAt };
  const kind = EVENT_KINDS[item.__typename];
  switch (kind) {
    case "closed":
    case "reopened":
      return { ...base, kind };
    case "assigned":
    case "unassigned":
      return item.assignee?.login === undefined ? undefined : { ...base, kind, login: item.assignee.login };
    case "labeled":
    case "unlabeled":
      return item.label && { ...base, kind, label: item.label.name };
    case "milestoned":
    case "demilestoned":
      return item.milestoneTitle === undefined ? undefined : { ...base, kind, milestone: item.milestoneTitle };
    case "renamed":
      return item.previousTitle === undefined ? undefined : { ...base, kind, from: item.previousTitle, to: item.currentTitle ?? "" };
    case "linked": {
      const { number, title, url } = item.source ?? {};
      return number === undefined ? undefined : { ...base, kind, number, title: title ?? "", url: url ?? "" };
    }
    case undefined:
      return undefined;
  }
}

export function toEvents(items: GitHubEvent[]): IssueEvent[] {
  return items.map(toEvent).filter((event) => event !== undefined);
}

/** What a review's verdict shows as an event; one that only comments shows as its text alone. */
const REVIEW_VERDICTS: Record<string, "approved" | "changes-requested" | undefined> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
};

/** A pull request's timeline as the tab draws it: an issue's events, and its own. A run of commits by
 *  one author is one push, at its first. */
export function toPullRequestEvents(items: GitHubEvent[]): IssueEvent[] {
  const events: IssueEvent[] = [];
  for (const item of items) {
    const base = { actor: item.actor?.login ?? "ghost", createdAt: item.createdAt };
    switch (item.__typename) {
      case "PullRequestCommit": {
        if (!item.commit) {
          break;
        }
        const actor = item.commit.author?.user?.login ?? "ghost";
        const last = events.at(-1);
        if (last?.kind === "pushed" && last.actor === actor) {
          events[events.length - 1] = { ...last, commits: last.commits + 1 };
        } else {
          events.push({ actor, createdAt: item.commit.committedDate, kind: "pushed", commits: 1 });
        }
        break;
      }
      case "ReviewRequestedEvent": {
        const login = item.requestedReviewer?.login ?? item.requestedReviewer?.name;
        if (login !== undefined) {
          events.push({ ...base, kind: "review-requested", login });
        }
        break;
      }
      case "PullRequestReview": {
        const review = REVIEW_VERDICTS[item.state ?? ""];
        if (review) {
          events.push({ ...base, kind: "reviewed", review });
        }
        break;
      }
      case "MergedEvent":
        events.push({ ...base, kind: "merged" });
        break;
      default: {
        const event = toEvent(item);
        if (event) {
          events.push(event);
        }
      }
    }
  }
  return events;
}

/** The texts of a pull request's reviews, which show beside its comments but are none of them. */
export function reviewNotes(items: GitHubEvent[]): IssueNote[] {
  return items.flatMap((item) =>
    item.__typename === "PullRequestReview" && item.id !== undefined && item.body?.trim()
      ? [{ id: item.id, author: item.actor?.login ?? "ghost", createdAt: item.createdAt, body: item.body, fixed: true as const }]
      : [],
  );
}

/** How GitHub's rollup of a commit's checks stands, in TET's words; undefined for a commit without any. */
export function checksOf(rollup: { state: string } | null | undefined): ChecksState | undefined {
  switch (rollup?.state) {
    case "SUCCESS":
      return "passed";
    case "FAILURE":
    case "ERROR":
      return "failed";
    case "PENDING":
    case "EXPECTED":
      return "running";
    default:
      return undefined;
  }
}

/** What a check run ended as that fails the rollup. */
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/** The names of the checks that failed, check runs and commit statuses alike. */
export function failedChecksOf(rollup: GitHubCheckRollup | null | undefined): string[] {
  return (rollup?.contexts?.nodes ?? []).flatMap((entry) => {
    if (entry.__typename === "CheckRun") {
      return FAILED_CONCLUSIONS.has(entry.conclusion ?? "") && entry.name !== undefined ? [entry.name] : [];
    }
    return (entry.state === "FAILURE" || entry.state === "ERROR") && entry.context !== undefined ? [entry.context] : [];
  });
}

/** A filter's text in the words of GitHub's search: each word quoted, so none is read as a qualifier. */
function titleTerms(text: string | undefined): string[] {
  const words = (text ?? "")
    .replaceAll('"', "")
    .split(/\s+/)
    .filter((word) => word !== "");
  return words.length === 0 ? [] : ["in:title", ...words.map((word) => `"${word}"`)];
}

/** A filter in the words of GitHub's search, newest first by `sort`; its labels are all required. */
export function pullRequestSearch(path: string, filter: ChangeRequestFilter, sort: "created" | "updated"): string {
  const states: Record<NonNullable<ChangeRequestFilter["state"]>, string[]> = {
    open: ["is:open"],
    merged: ["is:merged"],
    closed: ["is:closed", "is:unmerged"],
  };
  return [
    `repo:${path}`,
    "is:pr",
    ...(filter.state ? states[filter.state] : []),
    ...(filter.author ? [`author:${filter.author}`] : []),
    ...(filter.assignee ? [`assignee:${filter.assignee}`] : []),
    ...(filter.reviewer ? [`review-requested:${filter.reviewer}`] : []),
    ...filter.labels.map((label) => `label:"${label.replaceAll('"', "")}"`),
    ...titleTerms(filter.text),
    `sort:${sort}-desc`,
  ].join(" ");
}

/** An issue filter in the words of GitHub's search, as `pullRequestSearch` writes one. Taken only for a
 *  filter with text: the search's index follows a change late, `issues` at once. */
export function issueSearch(path: string, filter: IssueFilter, sort: "created" | "updated"): string {
  return [
    `repo:${path}`,
    "is:issue",
    ...(filter.state ? [`is:${filter.state}`] : []),
    ...(filter.author ? [`author:${filter.author}`] : []),
    ...(filter.assignee ? [`assignee:${filter.assignee}`] : []),
    ...filter.labels.map((label) => `label:"${label.replaceAll('"', "")}"`),
    ...titleTerms(filter.text),
    `sort:${sort}-desc`,
  ].join(" ");
}

/** Whether a pull request is from a branch of `path` itself; a search answers other kinds as empty nodes. */
function fromOwnBranch(entry: { headRepository?: { nameWithOwner: string } | null }, path: string): boolean {
  return entry.headRepository?.nameWithOwner.toLowerCase() === path.toLowerCase();
}

const PULL_REQUEST_STATES: Record<string, ChangeRequestState | undefined> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

export function toChangeRequestRow(entry: GitHubPullRequestRow): ChangeRequestRow {
  const commit = entry.head.nodes[0]?.commit;
  return {
    ...toIssue(entry),
    state: PULL_REQUEST_STATES[entry.state] ?? "open",
    draft: entry.isDraft,
    checks: checksOf(commit?.statusCheckRollup),
    headSha: commit?.oid,
  };
}

/** The fields a pull request has, as the tab lists them: who reviews it (has or is asked to), its
 *  assignees and labels, the issues it closes and who took part. */
export function toPullRequestFields(found: GitHubPullRequestDetail): IssueField[] {
  const people = (users: (GitHubUser | null)[]): string[] => users.flatMap((user) => user?.login ?? []);
  const reviewers = [
    ...people(found.latestReviews.nodes.map((review) => review.author)),
    ...people(found.reviewRequests.nodes.map((request) => request.requestedReviewer)),
  ];
  return [
    pickField("reviewers", "Reviewers", [...new Set(reviewers)], { several: true, shown: "people" }),
    pickField("assignees", "Assignees", people(found.assignees.nodes), { several: true, shown: "people" }),
    pickField(
      "labels",
      "Labels",
      found.labels.nodes.map((label) => label.name),
      { several: true, shown: "labels" },
    ),
    pickField(
      "linkedIssues",
      "Linked Issues",
      (found.closingIssuesReferences?.nodes ?? []).map((issue) => linkedIssueName(issue.number, issue.title)),
      { several: true, shown: "issues", editable: false },
    ),
    pickField("participants", "Participants", people(found.participants.nodes), { several: true, shown: "people", editable: false }),
  ];
}

/** The method a merge of the repository takes: its first allowed, in the order GitHub offers them. */
export function defaultMergeMethod(allowed: {
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
}): string {
  if (allowed.mergeCommitAllowed) {
    return "MERGE";
  }
  if (allowed.squashMergeAllowed) {
    return "SQUASH";
  }
  if (allowed.rebaseMergeAllowed) {
    return "REBASE";
  }
  throw new Error("This repository allows no way to merge a pull request");
}

/** What of a change `updateIssue` sets, in GitHub's words. */
export function toIssueInput(issueId: string, { title, body, state }: IssueChange): object {
  return { id: issueId, title, body, state: state && (state === "open" ? "OPEN" : "CLOSED") };
}

/** A parent as its field shows and lists it: its title and where it is, since a number is only unique
 *  in its repository. */
export function parentName(parent: GitHubParent): string {
  return `${parent.title} (${parent.repository.nameWithOwner}#${parent.number})`;
}

/** What a change of an issue's field needs of the issue: its id, and the id of its parent, which
 *  taking the parent off names. */
interface Target {
  id: string;
  parentId?: string;
}

function updateIssueWrite(input: object): Write {
  return { mutation: "updateIssue", inputType: "UpdateIssueInput", input };
}

/** The fields of GitHub, by the id `toFields` gives them. */
export const FIELD_HANDLERS: Record<string, FieldHandler<Target>> = {
  assignees: pickHandler({ what: "person to assign", choices: ({ send, path }) => allAssignable(send, path) }, (target, ids) =>
    updateIssueWrite({ id: target.id, assigneeIds: ids }),
  ),
  labels: pickHandler({ what: "label", choices: ({ send, path }) => allLabels(send, path) }, (target, ids) =>
    updateIssueWrite({ id: target.id, labelIds: ids }),
  ),
  type: pickHandler({ what: "issue type", choices: ({ send, path }) => allIssueTypes(send, path) }, (target, [issueTypeId]) => ({
    mutation: "updateIssueIssueType",
    inputType: "UpdateIssueIssueTypeInput",
    input: { issueId: target.id, issueTypeId: issueTypeId ?? null },
  })),
  milestone: pickHandler({ what: "milestone", choices: ({ send, path }) => allMilestones(send, path) }, (target, [milestoneId]) =>
    updateIssueWrite({ id: target.id, milestoneId: milestoneId ?? null }),
  ),
  parent: pickHandler({ what: "parent", choices: openIssues }, (target, [parentId]) => {
    if (parentId !== undefined) {
      return {
        mutation: "addSubIssue",
        inputType: "AddSubIssueInput",
        input: { issueId: parentId, subIssueId: target.id, replaceParent: true },
      };
    }
    if (target.parentId === undefined) {
      throw new Error("It has no parent");
    }
    return { mutation: "removeSubIssue", inputType: "RemoveSubIssueInput", input: { issueId: target.parentId, subIssueId: target.id } };
  }),
};

/** What `setIssueFieldValue` takes to set an issue field of the organization; a value taken off is
 *  deleted. */
function issueFieldWrite(definition: GitHubFieldDefinition, target: Target, entry: object | null): Write {
  return {
    mutation: "setIssueFieldValue",
    inputType: "SetIssueFieldValueInput",
    input: { issueId: target.id, issueFields: [{ fieldId: definition.id, ...(entry ?? { delete: true }) }] },
  };
}

/** The handler of one of the organization's issue fields, by the type it is. */
export function issueFieldOf(definition: GitHubFieldDefinition): FieldHandler<Target> {
  const options = { what: definition.name, choices: () => Promise.resolve(definition.options ?? []) };
  switch (definition.__typename) {
    case "IssueFieldText":
      return valueHandler((target, value) => issueFieldWrite(definition, target, textOf(value) === null ? null : { textValue: value }));
    case "IssueFieldNumber":
      return valueHandler((target, value) => issueFieldWrite(definition, target, numberOf(value) === null ? null : { numberValue: value }));
    case "IssueFieldDate":
      return valueHandler((target, value) => issueFieldWrite(definition, target, textOf(value) === null ? null : { dateValue: value }));
    case "IssueFieldSingleSelect":
      return pickHandler(options, (target, [optionId]) =>
        issueFieldWrite(definition, target, optionId ? { singleSelectOptionId: optionId } : null),
      );
    case "IssueFieldMultiSelect":
      return pickHandler(options, (target, ids) =>
        issueFieldWrite(definition, target, ids.length > 0 ? { multiSelectOptionIds: ids } : null),
      );
    default:
      throw new Error(`${definition.name} is a kind of issue field this app does not know`);
  }
}

/** What an issue field of the organization holds of an issue, as the tab lists it. */
function toIssueField(
  definition: GitHubFieldDefinition,
  { values, editable }: { values: GitHubFieldValue[]; editable: boolean },
): IssueField[] {
  const held = values.find((candidate) => candidate.field.name === definition.name);
  const base = { id: definition.id, name: definition.name, editable };
  switch (definition.__typename) {
    case "IssueFieldText":
      return [{ ...base, kind: "text", value: typeof held?.value === "string" ? held.value : undefined }];
    case "IssueFieldNumber":
      return [{ ...base, kind: "number", value: typeof held?.value === "number" ? held.value : undefined }];
    case "IssueFieldDate":
      return [{ ...base, kind: "date", value: typeof held?.value === "string" ? held.value.slice(0, 10) : undefined }];
    case "IssueFieldSingleSelect":
      return [pickField(definition.id, definition.name, typeof held?.value === "string" ? [held.value] : [], { editable })];
    case "IssueFieldMultiSelect":
      return [
        pickField(definition.id, definition.name, held?.options?.map((option) => option.name) ?? [], {
          several: true,
          shown: "labels",
          editable,
        }),
      ];
    default:
      return [];
  }
}

/** The issue fields GitHub's sidebar shows: the pinned ones in their order, then each other that holds
 *  a value. */
function shownIssueFields({ definitions, values, pinned }: NonNullable<GitHubExtras["issueFields"]>): GitHubFieldDefinition[] {
  const named = (name: string) => definitions.filter((definition) => definition.name === name);
  return [
    ...pinned.flatMap(named),
    ...definitions.filter(
      (definition) => !pinned.includes(definition.name) && values.some((value) => value.field.name === definition.name),
    ),
  ];
}

/** The fields an issue has, as the tab lists them, in the order of GitHub's own sidebar: those every
 *  issue has, then each that `extras` found the host to have. */
export function toFields(issue: GitHubIssue, extras: GitHubExtras): IssueField[] {
  const { issueType, parent, issueFields } = extras;
  const people = (users: (GitHubUser | null)[]): string[] => users.flatMap((user) => user?.login ?? []);
  return [
    pickField("assignees", "Assignees", people(issue.assignees.nodes), { several: true, shown: "people" }),
    pickField(
      "labels",
      "Labels",
      issue.labels.nodes.map((label) => label.name),
      { several: true, shown: "labels" },
    ),
    ...(issueType && (issueType.current !== null || issueType.available.length > 0)
      ? [pickField("type", "Type", issueType.current === null ? [] : [issueType.current], { editable: issueType.editable })]
      : []),
    pickField("milestone", "Milestone", issue.milestone ? [issue.milestone.title] : []),
    ...(parent === undefined ? [] : [pickField("parent", "Parent", parent === null ? [] : [parentName(parent)])]),
    ...(issueFields ? shownIssueFields(issueFields).flatMap((definition) => toIssueField(definition, issueFields)) : []),
    ...(issue.participants
      ? [pickField("participants", "Participants", people(issue.participants.nodes), { several: true, shown: "people", editable: false })]
      : []),
  ];
}

/** github.com's GraphQL lives on its own subdomain; GitHub Enterprise serves it under /api. */
function graphqlUrl(host: string): string {
  return host === "github.com" ? "https://api.github.com/graphql" : `https://${host}/api/graphql`;
}

function sender(host: string, token: string): GraphqlSend {
  return (query, variables) => sendGraphql(graphqlUrl(host), headers(token), query, variables);
}

/** A repository's path as GraphQL asks for it. */
function repositoryOf(path: string): { owner: string; name: string } {
  const [owner, name] = path.split("/");
  return { owner, name };
}

/** An issue of a repository by its number, as far as `selection` reads it beside its node id, the id
 *  GraphQL addresses it by. */
async function readIssueNode<T extends object = object>(
  send: GraphqlSend,
  path: string,
  number: number,
  selection = "",
): Promise<{ id: string } & T> {
  const query = `query(${ISSUE_VARIABLES}) { repository(owner: $owner, name: $name) { issue(number: $number) { id ${selection} } } }`;
  const data = (await send(query, { ...repositoryOf(path), number })) as { repository: { issue: { id: string } & T } };
  return data.repository.issue;
}

async function issueNodeId(send: GraphqlSend, path: string, number: number): Promise<string> {
  return (await readIssueNode(send, path, number)).id;
}

/** The node id GraphQL addresses a repository by, and the number its upload goes by. */
async function repositoryIds(send: GraphqlSend, path: string): Promise<{ id: string; databaseId: number }> {
  const query = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }";
  return ((await send(query, repositoryOf(path))) as { repository: { id: string; databaseId: number } }).repository;
}

/** Every node of one of a repository's connections, up to the cap; `args` beyond the paging. */
function repositoryNodes<T>(send: GraphqlSend, path: string, connection: string, selection: string, args = ""): Promise<T[]> {
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      ${connection}(first: 100, after: $cursor${args === "" ? "" : `, ${args}`}) {
        pageInfo { hasNextPage endCursor }
        nodes { ${selection} }
      }
    }
  }`;
  return allNodes<T>(
    send,
    query,
    repositoryOf(path),
    (data) => (data as { repository: Record<string, GraphqlPage<T>> }).repository[connection],
  );
}

/** A repository's labels by name, with their ids. */
function allLabels(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return repositoryNodes(send, path, "labels", "id name");
}

/** Who can be assigned, by login, with their ids. */
function allAssignable(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return repositoryNodes(send, path, "assignableUsers", "id name: login");
}

/** A repository's open milestones by title, with their ids. */
function allMilestones(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return repositoryNodes(send, path, "milestones", "id name: title", "states: [OPEN], orderBy: { field: DUE_DATE, direction: ASC }");
}

/** The issue types a repository offers, by name, with their ids. */
async function allIssueTypes(send: GraphqlSend, path: string): Promise<NamedId[]> {
  const types = await repositoryNodes<NamedId & { isEnabled: boolean }>(send, path, "issueTypes", "id name isEnabled");
  return types.filter((type) => type.isEnabled).map(({ id, name }) => ({ id, name }));
}

/** The open issues of a repository but the issue itself, by the name `parentName` gives them: the
 *  parents it can be given. */
async function openIssues({ send, path, number }: FieldContext<Target>): Promise<NamedId[]> {
  const entries = await repositoryNodes<{ id: string; number: number; title: string }>(
    send,
    path,
    "issues",
    "id number title",
    "states: OPEN, orderBy: { field: CREATED_AT, direction: DESC }",
  );
  return entries
    .filter((entry) => entry.number !== number)
    .map((entry) => ({ id: entry.id, name: parentName({ ...entry, repository: { nameWithOwner: path } }) }));
}

/** The issue fields an organization defines for a repository. */
async function readFieldDefinitions(send: GraphqlSend, path: string): Promise<GitHubFieldDefinition[]> {
  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { issueFields(first: 50) { nodes { ${fieldDefinitions(true)} } } }
  }`;
  const data = (await send(query, repositoryOf(path))) as { repository: { issueFields: { nodes: GitHubFieldDefinition[] } | null } };
  return data.repository.issueFields?.nodes ?? [];
}

/** The field of GitHub an id names: one of the table, or an issue field of the organization. */
async function fieldHandlerOf(send: GraphqlSend, path: string, fieldId: string): Promise<FieldHandler<Target>> {
  const known = ownValue(FIELD_HANDLERS, fieldId);
  if (known) {
    return known;
  }
  const definition = (await readFieldDefinitions(send, path)).find((candidate) => candidate.id === fieldId);
  if (!definition) {
    throw new Error(`An issue of GitHub has no field ${fieldId}`);
  }
  return issueFieldOf(definition);
}

/** The issue a change of a field is made on. */
async function readTarget(send: GraphqlSend, path: string, number: number): Promise<Target> {
  type WithParent = { parent?: { id: string } | null };
  // A host without sub-issues refuses the query that asks for the parent.
  const issue = await readIssueNode<WithParent>(send, path, number, "parent { id }").catch(() =>
    readIssueNode<WithParent>(send, path, number),
  );
  return { id: issue.id, parentId: issue.parent?.id };
}

/** A pull request of a repository by its number, as far as `selection` reads it beside its node id. */
async function readPullRequestNode<T extends object = object>(
  send: GraphqlSend,
  path: string,
  number: number,
  selection = "",
): Promise<{ id: string } & T> {
  const query = `query(${ISSUE_VARIABLES}) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id ${selection} } } }`;
  const data = (await send(query, { ...repositoryOf(path), number })) as {
    repository: { pullRequest: ({ id: string } & T) | null } | null;
  };
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) {
    throw new ApiError(404, `Pull request #${number} of ${path} was not found, or this account cannot read it`);
  }
  return pullRequest;
}

/** What a change of a pull request's field needs of it: its id, and the ids of who reviewed it, whose
 *  review stays and is not asked for again. */
interface PullRequestTarget {
  id: string;
  reviewedIds: string[];
}

function updatePullRequestWrite(input: object): Write {
  return { mutation: "updatePullRequest", inputType: "UpdatePullRequestInput", input };
}

/** The fields of a pull request, by the id `toPullRequestFields` gives them. */
export const PULL_REQUEST_FIELD_HANDLERS: Record<string, FieldHandler<PullRequestTarget>> = {
  reviewers: pickHandler({ what: "reviewer", choices: ({ send, path }) => allAssignable(send, path) }, (target, ids) => ({
    mutation: "requestReviews",
    inputType: "RequestReviewsInput",
    input: { pullRequestId: target.id, userIds: ids.filter((id) => !target.reviewedIds.includes(id)), union: false },
  })),
  assignees: pickHandler({ what: "person to assign", choices: ({ send, path }) => allAssignable(send, path) }, (target, ids) =>
    updatePullRequestWrite({ pullRequestId: target.id, assigneeIds: ids }),
  ),
  labels: pickHandler({ what: "label", choices: ({ send, path }) => allLabels(send, path) }, (target, ids) =>
    updatePullRequestWrite({ pullRequestId: target.id, labelIds: ids }),
  ),
};

async function readPullRequestTarget(send: GraphqlSend, path: string, number: number): Promise<PullRequestTarget> {
  const found = await readPullRequestNode<{ latestReviews: { nodes: { author: { id?: string } | null }[] } }>(
    send,
    path,
    number,
    "latestReviews(first: 50) { nodes { author { ... on User { id } } } }",
  );
  return { id: found.id, reviewedIds: found.latestReviews.nodes.flatMap((review) => review.author?.id ?? []) };
}

const pullRequestFields = fieldMethods<PullRequestTarget>({
  graphql: sender,
  handlerOf: (_send, _path, fieldId) => {
    const handler = ownValue(PULL_REQUEST_FIELD_HANDLERS, fieldId);
    if (!handler) {
      throw new Error(`A pull request of GitHub has no field ${fieldId}`);
    }
    return handler;
  },
  readTarget: readPullRequestTarget,
  mutate,
});

/** The fields only some hosts have, each asked on its own: a host that lacks one refuses its query
 *  whole, and the issue then shows without it. */
async function readExtras(send: GraphqlSend, variables: object): Promise<GitHubExtras> {
  const ask = async <T>(query: string): Promise<T | undefined> =>
    ((await send(query, variables).catch(() => undefined)) as { repository: T } | undefined)?.repository;
  const [types, parent, fields] = await Promise.all([
    ask<{
      issueTypes: { nodes: { name: string; isEnabled: boolean }[] } | null;
      issue: { viewerCanType: boolean; issueType: { name: string } | null };
    }>(TYPE_QUERY),
    ask<{ issue: { parent: GitHubParent | null } }>(PARENT_QUERY),
    ask<{
      issueFields: { nodes: GitHubFieldDefinition[] } | null;
      owner: { pinnedIssueFields?: { nodes: { name: string }[] } | null };
      issue: {
        viewerCanSetFields: boolean;
        issueType: { pinnedFields: { name: string }[] } | null;
        issueFieldValues: { nodes: GitHubFieldValue[] } | null;
      };
    }>(FIELDS_QUERY),
  ]);
  return {
    issueType: types && {
      current: types.issue.issueType?.name ?? null,
      available: (types.issueTypes?.nodes ?? []).filter((type) => type.isEnabled).map((type) => type.name),
      editable: types.issue.viewerCanType,
    },
    parent: parent?.issue.parent,
    issueFields: fields && {
      definitions: fields.issueFields?.nodes ?? [],
      values: fields.issue.issueFieldValues?.nodes ?? [],
      pinned: (fields.issue.issueType?.pinnedFields ?? fields.owner.pinnedIssueFields?.nodes ?? []).map((field) => field.name),
      editable: fields.issue.viewerCanSetFields,
    },
  };
}

/** One mutation. GitHub words a refusal as a GraphQL error, so a payload is asked for no more than its
 *  `clientMutationId`. */
function mutate<T>(send: GraphqlSend, write: Write, selection = "clientMutationId"): Promise<T> {
  return sendMutation<T>(send, write, selection);
}

/** The only files its upload takes from a token, by extension: it refuses any other type. */
const UPLOAD_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** What the upload takes a file as, off its name; undefined for one it refuses. */
export function contentTypeOf(name: string): string | undefined {
  return UPLOAD_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
}

/** What shows an upload in a text: an image by name, a video by its bare URL. */
export function uploadMarkdown(name: string, url: string, contentType: string): string {
  return contentType.startsWith("video/") ? url : `![${name.replace(/[\\[\]]/g, "\\$&")}](${url})`;
}

/** github.com and its data residency tenants have the upload; a GitHub Enterprise Server does not. */
function hasUpload(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/** What a filter asks for, in the words of `ISSUES_QUERY` and `LATEST_QUERY`. Its `labels` leave an issue with any of
 *  them, so `carriesAll` narrows what it answers. */
export function issuesVariables(path: string, filter: IssueFilter): Record<string, unknown> {
  return {
    ...repositoryOf(path),
    filter: {
      states: filter.state && [filter.state === "open" ? "OPEN" : "CLOSED"],
      createdBy: filter.author,
      assignee: filter.assignee,
      labels: filter.labels.length > 0 ? filter.labels : undefined,
    },
  };
}

/** Whether an issue carries every one of a filter's labels. */
export function carriesAll(entry: GitHubIssue, labels: string[]): boolean {
  return labels.every((label) => entry.labels.nodes.some((node) => node.name === label));
}

/** Each user's picture by login, at about twice the size it is drawn: unasked, GitHub sends the whole. */
function avatarsOf(users: (GitHubUser | null)[]): Record<string, string> {
  const avatars: Record<string, string> = {};
  for (const user of users) {
    const url = user && URL.parse(user.avatarUrl);
    if (user && url) {
      url.searchParams.set("s", "40");
      avatars[user.login] = url.href;
    }
  }
  return avatars;
}

/** Who an issue is assigned to; a deleted account is none. */
function assigneesOf(entry: GitHubIssue): GitHubUser[] {
  return entry.assignees.nodes.flatMap((person) => person ?? []);
}

export function toIssue(entry: GitHubIssue): Issue {
  const assignees = assigneesOf(entry);
  return {
    number: entry.number,
    title: entry.title,
    url: entry.url,
    open: entry.state === "OPEN",
    author: entry.author?.login ?? "ghost",
    assignee: assignees[0]?.login,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    labels: entry.labels.nodes.map((label) => label.name),
    avatars: avatarsOf([entry.author, ...assignees]),
  };
}

function toNote(entry: GitHubComment): IssueNote {
  return {
    id: entry.id,
    author: entry.author?.login ?? "ghost",
    createdAt: entry.createdAt,
    body: entry.body,
  };
}

/** An open pull request as `findChangeRequest` reads it; `headRepository` null for a deleted fork. */
export interface GitHubPullRequest {
  number: number;
  url: string;
  headRepository: { nameWithOwner: string } | null;
}

/** The one of `path`'s own branch among those of a branch of that name, a fork's left out. */
export function ownPullRequest(found: GitHubPullRequest[], path: string): ChangeRequest | undefined {
  const own = found.find((entry) => entry.headRepository?.nameWithOwner.toLowerCase() === path.toLowerCase());
  return own && { number: own.number, url: own.url };
}

export const github: GitProvider = {
  /** The names most tools take, gh among them: for github.com its token, for GitHub Enterprise the
   *  token and which host it is. */
  tokenEnv: (host, token): Record<string, string> =>
    host === "github.com" ? { GITHUB_TOKEN: token } : { GITHUB_ENTERPRISE_TOKEN: token, GH_HOST: host },

  async validate(host, token) {
    const data = (await sender(host, token)("{ viewer { login } }", {})) as { viewer: { login?: unknown } | null };
    const login = data.viewer?.login;
    if (typeof login !== "string" || login === "") {
      throw new Error("The API answered without a login");
    }
    return login;
  },

  async listRepositories(host, token) {
    // Both affiliations, or it leaves out the organizations' repositories.
    const query = `query($cursor: String) {
      viewer {
        repositories(
          first: 100
          after: $cursor
          orderBy: { field: PUSHED_AT, direction: DESC }
          affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
        ) {
          pageInfo { hasNextPage endCursor }
          nodes { nameWithOwner name url }
        }
      }
    }`;
    type Repository = { nameWithOwner: string; name: string; url: string };
    const entries = await allNodes<Repository>(
      sender(host, token),
      query,
      {},
      (data) => (data as { viewer: { repositories: GraphqlPage<Repository> } }).viewer.repositories,
    );
    return entries.map((entry): RemoteRepository => ({
      fullName: entry.nameWithOwner,
      name: entry.name,
      cloneUrl: `${entry.url}.git`,
    }));
  },

  async listIssues({ host, token, path }, filter, limit) {
    if (filter.text) {
      const found = await firstNodes<GitHubIssue>(
        sender(host, token),
        ISSUE_SEARCH_QUERY,
        { query: issueSearch(path, filter, "created") },
        (data) => (data as { search: GraphqlPage<GitHubIssue> }).search,
        limit,
      );
      return found.map(toIssue);
    }
    const entries = await firstNodes<GitHubIssue>(
      sender(host, token),
      ISSUES_QUERY,
      issuesVariables(path, filter),
      (data) => (data as { repository: { issues: GraphqlPage<GitHubIssue> } }).repository.issues,
      limit,
      (entry) => carriesAll(entry, filter.labels),
    );
    return entries.map(toIssue);
  },

  async readLatest({ host, token, path }, filter) {
    if (filter.text) {
      const found = (await sender(host, token)(ISSUE_SEARCH_LATEST_QUERY, { query: issueSearch(path, filter, "updated") })) as {
        search: { issueCount: number; nodes: { updatedAt: string }[] };
      };
      return { total: found.search.issueCount, updatedAt: found.search.nodes[0]?.updatedAt };
    }
    const data = (await sender(host, token)(LATEST_QUERY, issuesVariables(path, filter))) as {
      repository: { issues: { totalCount: number; nodes: { updatedAt: string }[] } };
    };
    const { totalCount, nodes } = data.repository.issues;
    return { total: totalCount, updatedAt: nodes[0]?.updatedAt };
  },

  async listLabels({ host, token, path }) {
    return (await allLabels(sender(host, token), path)).map((entry) => entry.name);
  },

  async listPeople({ host, token, path }) {
    return (await allAssignable(sender(host, token), path)).map((entry) => entry.name);
  },

  async readIssue({ host, token, path }, number) {
    const send = sender(host, token);
    const variables = { ...repositoryOf(path), number };
    const [issueData, extras] = await Promise.all([send(ISSUE_QUERY, variables), readExtras(send, variables)]);
    const data = issueData as {
      repository: {
        issue: GitHubIssue & { commentPage: GraphqlPage<GitHubComment>; timelineItems: GraphqlPage<GitHubEvent> };
      };
    };
    const found = data.repository.issue;
    const [laterComments, laterEvents] = await Promise.all([
      found.commentPage.pageInfo.hasNextPage
        ? allNodes<GitHubComment>(
            send,
            COMMENTS_QUERY,
            { ...variables, cursor: found.commentPage.pageInfo.endCursor },
            (answer) => (answer as { repository: { issue: { comments: GraphqlPage<GitHubComment> } } }).repository.issue.comments,
          )
        : [],
      found.timelineItems.pageInfo.hasNextPage
        ? allNodes<GitHubEvent>(
            send,
            TIMELINE_QUERY,
            { ...variables, cursor: found.timelineItems.pageInfo.endCursor },
            (answer) => (answer as { repository: { issue: { timelineItems: GraphqlPage<GitHubEvent> } } }).repository.issue.timelineItems,
          )
        : [],
    ]);
    const assignees = assigneesOf(found);
    const comments = [...found.commentPage.nodes, ...laterComments];
    const items = [...found.timelineItems.nodes, ...laterEvents];
    return {
      ...toIssue(found),
      provider: "github",
      avatars: avatarsOf([
        found.author,
        ...assignees,
        ...(found.participants?.nodes ?? []),
        ...comments.map((comment) => comment.author),
        ...items.map((item) => item.actor),
      ]),
      events: toEvents(items),
      fields: toFields(found, extras),
      body: found.body ?? "",
      notes: comments.map(toNote),
    };
  },

  async readImage({ host, token }, source) {
    return readsWithToken(host, source) ? fetchImageOk(source, { Authorization: `Bearer ${token}`, "User-Agent": "tet" }) : undefined;
  },

  uploadName: attachmentName,

  async readUpload({ host, token }, source) {
    return attachmentName(host, source) === undefined
      ? undefined
      : fetchUploadOk(source, { Authorization: `Bearer ${token}`, "User-Agent": "tet" });
  },

  internalNotes: false,

  async addComment({ host, token, path }, number, body) {
    const send = sender(host, token);
    await mutate(send, {
      mutation: "addComment",
      inputType: "AddCommentInput",
      input: { subjectId: await issueNodeId(send, path, number), body },
    });
  },

  async updateIssue({ host, token, path }, number, change) {
    const send = sender(host, token);
    await mutate(send, updateIssueWrite(toIssueInput(await issueNodeId(send, path, number), change)));
  },

  ...fieldMethods({ graphql: sender, handlerOf: fieldHandlerOf, readTarget, mutate }),

  changeRequest: { noun: "pull request", prefix: "#", checks: "checks", selfApproval: false, deletesSourceBranch: false },

  async findChangeRequest({ host, token, path }, head) {
    // `headRefName` matches a fork's branch of that name too, so its repository is read alongside.
    const query = `query($owner: String!, $name: String!, $head: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $head, states: OPEN, first: 20) {
          nodes { number url headRepository { nameWithOwner } }
        }
      }
    }`;
    const data = (await sender(host, token)(query, { ...repositoryOf(path), head })) as {
      repository: { pullRequests: { nodes: GitHubPullRequest[] } } | null;
    };
    if (!data.repository) {
      throw new ApiError(404, `${path} was not found, or this account cannot read it`);
    }
    return ownPullRequest(data.repository.pullRequests.nodes, path);
  },

  async createChangeRequest({ host, token, path }, { head, base, title, body, draft }) {
    const send = sender(host, token);
    const { id } = await repositoryIds(send, path);
    const { pullRequest } = await mutate<{ pullRequest: { number: number; url: string } }>(
      send,
      {
        mutation: "createPullRequest",
        inputType: "CreatePullRequestInput",
        input: { repositoryId: id, headRefName: head, baseRefName: base, title, body, draft },
      },
      "pullRequest { number url }",
    );
    return { number: pullRequest.number, url: pullRequest.url };
  },

  // GitHub refuses its author (`selfApproval`), in its own words.
  async approveChangeRequest({ host, token, path }, number) {
    const send = sender(host, token);
    const { id } = await readPullRequestNode(send, path, number);
    await mutate(send, {
      mutation: "addPullRequestReview",
      inputType: "AddPullRequestReviewInput",
      input: { pullRequestId: id, event: "APPROVE" },
    });
  },

  async autoMergeChangeRequest({ host, token, path }, number, squash) {
    const send = sender(host, token);
    const query =
      "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }";
    const data = (await send(query, { ...repositoryOf(path), number })) as { repository: { pullRequest: { id: string } | null } | null };
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      throw new ApiError(404, `Pull request #${number} of ${path} was not found, or this account cannot read it`);
    }
    await mutate(send, {
      mutation: "enablePullRequestAutoMerge",
      inputType: "EnablePullRequestAutoMergeInput",
      input: { pullRequestId: pullRequest.id, mergeMethod: squash ? "SQUASH" : "MERGE" },
    });
  },

  async listChangeRequests({ host, token, path }, filter, limit) {
    const entries = await firstNodes<GitHubPullRequestRow>(
      sender(host, token),
      PULL_REQUESTS_QUERY,
      { query: pullRequestSearch(path, filter, "created") },
      (data) => (data as { search: GraphqlPage<GitHubPullRequestRow> }).search,
      limit,
      (entry) => fromOwnBranch(entry, path),
    );
    return entries.map(toChangeRequestRow);
  },

  async readChangeRequestsLatest({ host, token, path }, filter) {
    type Latest = Pick<GitHubPullRequestRow, "number" | "updatedAt" | "headRepository"> & {
      head: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
    };
    const data = (await sender(host, token)(PULL_REQUESTS_LATEST_QUERY, { query: pullRequestSearch(path, filter, "updated") })) as {
      search: { issueCount: number; nodes: Latest[] };
    };
    const own = data.search.nodes.filter((entry) => fromOwnBranch(entry, path));
    return {
      total: data.search.issueCount,
      updatedAt: own[0]?.updatedAt,
      checks: checksText(own.map((entry) => ({ number: entry.number, checks: checksOf(entry.head.nodes[0]?.commit.statusCheckRollup) }))),
    };
  },

  async readChangeRequest({ host, token, path }, number) {
    const send = sender(host, token);
    const variables = { ...repositoryOf(path), number };
    const data = (await send(PULL_REQUEST_QUERY, variables)) as { repository: { pullRequest: GitHubPullRequestDetail | null } | null };
    const found = data.repository?.pullRequest;
    if (!found) {
      throw new ApiError(404, `Pull request #${number} of ${path} was not found, or this account cannot read it`);
    }
    type Answer = { repository: { pullRequest: { comments: GraphqlPage<GitHubComment>; timelineItems: GraphqlPage<GitHubEvent> } } };
    const [laterComments, laterItems] = await Promise.all([
      found.commentPage.pageInfo.hasNextPage
        ? allNodes<GitHubComment>(
            send,
            PULL_REQUEST_COMMENTS_QUERY,
            { ...variables, cursor: found.commentPage.pageInfo.endCursor },
            (answer) => (answer as Answer).repository.pullRequest.comments,
          )
        : [],
      found.timelineItems.pageInfo.hasNextPage
        ? allNodes<GitHubEvent>(
            send,
            PULL_REQUEST_TIMELINE_QUERY,
            { ...variables, cursor: found.timelineItems.pageInfo.endCursor },
            (answer) => (answer as Answer).repository.pullRequest.timelineItems,
          )
        : [],
    ]);
    const comments = [...found.commentPage.nodes, ...laterComments];
    const items = [...found.timelineItems.nodes, ...laterItems];
    const row = toChangeRequestRow(found);
    const rollup = found.head.nodes[0]?.commit.statusCheckRollup;
    return {
      ...row,
      provider: "github",
      kind: github.changeRequest,
      avatars: avatarsOf([
        found.author,
        ...assigneesOf(found),
        ...found.participants.nodes,
        ...found.reviewRequests.nodes.map((request) => request.requestedReviewer),
        ...found.latestReviews.nodes.map((review) => review.author),
        ...comments.map((comment) => comment.author),
        ...items.map((item) => item.actor),
      ]),
      events: toPullRequestEvents(items),
      fields: toPullRequestFields(found),
      body: found.body,
      notes: [...comments.map(toNote), ...reviewNotes(items)],
      status: {
        state: row.state,
        draft: row.draft,
        checks: row.checks,
        failedChecks: failedChecksOf(rollup),
        checksUrl: rollup ? `${found.url}/checks` : undefined,
        conflicts: found.mergeable === "CONFLICTING",
        autoMerge: found.autoMergeRequest !== null,
        // GitHub refuses auto-merge for one that can merge at once, which `viewerCanEnableAutoMerge`
        // leaves out: that is `MERGEABLE` and neither blocked nor behind its base.
        autoMergeable:
          found.viewerCanEnableAutoMerge &&
          (found.mergeable !== "MERGEABLE" || found.mergeStateStatus === "BLOCKED" || found.mergeStateStatus === "BEHIND"),
        head: found.headRefName,
        base: found.baseRefName,
        commits: found.commitCount.totalCount,
        additions: found.additions,
        deletions: found.deletions,
        mergedBy: found.mergedBy?.login,
        mergedAt: found.mergedAt ?? undefined,
      },
    };
  },

  listChangeRequestOptions: pullRequestFields.listOptions,

  setChangeRequestField: pullRequestFields.setField,

  async updateChangeRequest({ host, token, path }, number, { title, body, state }) {
    const send = sender(host, token);
    const { id } = await readPullRequestNode(send, path, number);
    await mutate(send, updatePullRequestWrite({ pullRequestId: id, title, body, state: state && (state === "open" ? "OPEN" : "CLOSED") }));
  },

  async commentChangeRequest({ host, token, path }, number, body) {
    const send = sender(host, token);
    const { id } = await readPullRequestNode(send, path, number);
    await mutate(send, { mutation: "addComment", inputType: "AddCommentInput", input: { subjectId: id, body } });
  },

  async mergeChangeRequest({ host, token, path }, number, whenChecksPass) {
    const send = sender(host, token);
    const query = `query(${ISSUE_VARIABLES}) {
      repository(owner: $owner, name: $name) { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed pullRequest(number: $number) { id } }
    }`;
    type Answer = {
      repository: {
        mergeCommitAllowed: boolean;
        squashMergeAllowed: boolean;
        rebaseMergeAllowed: boolean;
        pullRequest: { id: string } | null;
      } | null;
    };
    const { repository } = (await send(query, { ...repositoryOf(path), number })) as Answer;
    if (!repository?.pullRequest) {
      throw new ApiError(404, `Pull request #${number} of ${path} was not found, or this account cannot read it`);
    }
    const input = { pullRequestId: repository.pullRequest.id, mergeMethod: defaultMergeMethod(repository) };
    await mutate(
      send,
      whenChecksPass
        ? { mutation: "enablePullRequestAutoMerge", inputType: "EnablePullRequestAutoMergeInput", input }
        : { mutation: "mergePullRequest", inputType: "MergePullRequestInput", input },
    );
  },

  confidentialIssues: false,

  async createIssue({ host, token, path }, title, body) {
    const send = sender(host, token);
    const { id } = await repositoryIds(send, path);
    const { issue } = await mutate<{ issue: { number: number } }>(
      send,
      { mutation: "createIssue", inputType: "CreateIssueInput", input: { repositoryId: id, title, body } },
      "issue { number }",
    );
    return issue.number;
  },

  async editComment({ host, token }, id, body) {
    await mutate(sender(host, token), {
      mutation: "updateIssueComment",
      inputType: "UpdateIssueCommentInput",
      input: { id, body },
    });
  },

  async deleteComment({ host, token }, id) {
    await mutate(sender(host, token), { mutation: "deleteIssueComment", inputType: "DeleteIssueCommentInput", input: { id } });
  },

  async deleteIssue({ host, token, path }, number) {
    const send = sender(host, token);
    await mutate(send, {
      mutation: "deleteIssue",
      inputType: "DeleteIssueInput",
      input: { issueId: await issueNodeId(send, path, number) },
    });
  },

  uploads: (host) => (hasUpload(host) ? { extensions: Object.keys(UPLOAD_TYPES) } : undefined),

  // Undocumented, and the one GitHub's own CLI uploads with; the bytes go as they are.
  async uploadFile({ host, token, path }, name, bytes) {
    const contentType = contentTypeOf(name);
    if (contentType === undefined) {
      throw new Error(`GitHub takes only images and videos from a token: attach ${name} on ${host}`);
    }
    const { databaseId } = await repositoryIds(sender(host, token), path);
    const query = new URLSearchParams({ name, content_type: contentType, repository_id: String(databaseId) });
    const response = await fetchOk(
      `https://uploads.${host}/user-attachments/assets?${query.toString()}`,
      { ...headers(token), "Content-Type": "application/octet-stream" },
      { method: "POST", body: bytes },
    ).catch((error: unknown) => {
      // It answers 404, not 403, to a token it takes no upload from, and to one that cannot write.
      throw error instanceof ApiError && error.status === 404
        ? new Error(`GitHub takes no upload of ${name} from this token: it needs write access and a token type it accepts`)
        : error;
    });
    const { url } = (await response.json()) as { url?: string };
    if (!url) {
      throw new Error(`GitHub answered the upload of ${name} without its URL`);
    }
    return uploadMarkdown(name, url, contentType);
  },
};
