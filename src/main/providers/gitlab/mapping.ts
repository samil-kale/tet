import {
  linkedIssueName,
  type ChangeRequest,
  type ChangeRequestCheck,
  type ChangeRequestReviewer,
  type ChangeRequestRow,
  type ChangeRequestState,
  type ChecksState,
  type Issue,
  type IssueTimeLog,
  type ReviewThread,
  type TrackedChange,
  type TrackedEvent,
  type TrackedField,
  type TrackedNote,
} from "../../../shared/types/providers";
import { changeRequestFields, pickField, type GraphqlPage, type NamedId } from "../provider";

export interface GitLabUser {
  username: string;
}
/** An issue as GraphQL says it; only one read alone has its description. */

export interface GitLabIssue {
  iid: string;
  title: string;
  webUrl: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  author: GitLabUser;
  assignees: { nodes: GitLabUser[] };
  labels: { nodes: { title: string }[] };
  description?: string | null;
}
/** An iteration as GraphQL says it; `title` is null for one named by its dates alone. */

export interface GitLabIteration {
  id: string;
  title: string | null;
  startDate: string | null;
  dueDate: string | null;
  iterationCadence: { title: string };
}
/** The work item a parent is, as the parent field names it. */

export interface GitLabParent {
  iid: string;
  title: string;
  workItemType: { name: string };
  namespace: { fullPath: string };
}
/** A booking of time as GraphQL says it; `timeSpent` is in seconds, negative for time taken off. */

export interface GitLabTimelog {
  id: string;
  timeSpent: number;
  spentAt: string | null;
  summary: string | null;
  user: GitLabUser;
  userPermissions: { adminTimelog: boolean };
}
/** One of a work item's widgets as GraphQL says it: `type` names it, and it holds what its own
 *  fragment of `WIDGETS` selected, the rest left out. */

export interface GitLabWidget {
  type: string;
  assignees?: { nodes: GitLabUser[] };
  labels?: { nodes: { title: string }[] };
  status?: { name: string } | null;
  parent?: GitLabParent | null;
  weight?: number | null;
  milestone?: { title: string } | null;
  iteration?: GitLabIteration | null;
  startDate?: string | null;
  dueDate?: string | null;
  healthStatus?: string | null;
  humanReadableAttributes?: { timeEstimate: string | null; totalTimeSpent: string | null };
  timelogs?: { nodes: GitLabTimelog[] };
  participants?: { nodes: GitLabUser[] };
}
/** An issue as the work item it also is: what its type and plan give it beside its text. */

export interface GitLabWorkItem {
  confidential: boolean;
  widgets: GitLabWidget[];
}
/** A note as GraphQL says it; `author` is null for a deleted account. */

export interface GitLabNote {
  id: string;
  /** What GitLab wrote itself (a label added, an assignee changed), not a comment. */
  system: boolean;
  /** Visible to the project's members alone. */
  internal: boolean;
  body: string;
  createdAt: string;
  author: GitLabUser | null;
  /** A merge request's alone (`MERGE_REQUEST_NOTE_PAGE`): where on its changes it was written, null
   *  for one that was not, and the discussion it is in. */
  position?: { filePath: string; newLine: number | null; oldLine: number | null } | null;
  discussion?: { id: string; resolved: boolean } | null;
}

/** An entry of an issue's `resource_*_events`; `user` is null for a deleted account. */
export interface GitLabResourceEvent {
  user: GitLabUser | null;
  created_at: string;
}
/** What it says of a label or milestone since deleted is null. */

export interface GitLabLabelEvent extends GitLabResourceEvent {
  action: string;
  label: { name: string } | null;
}

export interface GitLabMilestoneEvent extends GitLabResourceEvent {
  action: string;
  milestone: { title: string } | null;
}

export interface GitLabStateEvent extends GitLabResourceEvent {
  state: string;
}
/** What of a change `updateIssue` sets, in GitLab's words. */

export function toIssueInput(path: string, number: number, { title, body, state }: TrackedChange): object {
  return {
    projectPath: path,
    iid: String(number),
    title,
    description: body,
    stateEvent: state && (state === "open" ? "REOPEN" : "CLOSE"),
  };
}
/** An iteration as its field shows and lists it: its cadence, then its title or, as most have none,
 *  its dates. */

