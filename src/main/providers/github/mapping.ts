import {
  linkedIssueName,
  type ChangeRequest,
  type ChangeRequestCheck,
  type ChangeRequestReviewer,
  type ChangeRequestRow,
  type ChangeRequestState,
  type ChecksState,
  type Issue,
  type ReviewThread,
  type TrackedChange,
  type TrackedEvent,
  type TrackedField,
  type TrackedNote,
} from "../../../shared/types/providers";
import { changeRequestFields, pickField, type GraphqlPage, type NamedId } from "../provider";

/** A user as GraphQL says it; null for a deleted account. */
export interface GitHubUser {
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

/** What an issue has of the fields only some hosts have: each is read on its own (`readExtras`), and
 *  left out where the host refuses it. */
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
export interface GitHubCheckRollup {
  state: string;
  contexts?: { nodes: GitHubCheckContext[] };
}

/** A check run or a commit status of a rollup (`PULL_REQUEST_QUERY`); `isRequired` is for the pull request asked. */
export interface GitHubCheckContext {
  __typename: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string;
  description?: string | null;
  targetUrl?: string | null;
  isRequired: boolean;
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
  reviewDecision: string | null;
  mergedAt: string | null;
  mergedBy: { login: string } | null;
  autoMergeRequest: { enabledAt: string | null } | null;
  viewerCanEnableAutoMerge: boolean;
  commitCount: { totalCount: number };
  reviewRequests: { nodes: { requestedReviewer: GitHubUser | null }[] };
  latestReviews: { nodes: { author: GitHubUser | null }[] };
  latestOpinionatedReviews: { nodes: { author: { login: string } | null; state: string }[] };
  closingIssuesReferences: { nodes: { number: number; title: string }[] } | null;
  participants: { nodes: (GitHubUser | null)[] };
  commentPage: GraphqlPage<GitHubComment>;
  timelineItems: GraphqlPage<GitHubEvent>;
  reviewThreads: GraphqlPage<GitHubReviewThread>;
}

/** A review thread as GraphQL says it (`REVIEW_THREAD_PAGE`); `line` is null once its lines changed,
 *  `originalLine` where it was written. */
export interface GitHubReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: GraphqlPage<GitHubComment>;
}

/** The timeline items an issue and a pull request both have, as `toEvent` reads them; a pull request's
 *  own are `toPullRequestEvents`'. */
export const EVENT_KINDS: Record<
  string,
  Exclude<TrackedEvent["kind"], "text" | "review-requested" | "reviewed" | "pushed" | "merged"> | undefined
