import { ownValue } from "../../shared/own-value";
import {
  isTimeRemoval,
  linkedIssueName,
  type ChangeRequest,
  type ChangeRequestFilter,
  type ChangeRequestCheck,
  type ChangeRequestReviewer,
  type ChangeRequestRow,
  type ChangeRequestState,
  type ChecksState,
  type Issue,
  type IssueChange,
  type IssueEvent,
  type IssueField,
  type IssueFilter,
  type IssueNote,
  type IssueTimeLog,
  type RemoteRepository,
  type ReviewThread,
} from "../../shared/types/providers";
import {
  allNodes,
  changeRequestFields,
  checksText,
  fetchImageOk,
  fetchOk,
  fetchUploadOk,
  fieldMethods,
  firstNodes,
  getPaged,
  numberOf,
  pickField,
  pickHandler,
  reached,
  sendDelete,
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

// GraphQL for all that it answers in structure and out of experiment. REST for the rest: an issue's
// label, state and milestone events, which GraphQL words only as text; deleting an issue and uploading
// a file, whose mutations are experiments; reading an upload's bytes, which GraphQL cannot carry; and
// approving a merge request, which it has no mutation for.

function apiBase(host: string): string {
  return `https://${host}/api/v4`;
}

function headers(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token };
}

function graphqlUrl(host: string): string {
  return `https://${host}/api/graphql`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function sender(host: string, token: string): GraphqlSend {
  return (query, variables) => sendGraphql(graphqlUrl(host), bearer(token), query, variables);
}

/** The issue a project's answer holds, both reached (`reached`). */
function reachedIssue<T>(project: { issue: T | null } | null, path: string, number: number): T {
  return reached(reached(project, path).issue, `Issue #${number}`);
}

/** One mutation. GitLab words what it refused in the payload's `errors`, so every one asks for them. */
function mutate<T>(send: GraphqlSend, write: Write, selection = ""): Promise<T> {
  return sendMutation<T>(send, write, `${selection} errors`);
}

interface GitLabUser {
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

const ISSUE_ROW = `iid title webUrl state createdAt updatedAt
  author { username }
  assignees(first: 100) { nodes { username } }
  labels(first: 100) { nodes { title } }`;

const NOTE_FIELDS = "id system internal body createdAt author { username }";

const NOTE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { ${NOTE_FIELDS} }`;

const MERGE_REQUEST_NOTE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { ${NOTE_FIELDS} position { filePath newLine oldLine } discussion { id resolved } }`;

/** What a filter asks for (`issuesVariables`), as the queries of a list and of its latest change take it. */
const FILTER_VARIABLES =
  "$state: IssuableState, $authorUsername: String, $assigneeUsernames: [String!], $labelName: [String], $search: String, $in: [IssuableSearchableField!]";
const FILTER_ARGUMENTS =
  "state: $state, authorUsername: $authorUsername, assigneeUsernames: $assigneeUsernames, labelName: $labelName, search: $search, in: $in";

const ISSUES_QUERY = `query($path: ID!, $first: Int!, $cursor: String, ${FILTER_VARIABLES}) {
  project(fullPath: $path) {
    issues(first: $first, after: $cursor, sort: created_desc, ${FILTER_ARGUMENTS}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ROW} }
    }
  }
}`;

const LATEST_QUERY = `query($path: ID!, ${FILTER_VARIABLES}) {
  project(fullPath: $path) {
    issues(first: 1, sort: updated_desc, ${FILTER_ARGUMENTS}) {
      count
      nodes { updatedAt }
    }
  }
}`;

/** The widgets of a work item every GitLab has, by the fields each holds; `type` tells which one a
 *  node is. */
const WIDGETS = `confidential
  widgets {
    type
    ... on WorkItemWidgetAssignees { assignees { nodes { username } } }
    ... on WorkItemWidgetLabels { labels { nodes { title } } }
    ... on WorkItemWidgetHierarchy { parent { iid title workItemType { name } namespace { fullPath } } }
    ... on WorkItemWidgetMilestone { milestone { title } }
    ... on WorkItemWidgetStartAndDueDate { startDate dueDate }
    ... on WorkItemWidgetTimeTracking {
      humanReadableAttributes { timeEstimate totalTimeSpent }
      timelogs(first: 100) { nodes { id timeSpent spentAt summary user { username } userPermissions { adminTimelog } } }
    }
    ... on WorkItemWidgetParticipants { participants { nodes { username } } }
  }`;

/** The widgets only some plans and versions have: a schema without one of these types refuses the
 *  whole query, so they are asked for apart (`readExtraWidgets`). */
const EXTRA_WIDGETS = `widgets {
    type
    ... on WorkItemWidgetStatus { status { name } }
    ... on WorkItemWidgetWeight { weight }
    ... on WorkItemWidgetIteration { iteration { id title startDate dueDate iterationCadence { title } } }
    ... on WorkItemWidgetHealthStatus { healthStatus }
  }`;

const ISSUE_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    issue(iid: $iid) {
      ${ISSUE_ROW}
      description
      notes(first: 100) { ${NOTE_PAGE} }
    }
    workItems(iids: [$iid]) { nodes { ${WIDGETS} } }
  }
}`;

const EXTRA_WIDGETS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { workItems(iids: [$iid]) { nodes { ${EXTRA_WIDGETS} } } }
}`;

const NOTES_QUERY = `query($path: ID!, $iid: String!, $cursor: String) {
  project(fullPath: $path) { issue(iid: $iid) { notes(first: 100, after: $cursor) { ${NOTE_PAGE} } } }
}`;