export function iterationName(iteration: GitLabIteration): string {
  const dates = [iteration.startDate, iteration.dueDate].map((date) => date?.slice(0, 10) ?? "").join(" – ");
  return `${iteration.iterationCadence.title}: ${iteration.title ?? dates}`;
}
/** A parent as its field shows and lists it: its title and where it is, since an iid is only unique
 *  in its namespace; an epic's is marked as GitLab marks one, `&`. */

export function parentName(parent: GitLabParent): string {
  return `${parent.title} (${parent.namespace.fullPath}${parent.workItemType.name === "Epic" ? "&" : "#"}${parent.iid})`;
}

/** What a duration is counted in, longest first, by GitLab's calendar: 8 hours a day, 5 days a week,
 *  4 weeks a month. */
export const DURATION_UNITS: [unit: string, seconds: number][] = [
  ["mo", 4 * 5 * 8 * 3600],
  ["w", 5 * 8 * 3600],
  ["d", 8 * 3600],
  ["h", 3600],
  ["m", 60],
];
/** A duration in seconds as GitLab words one, "1h 30m"; a minute is its smallest. */

export function durationText(seconds: number): string {
  let rest = Math.abs(seconds);
  const parts: string[] = [];
  for (const [unit, size] of DURATION_UNITS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) {
      parts.push(`${count}${unit}`);
    }
  }
  const text = parts.length > 0 ? parts.join(" ") : "0m";
  return seconds < 0 ? `-${text}` : text;
}
/** The bookings of time a work item has, newest first. */

export function toTimeLogs(logs: GitLabTimelog[]): IssueTimeLog[] {
  return [...logs]
    .sort((a, b) => (b.spentAt ?? "").localeCompare(a.spentAt ?? ""))
    .map((log) => ({
      id: log.id,
      author: log.user.username,
      timeSpent: durationText(log.timeSpent),
      spentAt: log.spentAt?.slice(0, 10),
      summary: log.summary || undefined,
      removable: log.userPermissions.adminTimelog,
    }));
}

/** What `health status` is called, by GitLab's name for it. */
export const HEALTH_STATUSES: NamedId[] = [
  { id: "onTrack", name: "On track" },
  { id: "needsAttention", name: "Needs attention" },
  { id: "atRisk", name: "At risk" },
];

/** The fields of the widget of a work item of `type`, none where it has no such widget, or where what
 *  its field holds (`read`) was not read: a query answers every widget by its type, but those of a
 *  plan the instance lacks without their data. */
export function fromWidget(
  type: string,
  read: keyof GitLabWidget,
  fields: (widget: GitLabWidget) => TrackedField[],
): (item: GitLabWorkItem) => TrackedField[] {
  return (item) => {
    const widget = item.widgets.find((candidate) => candidate.type === type && candidate[read] !== undefined);
    return widget ? fields(widget) : [];
  };
}