> = {
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

/** What a timeline item shows, for those the tab draws; a comment is read on its own. */
export function toEvent(item: GitHubEvent): TrackedEvent | undefined {
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

export function toEvents(items: GitHubEvent[]): TrackedEvent[] {
  return items.map(toEvent).filter((event) => event !== undefined);
}

/** What a review's verdict shows as an event; one that only comments shows as its text alone. */
export const REVIEW_VERDICTS: Record<string, "approved" | "changes-requested" | undefined> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
};

/** A pull request's timeline as the tab draws it: an issue's events, and its own. A run of commits by
 *  one author is one push, at its first. */
export function toPullRequestEvents(items: GitHubEvent[]): TrackedEvent[] {
  const events: TrackedEvent[] = [];
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
export function reviewNotes(items: GitHubEvent[]): TrackedNote[] {
  return items.flatMap((item) =>
    item.__typename === "PullRequestReview" && item.id !== undefined && item.body?.trim()
      ? [{ id: item.id, author: item.actor?.login ?? "ghost", createdAt: item.createdAt, body: item.body, fixed: true as const }]
      : [],
  );
}

/** A pull request's review threads as the tab shows them, one without comments left out. */
export function toReviewThreads(threads: GitHubReviewThread[]): ReviewThread[] {
  return threads.flatMap((thread) =>
    thread.comments.nodes.length === 0
      ? []
      : [
          {
            id: thread.id,
            path: thread.path,
            line: thread.line ?? thread.originalLine ?? undefined,
            resolved: thread.isResolved,
            outdated: thread.isOutdated,
            comments: thread.comments.nodes.map(toNote),
          },
        ],
  );
}

/** How GitHub's rollup of a commit's checks stands, in TET's words; undefined for a commit without any. */
export function checksOf(rollup: { state: string } | null | undefined): ChecksState | undefined {
  switch (rollup?.state ?? "") {
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
export const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/** What a check run that completed without failing counts as: it passed, or it did not count. */
export const PASSED_CONCLUSIONS: Record<string, ChangeRequestCheck["state"] | undefined> = {
  SUCCESS: "passed",
  NEUTRAL: "skipped",
  SKIPPED: "skipped",
  STALE: "skipped",
};

/** The checks of a rollup, check runs and commit statuses alike. */
export function checkListOf(rollup: GitHubCheckRollup | null | undefined): ChangeRequestCheck[] {
  return (rollup?.contexts?.nodes ?? []).flatMap((entry): ChangeRequestCheck[] => {
    if (entry.__typename === "CheckRun") {
      if (entry.name === undefined) {
        return [];
      }
      const state =
        entry.status !== "COMPLETED"
          ? "running"
          : FAILED_CONCLUSIONS.has(entry.conclusion ?? "")
            ? "failed"
            : (PASSED_CONCLUSIONS[entry.conclusion ?? ""] ?? "passed");
      return [{ name: entry.name, state, url: entry.detailsUrl ?? undefined, required: entry.isRequired }];
    }
    if (entry.context === undefined) {
      return [];
    }
    const state = entry.state === "SUCCESS" ? "passed" : entry.state === "FAILURE" || entry.state === "ERROR" ? "failed" : "running";
    return [
      {
        name: entry.context,
        state,
        detail: entry.description ?? undefined,
        url: entry.targetUrl ?? undefined,
        required: entry.isRequired,
      },
    ];
  });
}

/** Each reviewer's latest approval or request for changes (one since dismissed stands no more), a
 *  review asked for again over it; a team asked for has no login and is left out. */
export function reviewersOf(found: Pick<GitHubPullRequestDetail, "latestOpinionatedReviews" | "reviewRequests">): ChangeRequestReviewer[] {
  const reviewers = new Map<string, ChangeRequestReviewer["state"]>();
  for (const review of found.latestOpinionatedReviews.nodes) {
    if (review.author && (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")) {
      reviewers.set(review.author.login, review.state === "APPROVED" ? "approved" : "changes-requested");
    }
  }
  for (const request of found.reviewRequests.nodes) {
    const requested = request.requestedReviewer as Partial<GitHubUser> | null;
    if (requested?.login !== undefined) {
      reviewers.set(requested.login, "requested");
    }
  }
  return [...reviewers].map(([login, state]) => ({ login, state }));
}

/** What keeps a pull request from merging beside its checks, approvals and conflicts. */
export function blockersOf(found: Pick<GitHubPullRequestDetail, "mergeStateStatus" | "reviewDecision">): string[] {
  return [
    ...(found.reviewDecision === "CHANGES_REQUESTED" ? ["Changes requested"] : []),
    ...(found.mergeStateStatus === "BEHIND" ? ["Branch is behind its base"] : []),
  ];
}

/** Whether a pull request is from a branch of `path` itself; a search answers other kinds as empty nodes. */
export function fromOwnBranch(entry: { headRepository?: { nameWithOwner: string } | null }, path: string): boolean {
  return entry.headRepository?.nameWithOwner.toLowerCase() === path.toLowerCase();
}

export const PULL_REQUEST_STATES: Record<string, ChangeRequestState | undefined> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };

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

/** The fields a pull request has (`changeRequestFields`); its reviewers are those who reviewed it and
 *  those asked to. */
export function toPullRequestFields(found: GitHubPullRequestDetail): TrackedField[] {
  const people = (users: (GitHubUser | null)[]): string[] => users.flatMap((user) => user?.login ?? []);
  const reviewers = [
    ...people(found.latestReviews.nodes.map((review) => review.author)),
    ...people(found.reviewRequests.nodes.map((request) => request.requestedReviewer)),
  ];
  return changeRequestFields({
    reviewers: [...new Set(reviewers)],
    assignees: people(found.assignees.nodes),
    labels: found.labels.nodes.map((label) => label.name),
    linkedIssues: (found.closingIssuesReferences?.nodes ?? []).map((issue) => linkedIssueName(issue.number, issue.title)),
    participants: people(found.participants.nodes),
  });
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

/** An issue's or a pull request's state, in GitHub's words. */
export function githubState(state: "open" | "closed"): "OPEN" | "CLOSED" {
  return state === "open" ? "OPEN" : "CLOSED";
}

/** What of a change `updateIssue` sets, in GitHub's words. */
export function toIssueInput(issueId: string, { title, body, state }: TrackedChange): object {
  return { id: issueId, title, body, state: state && githubState(state) };
}

/** A parent as its field shows and lists it: its title and where it is, since a number is only unique
 *  in its repository. */
export function parentName(parent: GitHubParent): string {
  return `${parent.title} (${parent.repository.nameWithOwner}#${parent.number})`;
}

/** What an issue field of the organization holds of an issue, as the tab lists it. */
export function toIssueField(
  definition: GitHubFieldDefinition,
  { values, editable }: { values: GitHubFieldValue[]; editable: boolean },
): TrackedField[] {
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
export function shownIssueFields({ definitions, values, pinned }: NonNullable<GitHubExtras["issueFields"]>): GitHubFieldDefinition[] {
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
export function toFields(issue: GitHubIssue, extras: GitHubExtras): TrackedField[] {
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

/** Whether an issue carries every one of a filter's labels. */
export function carriesAll(entry: GitHubIssue, labels: string[]): boolean {
  return labels.every((label) => entry.labels.nodes.some((node) => node.name === label));
}

/** Each user's picture by login, at about twice the size it is drawn: unasked, GitHub sends the whole. */
export function avatarsOf(users: (GitHubUser | null)[]): Record<string, string> {
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
export function assigneesOf(entry: GitHubIssue): GitHubUser[] {
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

export function toNote(entry: GitHubComment): TrackedNote {
  return {
    id: entry.id,
    author: entry.author?.login ?? "ghost",
    createdAt: entry.createdAt,
    body: entry.body,
  };
}

/** An open pull request as `changeRequests.find` reads it; `headRepository` null for a deleted fork. */
export interface GitHubPullRequest {
  number: number;
  url: string;
  headRepository: { nameWithOwner: string } | null;
}

/** The one of `path`'s own branch among those of a branch of that name, a fork's left out. */
export function ownPullRequest(found: GitHubPullRequest[], path: string): ChangeRequest | undefined {
  const own = found.find((entry) => fromOwnBranch(entry, path));
  return own && { number: own.number, url: own.url };
}