/** An entry of an issue's `resource_*_events`; `user` is null for a deleted account. */
interface GitLabResourceEvent {
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
export function toIssueInput(path: string, number: number, { title, body, state }: IssueChange): object {
  return {
    projectPath: path,
    iid: String(number),
    title,
    description: body,
    stateEvent: state && (state === "open" ? "REOPEN" : "CLOSE"),
  };
}

/** Every node of one of a project's connections, up to the cap; `args` beyond the paging. */
function projectNodes<T>(send: GraphqlSend, path: string, connection: string, selection: string, args: string): Promise<T[]> {
  const query = `query($path: ID!, $cursor: String) {
    project(fullPath: $path) {
      ${connection}(first: 100, after: $cursor, ${args}) {
        pageInfo { hasNextPage endCursor }
        nodes { ${selection} }
      }
    }
  }`;
  return allNodes<T>(send, query, { path }, (data) => {
    const { project } = data as { project: Record<string, GraphqlPage<T>> | null };
    return reached(project, path)[connection];
  });
}

/** A project's labels by name, with their ids, those of its groups included. */
function allLabels(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return projectNodes(send, path, "labels", "id name: title", "includeAncestorGroups: true");
}

/** Who can be assigned, by login, with their ids. */
async function allPeople(send: GraphqlSend, path: string): Promise<NamedId[]> {
  // relations: the default leaves out who reaches the project through a group shared with it.
  const members = await projectNodes<{ user: NamedId | null }>(
    send,
    path,
    "projectMembers",
    "user { id name: username }",
    "relations: [DIRECT, INHERITED, INVITED_GROUPS, SHARED_INTO_ANCESTORS]",
  );
  return members.flatMap((member) => (member.user ? [member.user] : []));
}

/** The milestones a project can set, those of its groups included, with their ids. */
function allMilestones(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return projectNodes(send, path, "milestones", "id name: title", "state: active, includeAncestors: true");
}

/** The iterations a project can set, those of its groups included, with their ids. */
async function allIterations(send: GraphqlSend, path: string): Promise<NamedId[]> {
  const iterations = await projectNodes<GitLabIteration>(
    send,
    path,
    "iterations",
    "id title startDate dueDate iterationCadence { title }",
    "state: opened, includeAncestors: true",
  );
  return iterations.map((iteration) => ({ id: iteration.id, name: iterationName(iteration) }));
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
const DURATION_UNITS: [unit: string, seconds: number][] = [
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
const HEALTH_STATUSES: NamedId[] = [
  { id: "onTrack", name: "On track" },
  { id: "needsAttention", name: "Needs attention" },
  { id: "atRisk", name: "At risk" },
];

/** The fields of the widget of a work item of `type`, none where it has no such widget, or where what
 *  its field holds (`read`) was not read: a query answers every widget by its type, but those of a
 *  plan the instance lacks without their data. */
function fromWidget(
  type: string,
  read: keyof GitLabWidget,
  fields: (widget: GitLabWidget) => IssueField[],
): (item: GitLabWorkItem) => IssueField[] {
  return (item) => {
    const widget = item.widgets.find((candidate) => candidate.type === type && candidate[read] !== undefined);
    return widget ? fields(widget) : [];
  };
}

/** Where each field comes from, in the order GitLab's own sidebar lists them. */
const FIELD_SOURCES: ((item: GitLabWorkItem) => IssueField[])[] = [
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
export function toFields(item: GitLabWorkItem): IssueField[] {
  return FIELD_SOURCES.flatMap((source) => source(item));
}

/** What a change of a work item's field needs of it: its id, and the labels it carries, whose ids a
 *  new set is told apart from. */
interface Target {
  id: string;
  labels: NamedId[];
}

type Context = FieldContext<Target>;

/** The work item an issue is, as far as `selection` reads it. */
async function readWorkItem<T>(send: GraphqlSend, path: string, number: number, selection: string): Promise<T> {
  const query = `query($path: ID!, $iid: String!) {
    project(fullPath: $path) { workItems(iids: [$iid]) { nodes { ${selection} } } }
  }`;
  const { project } = (await send(query, { path, iid: String(number) })) as { project: { workItems: { nodes: T[] } } | null };
  return reached(reached(project, path).workItems.nodes[0], `Issue #${number}`);
}

/** What a work item's type allows of one widget: its statuses, the types of its parent. */
interface WidgetDefinition {
  allowedStatuses?: NamedId[];
  allowedParentTypes?: { nodes: { name: string }[] };
}

async function definitionOf(context: Context, selection: string): Promise<WidgetDefinition[]> {
  const item = await readWorkItem<{ workItemType: { widgetDefinitions: WidgetDefinition[] } }>(
    context.send,
    context.path,
    context.number,
    `workItemType { widgetDefinitions { type ${selection} } }`,
  );
  return item.workItemType.widgetDefinitions;
}

/** The work items of a namespace that are one of `types`, open and not the item itself. */
async function openWorkItems(context: Context, namespace: string, types: string[], ancestors: boolean): Promise<NamedId[]> {
  const query = `query($path: ID!, $types: [IssueType!], $ancestors: Boolean, $cursor: String) {
    namespace(fullPath: $path) {
      workItems(first: 100, after: $cursor, types: $types, state: opened, includeAncestors: $ancestors) {
        pageInfo { hasNextPage endCursor }
        nodes { id iid title workItemType { name } namespace { fullPath } }
      }
    }
  }`;
  const entries = await allNodes<GitLabParent & { id: string }>(context.send, query, { path: namespace, types, ancestors }, (data) => {
    const { namespace: found } = data as { namespace: { workItems: GraphqlPage<GitLabParent & { id: string }> } | null };
    return found?.workItems ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  });
  const itself = (entry: GitLabParent) => entry.iid === String(context.number) && entry.namespace.fullPath === context.path;
  return entries.filter((entry) => !itself(entry)).map((entry) => ({ id: entry.id, name: parentName(entry) }));
}

/** What `workItemUpdate` takes to set one of a work item's widgets. */
function workItemUpdate(target: Target, input: object): Write {
  return { mutation: "workItemUpdate", inputType: "WorkItemUpdateInput", input: { id: target.id, ...input } };
}

/** The fields of GitLab, by the id `toFields` gives them. */
export const FIELD_HANDLERS: Record<string, FieldHandler<Target>> = {
  status: pickHandler(
    {
      what: "status",
      choices: async (context) => {
        const definitions = await definitionOf(context, "... on WorkItemWidgetDefinitionStatus { allowedStatuses { id name } }");
        return definitions.flatMap((definition) => definition.allowedStatuses ?? []);
      },
    },
    (target, [status]) => {
      if (status === undefined) {
        throw new Error("A status cannot be taken off");
      }
      return workItemUpdate(target, { statusWidget: { status } });
    },
  ),
  assignees: pickHandler({ what: "person to assign", choices: ({ send, path }) => allPeople(send, path) }, (target, assigneeIds) =>
    workItemUpdate(target, { assigneesWidget: { assigneeIds } }),
  ),
  labels: pickHandler(
    {
      what: "label",
      // What the item carries stays offered, as a group's labels may be left out of what the project lists.
      choices: async ({ send, path, target }) => {
        const [listed, { labels }] = await Promise.all([allLabels(send, path), target()]);
        return [...listed, ...labels.filter((label) => !listed.some((entry) => entry.id === label.id))];
      },
    },
    (target, ids) =>
      workItemUpdate(target, {
        labelsWidget: {
          addLabelIds: ids.filter((id) => !target.labels.some((label) => label.id === id)),
          removeLabelIds: target.labels.map((label) => label.id).filter((id) => !ids.includes(id)),
        },
      }),
  ),
  parent: pickHandler(
    {
      what: "parent",
      // An epic belongs to a group, whose own and ancestors' are listed from its path; the other types
      // are work items of the project.
      choices: async (context) => {
        const definitions = await definitionOf(
          context,
          "... on WorkItemWidgetDefinitionHierarchy { allowedParentTypes { nodes { name } } }",
        );
        const types = definitions.flatMap(
          (definition) => definition.allowedParentTypes?.nodes.map((type) => type.name.toUpperCase().replaceAll(" ", "_")) ?? [],
        );
        const others = types.filter((type) => type !== "EPIC");
        const [inProject, inGroup] = await Promise.all([
          others.length > 0 ? openWorkItems(context, context.path, others, false) : [],
          types.includes("EPIC") ? openWorkItems(context, context.path.slice(0, context.path.lastIndexOf("/")), ["EPIC"], true) : [],
        ]);
        return [...inProject, ...inGroup];
      },
    },
    (target, [parentId]) => workItemUpdate(target, { hierarchyWidget: { parentId: parentId ?? null } }),
  ),
  milestone: pickHandler({ what: "milestone", choices: ({ send, path }) => allMilestones(send, path) }, (target, [milestoneId]) =>
    workItemUpdate(target, { milestoneWidget: { milestoneId: milestoneId ?? null } }),
  ),
  iteration: pickHandler({ what: "iteration", choices: ({ send, path }) => allIterations(send, path) }, (target, [iterationId]) =>
    workItemUpdate(target, { iterationWidget: { iterationId: iterationId ?? null } }),
  ),
  health: pickHandler({ what: "health status", choices: () => Promise.resolve(HEALTH_STATUSES) }, (target, [healthStatus]) =>
    workItemUpdate(target, { healthStatusWidget: { healthStatus: healthStatus ?? null } }),
  ),
  weight: valueHandler((target, value) => workItemUpdate(target, { weightWidget: { weight: numberOf(value, true) } })),
  startDate: valueHandler((target, value) => workItemUpdate(target, { startAndDueDateWidget: { startDate: textOf(value) } })),
  dueDate: valueHandler((target, value) => workItemUpdate(target, { startAndDueDateWidget: { dueDate: textOf(value) } })),
  // "0" is how GitLab takes an estimate off.
  timeEstimate: valueHandler((target, value) => workItemUpdate(target, { timeTrackingWidget: { timeEstimate: textOf(value) ?? "0" } })),
  timeSpent: valueHandler((target, value) => {
    // `workItemUpdate` has no way to take a booking back: it has a mutation of its own.
    if (isTimeRemoval(value)) {
      return { mutation: "timelogDelete", inputType: "TimelogDeleteInput", input: { id: value.remove } };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || !("timeSpent" in value)) {
      throw new Error("Time spent is added as an entry");
    }
    const { timeSpent, spentAt, summary } = value;
    // What was left empty is left out, as GitLab takes now and no summary then.
    return workItemUpdate(target, {
      timeTrackingWidget: { timelog: { timeSpent, spentAt: spentAt || undefined, summary: summary || undefined } },
    });
  }),
  confidential: valueHandler((target, value) => {
    if (typeof value !== "boolean") {
      throw new Error("It is on or off");
    }
    return workItemUpdate(target, { confidential: value });
  }),
};

function fieldHandlerOf(fieldId: string): FieldHandler<Target> {
  const handler = ownValue(FIELD_HANDLERS, fieldId);
  if (!handler) {
    throw new Error(`An issue of GitLab has no field ${fieldId}`);
  }
  return handler;
}

/** The work item an issue is, with what a change of its fields needs of it. */
async function readTarget(send: GraphqlSend, path: string, number: number): Promise<Target> {
  const item = await readWorkItem<{ id: string; widgets: { type: string; labels?: { nodes: { id: string; title: string }[] } }[] }>(
    send,
    path,
    number,
    "id widgets { type ... on WorkItemWidgetLabels { labels { nodes { id title } } } }",
  );
  const labels = item.widgets.find((widget) => widget.type === "LABELS")?.labels?.nodes ?? [];
  return { id: item.id, labels: labels.map((label) => ({ id: label.id, name: label.title })) };
}

/** The widgets only some plans have, which an instance without them does not answer: the item shows
 *  without their fields, as it has none there. */
async function readExtraWidgets(send: GraphqlSend, path: string, iid: string): Promise<GitLabWidget[]> {
  const data = (await send(EXTRA_WIDGETS_QUERY, { path, iid }).catch(() => undefined)) as
    { project: { workItems: { nodes: { widgets: GitLabWidget[] }[] } } | null } | undefined;
  return data?.project?.workItems.nodes[0]?.widgets ?? [];
}

/** A project's API path takes its whole path as one segment. */
function projectUrl(host: string, path: string): string {
  return `${apiBase(host)}/projects/${encodeURIComponent(path)}`;
}

/** The secret and file name of an upload in an issue's text, as the uploads API takes them: linked
 *  relative to the project, or whole on this host, the only one its token goes to. */
export function uploadOf(host: string, source: string): { secret: string; file: string } | undefined {
  let pathname = source;
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    const url = URL.parse(source);
    if (url?.protocol !== "https:" || url.host.toLowerCase() !== host.toLowerCase()) {
      return undefined;
    }
    pathname = url.pathname;
  }
  const match = /(?:^|\/)uploads\/([0-9a-f]{16,})\/([^/?#]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  try {
    return { secret: match[1], file: encodeURIComponent(decodeURIComponent(match[2])) };
  } catch {
    return undefined;
  }
}

/** What a filter asks for, in the words of `FILTER_VARIABLES`. */
export function issuesVariables(path: string, filter: IssueFilter): Record<string, unknown> {
  return {
    path,
    state: filter.state && (filter.state === "open" ? "opened" : "closed"),
    authorUsername: filter.author,
    assigneeUsernames: filter.assignee ? [filter.assignee] : undefined,
    labelName: filter.labels.length > 0 ? filter.labels : undefined,
    ...titleSearch(filter.text),
  };
}

/** A filter's text in the words of `FILTER_VARIABLES` and `MERGE_REQUEST_FILTER_VARIABLES`, searched in
 *  titles alone; neither is sent without text, as `in` is refused without a `search`. */
function titleSearch(text: string | undefined): Record<string, unknown> {
  return text ? { search: text, in: ["TITLE"] } : {};
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
function authorOf(note: GitLabNote): string {
  return note.author?.username ?? "ghost";
}

/** The comments among an issue's notes. */
export function toNotes(entries: GitLabNote[]): IssueNote[] {
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

const ESCAPED: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** A title change has no record of its own and no field saying so, so its system note's words are
 *  matched: rendered, its titles escaped and their changes in spans, or Markdown with inline diff marks. */
const TITLE_NOTES: { note: RegExp; title: (marked: string) => string }[] = [
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
function fromSystemNote(body: string): { kind: "renamed"; from: string; to: string } | { kind: "text"; text: string } {
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
): IssueEvent[] {
  const base = (entry: GitLabResourceEvent) => ({ actor: entry.user?.username ?? "ghost", createdAt: entry.created_at });
  const events: IssueEvent[] = [];
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

/** An open merge request as `findChangeRequest` reads it; `sourceProject` null for one the token
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

const MERGE_REQUEST_ROW = `${ISSUE_ROW} draft sourceProject { fullPath } diffHeadSha headPipeline { status }`;

/** What a filter asks for (`mergeRequestsVariables`), as the queries of a list and of its latest change take it. */
const MERGE_REQUEST_FILTER_VARIABLES =
  "$state: MergeRequestState, $authorUsername: String, $assigneeUsername: String, $reviewerUsername: String, $labels: [String!], $search: String, $in: [IssuableSearchableField!]";
const MERGE_REQUEST_FILTER_ARGUMENTS =
  "state: $state, authorUsername: $authorUsername, assigneeUsername: $assigneeUsername, reviewerUsername: $reviewerUsername, labels: $labels, search: $search, in: $in";

const MERGE_REQUESTS_QUERY = `query($path: ID!, $first: Int!, $cursor: String, ${MERGE_REQUEST_FILTER_VARIABLES}) {
  project(fullPath: $path) {
    mergeRequests(first: $first, after: $cursor, sort: CREATED_DESC, ${MERGE_REQUEST_FILTER_ARGUMENTS}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${MERGE_REQUEST_ROW} }
    }
  }
}`;

const MERGE_REQUESTS_LATEST_QUERY = `query($path: ID!, ${MERGE_REQUEST_FILTER_VARIABLES}) {
  project(fullPath: $path) {
    mergeRequests(first: 100, sort: UPDATED_DESC, ${MERGE_REQUEST_FILTER_ARGUMENTS}) {
      count
      nodes { iid updatedAt sourceProject { fullPath } headPipeline { status } }
    }
  }
}`;

const MERGE_REQUEST_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      ${MERGE_REQUEST_ROW}
      description sourceBranch targetBranch conflicts mergedAt autoMergeEnabled availableAutoMergeStrategies commitCount
      detailedMergeStatus approvalsLeft
      mergeUser { username }
      diffStatsSummary { additions deletions }
      headPipeline { status path jobs(first: 100) { nodes { name status stage { name } detailedStatus { detailsPath } } } }
      reviewers { nodes { username } }
      approvedBy { nodes { username } }
      participants { nodes { username } }
      notes(first: 100) { ${MERGE_REQUEST_NOTE_PAGE} }
    }
  }
}`;

const MERGE_REQUEST_NOTES_QUERY = `query($path: ID!, $iid: String!, $cursor: String) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { notes(first: 100, after: $cursor) { ${MERGE_REQUEST_NOTE_PAGE} } } }
}`;

/** What a filter asks for, in the words of `MERGE_REQUEST_FILTER_VARIABLES`. */
export function mergeRequestsVariables(path: string, filter: ChangeRequestFilter): Record<string, unknown> {
  return {
    path,
    state: filter.state && (filter.state === "open" ? "opened" : filter.state),
    authorUsername: filter.author,
    assigneeUsername: filter.assignee,
    reviewerUsername: filter.reviewer,
    labels: filter.labels.length > 0 ? filter.labels : undefined,
    ...titleSearch(filter.text),
  };
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
const JOB_STATES: Record<string, ChangeRequestCheck["state"] | undefined> = {
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
const MERGE_BLOCKERS: Record<string, string | undefined> = {
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
function fromOwnProject(entry: { sourceProject: { fullPath: string } | null }, path: string): boolean {
  return entry.sourceProject?.fullPath.toLowerCase() === path.toLowerCase();
}

const MERGE_REQUEST_STATES: Record<string, ChangeRequestState | undefined> = { opened: "open", merged: "merged", closed: "closed" };

export function toChangeRequestRow(entry: GitLabMergeRequestRow): ChangeRequestRow {
  return {
    ...toIssue(entry),
    state: MERGE_REQUEST_STATES[entry.state] ?? "closed",
    draft: entry.draft,
    checks: pipelineChecks(entry.headPipeline),
    headSha: entry.diffHeadSha ?? undefined,
  };
}

/** What a change of a merge request's field needs of it: where it is, as its mutations name it. */
interface MergeRequestTarget {
  projectPath: string;
  iid: string;
}

/** People by login alone: a merge request's mutations name them so. */
async function peopleByLogin(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return (await allPeople(send, path)).map((person) => ({ id: person.name, name: person.name }));
}

/** The fields of a merge request, by the id `toMergeRequestFields` gives them. */
export const MERGE_REQUEST_FIELD_HANDLERS: Record<string, FieldHandler<MergeRequestTarget>> = {
  reviewers: pickHandler({ what: "reviewer", choices: ({ send, path }) => peopleByLogin(send, path) }, (target, reviewerUsernames) => ({
    mutation: "mergeRequestSetReviewers",
    inputType: "MergeRequestSetReviewersInput",
    input: { ...target, reviewerUsernames, operationMode: "REPLACE" },
  })),
  assignees: pickHandler(
    { what: "person to assign", choices: ({ send, path }) => peopleByLogin(send, path) },
    (target, assigneeUsernames) => ({
      mutation: "mergeRequestSetAssignees",
      inputType: "MergeRequestSetAssigneesInput",
      input: { ...target, assigneeUsernames, operationMode: "REPLACE" },
    }),
  ),
  labels: pickHandler({ what: "label", choices: ({ send, path }) => allLabels(send, path) }, (target, labelIds) => ({
    mutation: "mergeRequestSetLabels",
    inputType: "MergeRequestSetLabelsInput",
    input: { ...target, labelIds, operationMode: "REPLACE" },
  })),
};

const mergeRequestFields = fieldMethods<MergeRequestTarget>({
  graphql: sender,
  handlerOf: (_send, _path, fieldId) => {
    const handler = ownValue(MERGE_REQUEST_FIELD_HANDLERS, fieldId);
    if (!handler) {
      throw new Error(`A merge request of GitLab has no field ${fieldId}`);
    }
    return handler;
  },
  readTarget: (_send, path, number) => Promise.resolve({ projectPath: path, iid: String(number) }),
  mutate,
});

/** The fields a merge request has (`changeRequestFields`), in the order of GitLab's own sidebar. */
export function toMergeRequestFields(found: GitLabMergeRequestDetail, closes: { iid: number; title: string }[]): IssueField[] {
  return changeRequestFields({
    reviewers: found.reviewers.nodes.map((user) => user.username),
    assignees: found.assignees.nodes.map((user) => user.username),
    labels: found.labels.nodes.map((label) => label.title),
    linkedIssues: closes.map((issue) => linkedIssueName(issue.iid, issue.title)),
    participants: (found.participants?.nodes ?? []).map((user) => user.username),
  });
}

/** A merge request by its number, as far as `selection` reads it (`readWorkItem`'s for one). */
async function readMergeRequest<T>(send: GraphqlSend, path: string, number: number, selection: string): Promise<T> {
  const query = `query($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) { ${selection} } } }`;
  const { project } = (await send(query, { path, iid: String(number) })) as { project: { mergeRequest: T | null } | null };
  return reached(reached(project, path).mergeRequest, `Merge request !${number}`);
}

export const gitlab: GitProvider = {
  /** glab's names, which scripts for GitLab take too; glab takes the host as a url. */
  tokenEnv: (host, token) => ({ GITLAB_TOKEN: token, GITLAB_HOST: `https://${host}` }),