/** Where each field comes from, in the order GitLab's own sidebar lists them. */
export const FIELD_SOURCES: ((item: GitLabWorkItem) => TrackedField[])[] = [
  fromWidget("STATUS", "status", (widget) => [
    pickField("status", "Status", widget.status ? [widget.status.name] : [], { shown: "labels" }),
  ]),
  fromWidget("ASSIGNEES", "assignees", (widget) => [
    pickField("assignees", "Assignees", widget.assignees?.nodes.map((user) => user.username) ?? [], { several: true, shown: "people" }),
  ]),
  fromWidget("LABELS", "labels", (widget) => [
    pickField("labels", "Labels", widget.labels?.nodes.map((label) => label.title) ?? [], { several: true, shown: "labels" }),
  ]),
  fromWidget("HIERARCHY", "parent", (widget) => [pickField("parent", "Parent", widget.parent ? [parentName(widget.parent)] : [])]),
  fromWidget("WEIGHT", "weight", (widget) => [
    { id: "weight", name: "Weight", editable: true, kind: "number", value: widget.weight ?? undefined },
  ]),
  fromWidget("MILESTONE", "milestone", (widget) => [pickField("milestone", "Milestone", widget.milestone ? [widget.milestone.title] : [])]),
  fromWidget("ITERATION", "iteration", (widget) => [
    pickField("iteration", "Iteration", widget.iteration ? [iterationName(widget.iteration)] : []),
  ]),
  fromWidget("START_AND_DUE_DATE", "startDate", (widget) => [
    { id: "startDate", name: "Start date", group: "Dates", editable: true, kind: "date", value: widget.startDate ?? undefined },
    { id: "dueDate", name: "Due date", group: "Dates", editable: true, kind: "date", value: widget.dueDate ?? undefined },
  ]),
  fromWidget("HEALTH_STATUS", "healthStatus", (widget) => [
    pickField(
      "health",
      "Health status",
      widget.healthStatus ? [HEALTH_STATUSES.find((status) => status.id === widget.healthStatus)?.name ?? widget.healthStatus] : [],
    ),
  ]),
  fromWidget("TIME_TRACKING", "humanReadableAttributes", (widget) => [
    {
      id: "timeEstimate",
      name: "Estimate",
      group: "Time tracking",
      editable: true,
      kind: "duration",
      value: widget.humanReadableAttributes?.timeEstimate ?? undefined,
    },
    {
      id: "timeSpent",
      name: "Time spent",
      group: "Time tracking",
      editable: true,
      kind: "timelog",
      value: widget.humanReadableAttributes?.totalTimeSpent ?? undefined,
      entries: toTimeLogs(widget.timelogs?.nodes ?? []),
    },
  ]),
  (item) => [{ id: "confidential", name: "Confidential", editable: true, kind: "flag", value: item.confidential }],
  fromWidget("PARTICIPANTS", "participants", (widget) => [
    pickField("participants", "Participants", widget.participants?.nodes.map((user) => user.username) ?? [], {
      several: true,
      shown: "people",
      editable: false,
    }),
  ]),
];
/** The fields a work item has, as the tab lists them: one for what a widget holds, only where the
 *  item's type and the plan give it the widget. */

export function toFields(item: GitLabWorkItem): TrackedField[] {
  return FIELD_SOURCES.flatMap((source) => source(item));
}
/** `avatars` stays empty: a private instance serves a user's uploaded picture only to a signed-in
 *  browser session, never to a token, so a user is shown by the first letters of the login. */

export function toIssue(entry: GitLabIssue): Issue {
  return {
    number: Number(entry.iid),
    title: entry.title,
    url: entry.webUrl,
    open: entry.state === "opened",
    author: entry.author.username,
    assignee: entry.assignees.nodes[0]?.username,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    labels: entry.labels.nodes.map((label) => label.title),
    avatars: {},
  };
}

/** Who wrote a note; a deleted account is ghost. */
export function authorOf(note: GitLabNote): string {
  return note.author?.username ?? "ghost";
}
/** The comments among an issue's notes. */

export function toNotes(entries: GitLabNote[]): TrackedNote[] {
  return entries
    .filter((entry) => !entry.system)
    .map((entry) => ({ id: entry.id, author: authorOf(entry), createdAt: entry.createdAt, body: entry.body, internal: entry.internal }));
}
/** A merge request's discussions on its changes, from its notes: every comment of a discussion one of
 *  whose notes was written on them, what GitLab noted itself left out. */

export function toReviewThreads(entries: GitLabNote[]): ReviewThread[] {
  const threads = new Map<string, ReviewThread>();
  for (const { position, discussion } of entries) {
    if (position && discussion && !threads.has(discussion.id)) {
      const line = position.newLine ?? position.oldLine ?? undefined;
      threads.set(discussion.id, { id: discussion.id, path: position.filePath, line, resolved: discussion.resolved, comments: [] });
    }
  }
  for (const entry of entries) {
    const thread = entry.discussion ? threads.get(entry.discussion.id) : undefined;
    if (thread && !entry.system) {
      thread.comments.push(...toNotes([entry]));
    }
  }
  return [...threads.values()].filter((thread) => thread.comments.length > 0);
}

export const ESCAPED: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** A title change has no record of its own and no field saying so, so its system note's words are
 *  matched: rendered, its titles escaped and their changes in spans, or Markdown with inline diff marks. */