  async validate(host, token) {
    const data = (await sender(host, token)("{ currentUser { username } }", {})) as { currentUser: { username?: unknown } | null };
    const username = data.currentUser?.username;
    if (typeof username !== "string" || username === "") {
      throw new Error("The API answered without a username");
    }
    return username;
  },

  async listRepositories(host, token) {
    // membership: without it a self-hosted instance answers with everything it can see.
    const query = `query($cursor: String) {
      projects(membership: true, first: 100, after: $cursor, sort: "latest_activity_desc") {
        pageInfo { hasNextPage endCursor }
        nodes { fullPath path httpUrlToRepo }
      }
    }`;
    const entries = await allNodes<{ fullPath: string; path: string; httpUrlToRepo: string }>(
      sender(host, token),
      query,
      {},
      (data) => (data as { projects: GraphqlPage<{ fullPath: string; path: string; httpUrlToRepo: string }> }).projects,
    );
    return entries.map((entry): RemoteRepository => ({
      fullName: entry.fullPath,
      name: entry.path,
      cloneUrl: entry.httpUrlToRepo,
    }));
  },

  async listIssues({ host, token, path }, filter, limit, after) {
    const { items, ...rest } = await firstNodes<GitLabIssue>(
      sender(host, token),
      ISSUES_QUERY,
      issuesVariables(path, filter),
      (data) => {
        const { project } = data as { project: { issues: GraphqlPage<GitLabIssue> } | null };
        return reached(project, path).issues;
      },
      { limit, after },
    );
    return { items: items.map(toIssue), ...rest };
  },

  async readLatest({ host, token, path }, filter) {
    const data = await sender(host, token)(LATEST_QUERY, issuesVariables(path, filter));
    const { project } = data as { project: { issues: { count: number; nodes: { updatedAt: string }[] } } | null };
    const { count, nodes } = reached(project, path).issues;
    return { total: count, updatedAt: nodes[0]?.updatedAt };
  },

  async listLabels({ host, token, path }) {
    return (await allLabels(sender(host, token), path)).map((entry) => entry.name);
  },

  async listPeople({ host, token, path }) {
    return (await allPeople(sender(host, token), path)).map((entry) => entry.name);
  },

  async readIssueUpdate({ host, token, path }, number) {
    const query = "query($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { updatedAt } } }";
    const { project } = (await sender(host, token)(query, { path, iid: String(number) })) as {
      project: { issue: { updatedAt: string } | null } | null;
    };
    return reachedIssue(project, path, number);
  },

  async readIssue({ host, token, path }, number) {
    const send = sender(host, token);
    const url = `${projectUrl(host, path)}/issues/${number}`;
    const iid = String(number);
    const [issue, labels, states, milestones, extraWidgets] = await Promise.all([
      send(ISSUE_QUERY, { path, iid }),
      getPaged(`${url}/resource_label_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_state_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_milestone_events?per_page=100`, headers(token)),
      readExtraWidgets(send, path, iid),
    ]);
    const { project } = issue as {
      project: { issue: (GitLabIssue & { notes: GraphqlPage<GitLabNote> }) | null; workItems: { nodes: GitLabWorkItem[] } } | null;
    };
    const found = reachedIssue(project, path, number);
    const item = reached(project?.workItems.nodes[0], `Issue #${number}`);
    const later = found.notes.pageInfo.hasNextPage
      ? await allNodes<GitLabNote>(send, NOTES_QUERY, { path, iid, cursor: found.notes.pageInfo.endCursor }, (data) => {
          const answer = data as { project: { issue: { notes: GraphqlPage<GitLabNote> } | null } | null };
          return reachedIssue(answer.project, path, number).notes;
        })
      : [];
    const notes = [...found.notes.nodes, ...later];
    return {
      ...toIssue(found),
      provider: "gitlab",
      events: toEvents(notes, labels as GitLabLabelEvent[], states as GitLabStateEvent[], milestones as GitLabMilestoneEvent[]),
      fields: toFields({ ...item, widgets: [...item.widgets, ...extraWidgets] }),
      body: found.description ?? "",
      notes: toNotes(notes),
    };
  },