export const TITLE_NOTES: { note: RegExp; title: (marked: string) => string }[] = [
  {
    note: /^<p>changed title from <code class="idiff">(.*)<\/code> to <code class="idiff">(.*)<\/code><\/p>$/s,
    title: (html) => html.replace(/<\/?span[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ESCAPED[entity]),
  },
  {
    note: /^changed title from \*\*(.*)\*\* to \*\*(.*)\*\*$/s,
    title: (markdown) => markdown.replace(/\{[-+]|[-+]\}/g, ""),
  },
];

/** What a system note says happened, in its own words where it says no more than that. */
export function fromSystemNote(body: string): { kind: "renamed"; from: string; to: string } | { kind: "text"; text: string } {
  for (const { note, title } of TITLE_NOTES) {
    const match = note.exec(body);
    if (match) {
      return { kind: "renamed", from: title(match[1]), to: title(match[2]) };
    }
  }
  return { kind: "text", text: body };
}
/** An issue's events, from where GitLab keeps each kind: a change of labels, state or milestone has
 *  its own record, and what else it did only its system notes tell, in its own words. */

export function toEvents(
  notes: GitLabNote[],
  labels: GitLabLabelEvent[],
  states: GitLabStateEvent[],
  milestones: GitLabMilestoneEvent[],
): TrackedEvent[] {
  const base = (entry: GitLabResourceEvent) => ({ actor: entry.user?.username ?? "ghost", createdAt: entry.created_at });
  const events: TrackedEvent[] = [];
  for (const note of notes) {
    if (note.system) {
      events.push({ actor: authorOf(note), createdAt: note.createdAt, ...fromSystemNote(note.body) });
    }
  }
  for (const entry of labels) {
    if (entry.label) {
      events.push({ ...base(entry), kind: entry.action === "remove" ? "unlabeled" : "labeled", label: entry.label.name });
    }
  }
  for (const entry of states) {
    events.push({ ...base(entry), kind: entry.state === "merged" ? "merged" : entry.state === "closed" ? "closed" : "reopened" });
  }
  for (const entry of milestones) {
    if (entry.milestone) {
      events.push({ ...base(entry), kind: entry.action === "remove" ? "demilestoned" : "milestoned", milestone: entry.milestone.title });
    }
  }
  return events;
}
/** An open merge request as `changeRequests.find` reads it; `sourceProject` null for one the token
 *  cannot read. */

export interface GitLabMergeRequest {
  iid: string;
  webUrl: string;
  sourceProject: { fullPath: string } | null;
}
/** The one from `path`'s own branch among those of a branch of that name, a fork's left out. */

export function ownMergeRequest(found: GitLabMergeRequest[], path: string): ChangeRequest | undefined {
  const own = found.find((entry) => fromOwnProject(entry, path));
  return own && { number: Number(own.iid), url: own.webUrl };
}
/** A merge request as a row reads it (`MERGE_REQUEST_ROW`); `sourceProject` null for one the token
 *  cannot read. */

export interface GitLabMergeRequestRow extends GitLabIssue {
  draft: boolean;
  sourceProject: { fullPath: string } | null;
  diffHeadSha: string | null;
  headPipeline: { status: string } | null;
}
/** A job of a merge request's head pipeline (`MERGE_REQUEST_QUERY`). */

export interface GitLabJob {
  name: string;
  status: string;
  stage: { name: string } | null;
  detailedStatus: { detailsPath: string | null } | null;
}
/** A merge request as its tab reads it (`MERGE_REQUEST_QUERY`). */

export interface GitLabMergeRequestDetail extends GitLabMergeRequestRow {
  description: string | null;
  sourceBranch: string;
  targetBranch: string;
  conflicts: boolean;
  mergedAt: string | null;
  mergeUser: GitLabUser | null;
  autoMergeEnabled: boolean;
  availableAutoMergeStrategies: string[] | null;
  commitCount: number | null;
  diffStatsSummary: { additions: number; deletions: number } | null;
  headPipeline: { status: string; path: string | null; jobs: { nodes: GitLabJob[] } | null } | null;
  detailedMergeStatus: string | null;
  approvalsLeft: number | null;
  reviewers: { nodes: GitLabUser[] };
  approvedBy: { nodes: GitLabUser[] } | null;
  participants: { nodes: GitLabUser[] } | null;
  notes: GraphqlPage<GitLabNote>;
}
/** How a pipeline stands, in TET's words; undefined for one that neither runs nor ended passed or failed. */

export function pipelineChecks(pipeline: { status: string } | null | undefined): ChecksState | undefined {
  switch (pipeline?.status ?? "") {
    case "SUCCESS":
      return "passed";
    case "FAILED":
      return "failed";
    case "CREATED":
    case "WAITING_FOR_RESOURCE":
    case "PREPARING":
    case "PENDING":
    case "RUNNING":
    case "SCHEDULED":
    case "WAITING_FOR_CALLBACK":
    case "CANCELING":
      return "running";
    default:
      return undefined;
  }
}

/** How a job stands; one that is not run (manual, skipped, canceled) does not count. */
export const JOB_STATES: Record<string, ChangeRequestCheck["state"] | undefined> = {
  SUCCESS: "passed",
  FAILED: "failed",
  MANUAL: "skipped",
  SKIPPED: "skipped",
  CANCELED: "skipped",
};
/** The jobs of a pipeline as checks, one with a state of none of those of `JOB_STATES` still to run. */

export function jobChecksOf(host: string, jobs: GitLabJob[]): ChangeRequestCheck[] {
  return jobs.map((job) => ({
    name: job.name,
    state: JOB_STATES[job.status] ?? "running",
    detail: job.stage?.name,
    url: job.detailedStatus?.detailsPath ? `https://${host}${job.detailedStatus.detailsPath}` : undefined,
  }));
}

/** What keeps a merge request from merging, per `detailedMergeStatus`, beside what its checks, approvals and
 *  conflicts say themselves; the statuses left out are those. */
export const MERGE_BLOCKERS: Record<string, string | undefined> = {
  BLOCKED_STATUS: "Blocked by another merge request",
  BROKEN_STATUS: "Cannot be merged",
  COMMITS_STATUS: "Commit rules not met",
  EXTERNAL_STATUS_CHECKS: "External status checks pending",
  JIRA_ASSOCIATION: "Jira issue missing",
  NEED_REBASE: "Branch needs a rebase",
  POLICIES_DENIED: "Denied by a merge request policy",
  REQUESTED_CHANGES: "Changes requested",
  SECURITY_POLICY_VIOLATIONS: "Security policy violated",
  STATUS_CHECKS_MUST_PASS: "Status checks must pass",
};
/** Who approved, then who is asked for a review and has not; GitLab tells of no request for changes per person. */

export function reviewersOf(found: Pick<GitLabMergeRequestDetail, "approvedBy" | "reviewers">): ChangeRequestReviewer[] {
  const approved = (found.approvedBy?.nodes ?? []).map((user) => user.username);
  return [
    ...approved.map((login): ChangeRequestReviewer => ({ login, state: "approved" })),
    ...found.reviewers.nodes
      .filter((user) => !approved.includes(user.username))
      .map((user): ChangeRequestReviewer => ({ login: user.username, state: "requested" })),
  ];
}

export function blockersOf(detailedMergeStatus: string | null): string[] {
  const blocker = MERGE_BLOCKERS[detailedMergeStatus ?? ""];
  return blocker === undefined ? [] : [blocker];
}
/** Whether a merge request is from a branch of `path` itself, not of a fork. */

export function fromOwnProject(entry: { sourceProject: { fullPath: string } | null }, path: string): boolean {
  return entry.sourceProject?.fullPath.toLowerCase() === path.toLowerCase();
}

export const MERGE_REQUEST_STATES: Record<string, ChangeRequestState | undefined> = { opened: "open", merged: "merged", closed: "closed" };

export function toChangeRequestRow(entry: GitLabMergeRequestRow): ChangeRequestRow {
  return {
    ...toIssue(entry),
    state: MERGE_REQUEST_STATES[entry.state] ?? "closed",
    draft: entry.draft,
    checks: pipelineChecks(entry.headPipeline),
    headSha: entry.diffHeadSha ?? undefined,
  };
}
/** The fields a merge request has (`changeRequestFields`), in the order of GitLab's own sidebar. */

export function toMergeRequestFields(found: GitLabMergeRequestDetail, closes: { iid: number; title: string }[]): TrackedField[] {
  return changeRequestFields({
    reviewers: found.reviewers.nodes.map((user) => user.username),
    assignees: found.assignees.nodes.map((user) => user.username),
    labels: found.labels.nodes.map((label) => label.title),
    linkedIssues: closes.map((issue) => linkedIssueName(issue.iid, issue.title)),
    participants: (found.participants?.nodes ?? []).map((user) => user.username),
  });
}