  async readImage({ host, token, path }, source) {
    const upload = uploadOf(host, source);
    return upload && fetchImageOk(`${projectUrl(host, path)}/uploads/${upload.secret}/${upload.file}`, headers(token));
  },

  uploadName(host, source) {
    const upload = uploadOf(host, source);
    return upload && decodeURIComponent(upload.file);
  },

  async readUpload({ host, token, path }, source) {
    const upload = uploadOf(host, source);
    return upload && fetchUploadOk(`${projectUrl(host, path)}/uploads/${upload.secret}/${upload.file}`, headers(token));
  },

  internalNotes: true,

  async addComment({ host, token, path }, number, body, internal) {
    const send = sender(host, token);
    const query = "query($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { id } } }";
    const { project } = (await send(query, { path, iid: String(number) })) as { project: { issue: { id: string } | null } | null };
    const { id } = reachedIssue(project, path, number);
    await mutate(send, { mutation: "createNote", inputType: "CreateNoteInput", input: { noteableId: id, body, internal } });
  },

  ...fieldMethods({ graphql: sender, handlerOf: (_send, _path, fieldId) => fieldHandlerOf(fieldId), readTarget, mutate }),

  confidentialIssues: true,

  changeRequest: { noun: "merge request", prefix: "!", checks: "pipeline", selfApproval: true, deletesSourceBranch: true },

  async findChangeRequest({ host, token, path }, head) {
    // A project's merge requests are those into it; one from a fork names its own source project.
    const query = `query($path: ID!, $head: [String!]) {
      project(fullPath: $path) {
        mergeRequests(sourceBranches: $head, state: opened, first: 20) {
          nodes { iid webUrl sourceProject { fullPath } }
        }
      }
    }`;
    const data = (await sender(host, token)(query, { path, head: [head] })) as {
      project: { mergeRequests: { nodes: GitLabMergeRequest[] } } | null;
    };
    return ownMergeRequest(reached(data.project, path).mergeRequests.nodes, path);
  },

  async createChangeRequest({ host, token, path }, { head, base, title, body, draft, deleteSourceBranch }) {
    const { mergeRequest } = await mutate<{ mergeRequest: { iid: string; webUrl: string } | null }>(
      sender(host, token),
      {
        mutation: "mergeRequestCreate",
        inputType: "MergeRequestCreateInput",
        input: {
          projectPath: path,
          sourceBranch: head,
          targetBranch: base,
          title: draft ? `Draft: ${title}` : title,
          description: body,
          removeSourceBranch: deleteSourceBranch,
        },
      },
      "mergeRequest { iid webUrl }",
    );
    const created = reached(mergeRequest, `The new merge request of ${path}`);
    return { number: Number(created.iid), url: created.webUrl };
  },

  async approveChangeRequest({ host, token, path }, number) {
    // Asked first: REST refuses an author the project or its policies keep from approving with a bare
    // 401, which says nothing of why.
    const { userPermissions } = await readMergeRequest<{ userPermissions: { canApprove: boolean } }>(
      sender(host, token),
      path,
      number,
      "userPermissions { canApprove }",
    );
    if (!userPermissions.canApprove) {
      throw new Error("GitLab does not let this account approve it");
    }
    const response = await fetchOk(`${projectUrl(host, path)}/merge_requests/${number}/approve`, headers(token), { method: "POST" });
    void response.body?.cancel();
  },

  async autoMergeChangeRequest({ host, token, path }, number, squash) {
    const send = sender(host, token);
    // The commit it merges, which the mutation takes to refuse a branch pushed meanwhile.
    const { diffHeadSha } = await readMergeRequest<{ diffHeadSha: string | null }>(send, path, number, "diffHeadSha");
    await mutate(send, {
      mutation: "mergeRequestAccept",
      inputType: "MergeRequestAcceptInput",
      input: { projectPath: path, iid: String(number), sha: diffHeadSha, strategy: "MERGE_WHEN_CHECKS_PASS", squash },
    });
  },

  async listChangeRequests({ host, token, path }, filter, limit, after) {
    const { items, ...rest } = await firstNodes<GitLabMergeRequestRow>(
      sender(host, token),
      MERGE_REQUESTS_QUERY,
      mergeRequestsVariables(path, filter),
      (data) => {
        const { project } = data as { project: { mergeRequests: GraphqlPage<GitLabMergeRequestRow> } | null };
        return reached(project, path).mergeRequests;
      },
      { limit, after, keep: (entry) => fromOwnProject(entry, path) },
    );
    return { items: items.map(toChangeRequestRow), ...rest };
  },

  async readChangeRequestsLatest({ host, token, path }, filter) {
    type Latest = Pick<GitLabMergeRequestRow, "iid" | "updatedAt" | "sourceProject" | "headPipeline">;
    const data = await sender(host, token)(MERGE_REQUESTS_LATEST_QUERY, mergeRequestsVariables(path, filter));
    const { project } = data as { project: { mergeRequests: { count: number; nodes: Latest[] } } | null };
    const { count, nodes } = reached(project, path).mergeRequests;
    const own = nodes.filter((entry) => fromOwnProject(entry, path));
    return {
      total: count,
      updatedAt: own[0]?.updatedAt,
      checks: checksText(own.map((entry) => ({ number: Number(entry.iid), checks: pipelineChecks(entry.headPipeline) }))),
    };
  },

  async readChangeRequest({ host, token, path }, number) {
    const send = sender(host, token);
    const url = `${projectUrl(host, path)}/merge_requests/${number}`;
    const iid = String(number);
    const [answer, labels, states, milestones, closes] = await Promise.all([
      send(MERGE_REQUEST_QUERY, { path, iid }),
      getPaged(`${url}/resource_label_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_state_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_milestone_events?per_page=100`, headers(token)),
      getPaged(`${url}/closes_issues?per_page=100`, headers(token)),
    ]);
    const { project } = answer as { project: { mergeRequest: GitLabMergeRequestDetail | null } | null };
    const found = reached(reached(project, path).mergeRequest, `Merge request !${number}`);
    const later = found.notes.pageInfo.hasNextPage
      ? await allNodes<GitLabNote>(send, MERGE_REQUEST_NOTES_QUERY, { path, iid, cursor: found.notes.pageInfo.endCursor }, (data) => {
          const { project: again } = data as { project: { mergeRequest: { notes: GraphqlPage<GitLabNote> } | null } | null };
          return reached(reached(again, path).mergeRequest, `Merge request !${number}`).notes;
        })
      : [];
    const notes = [...found.notes.nodes, ...later];
    const row = toChangeRequestRow(found);
    const reviewThreads = toReviewThreads(notes);
    const onChanges = new Set(reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.id)));
    return {
      ...row,
      provider: "gitlab",
      kind: gitlab.changeRequest,
      events: toEvents(notes, labels as GitLabLabelEvent[], states as GitLabStateEvent[], milestones as GitLabMilestoneEvent[]),
      fields: toMergeRequestFields(found, closes as { iid: number; title: string }[]),
      body: found.description ?? "",
      notes: toNotes(notes).filter((note) => !onChanges.has(note.id)),
      reviewThreads,
      status: {
        checks: jobChecksOf(host, found.headPipeline?.jobs?.nodes ?? []),
        checksUrl: found.headPipeline?.path ? `https://${host}${found.headPipeline.path}` : undefined,
        blockers: blockersOf(found.detailedMergeStatus),
        approvalsOutstanding: found.approvalsLeft ? { left: found.approvalsLeft } : undefined,
        conflicts: found.conflicts,
        autoMerge: found.autoMergeEnabled,
        // The strategy `mergeChangeRequest` sets: GitLab offers it only while the merge request cannot merge at once.
        autoMergeable: found.availableAutoMergeStrategies?.includes("merge_when_checks_pass") ?? false,
        reviewers: reviewersOf(found),
        head: found.sourceBranch,
        base: found.targetBranch,
        commits: found.commitCount ?? 0,
        additions: found.diffStatsSummary?.additions,
        deletions: found.diffStatsSummary?.deletions,
        mergedBy: found.mergeUser?.username,
        mergedAt: found.mergedAt ?? undefined,
      },
    };
  },

  async readChangeRequestUpdate({ host, token, path }, number) {
    const found = await readMergeRequest<Pick<GitLabMergeRequestRow, "updatedAt" | "headPipeline">>(
      sender(host, token),
      path,
      number,
      "updatedAt headPipeline { status }",
    );
    return { updatedAt: found.updatedAt, checks: pipelineChecks(found.headPipeline) };
  },

  listChangeRequestOptions: mergeRequestFields.listOptions,

  setChangeRequestField: mergeRequestFields.setField,

  async updateChangeRequest({ host, token, path }, number, { title, body, state }) {
    await mutate(sender(host, token), {
      mutation: "mergeRequestUpdate",
      inputType: "MergeRequestUpdateInput",
      input: { projectPath: path, iid: String(number), title, description: body, state: state && (state === "open" ? "OPENED" : "CLOSED") },
    });
  },

  async commentChangeRequest({ host, token, path }, number, body) {
    const send = sender(host, token);
    const { id } = await readMergeRequest<{ id: string }>(send, path, number, "id");
    await mutate(send, { mutation: "createNote", inputType: "CreateNoteInput", input: { noteableId: id, body } });
  },

  async mergeChangeRequest({ host, token, path }, number, whenChecksPass) {
    const send = sender(host, token);
    // What the merge request is set to do itself: GraphQL takes the squash as off where left out.
    const found = await readMergeRequest<{ diffHeadSha: string | null; squashOnMerge: boolean; forceRemoveSourceBranch: boolean | null }>(
      send,
      path,
      number,
      "diffHeadSha squashOnMerge forceRemoveSourceBranch",
    );
    await mutate(send, {
      mutation: "mergeRequestAccept",
      inputType: "MergeRequestAcceptInput",
      input: {
        projectPath: path,
        iid: String(number),
        sha: found.diffHeadSha,
        squash: found.squashOnMerge,
        shouldRemoveSourceBranch: found.forceRemoveSourceBranch ?? undefined,
        ...(whenChecksPass && { strategy: "MERGE_WHEN_CHECKS_PASS" }),
      },
    });
  },

  async createIssue({ host, token, path }, title, body, confidential) {
    const { issue } = await mutate<{ issue: { iid: string } | null }>(
      sender(host, token),
      { mutation: "createIssue", inputType: "CreateIssueInput", input: { projectPath: path, title, description: body, confidential } },
      "issue { iid }",
    );
    return Number(reached(issue, `The new issue of ${path}`).iid);
  },

  async editComment({ host, token }, id, body) {
    await mutate(sender(host, token), { mutation: "updateNote", inputType: "UpdateNoteInput", input: { id, body } });
  },

  async deleteComment({ host, token }, id) {
    await mutate(sender(host, token), { mutation: "destroyNote", inputType: "DestroyNoteInput", input: { id } });
  },

  deleteIssue({ host, token, path }, number) {
    return sendDelete(`${projectUrl(host, path)}/issues/${number}`, headers(token));
  },

  uploads: () => ({}),

  async uploadFile({ host, token, path }, name, bytes) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(bytes)]), name);
    const response = await fetchOk(`${projectUrl(host, path)}/uploads`, headers(token), { method: "POST", body: form });
    return ((await response.json()) as { markdown: string }).markdown;
  },

  async updateIssue({ host, token, path }, number, change) {
    await mutate(sender(host, token), {
      mutation: "updateIssue",
      inputType: "UpdateIssueInput",
      input: toIssueInput(path, number, change),
    });
  },
};
