import type {
  Issue,
  IssueChange,
  IssueEvent,
  IssueField,
  IssueFieldValue,
  IssueFilter,
  IssueNote,
  IssueTimeLog,
  RemoteRepository,
} from "../../shared/types/providers";
import {
  allNodes,
  ApiError,
  fetchImageOk,
  fetchOk,
  getPaged,
  idsByName,
  sendDelete,
  sendGraphql,
  type GitProvider,
  type GraphqlPage,
  type GraphqlSend,
} from "./provider";

// GraphQL for all that it answers in structure and out of experiment. REST for the rest: an issue's
// label, state and milestone events, which GraphQL words only as text; deleting an issue and uploading
// a file, whose mutations are experiments; and reading an upload's bytes, which GraphQL cannot carry.

function apiBase(host: string): string {
  return `https://${host}/api/v4`;
}

function headers(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token };
}

function sender(host: string, token: string): GraphqlSend {
  return (query, variables) => sendGraphql(`https://${host}/api/graphql`, { Authorization: `Bearer ${token}` }, query, variables);
}

/** A project GraphQL answers null for says neither that it is missing nor that the token cannot read
 *  it: REST's 404 for both, which hands over to the next account. */
function reached<T>(found: T | null | undefined, what: string): T {
  if (found === null || found === undefined) {
    throw new ApiError(404, `${what} was not found, or this account cannot read it`);
  }
  return found;
}

/** The issue a project's answer holds, both reached (`reached`). */
function reachedIssue<T>(project: { issue: T | null } | null, path: string, number: number): T {
  return reached(reached(project, path).issue, `Issue #${number}`);
}

/** What a mutation answered, which says what it refused in a field of its own. */
export function mutationError(result: { errors?: string[] } | null | undefined): string | undefined {
  if (!result) {
    return "GitLab answered the change with nothing";
  }
  return result.errors && result.errors.length > 0 ? result.errors.join("; ") : undefined;
}

/** One mutation, answering what it was asked to select beside its `errors`. */
async function mutate<T>(send: GraphqlSend, name: string, inputType: string, input: object, selection = ""): Promise<T> {
  const query = `mutation($input: ${inputType}!) { ${name}(input: $input) { ${selection} errors } }`;
  const data = (await send(query, { input })) as Record<string, (T & { errors?: string[] }) | null> | null;
  const result = data?.[name];
  const refused = mutationError(result);
  if (refused !== undefined || !result) {
    throw new Error(refused);
  }
  return result;
}

interface GitLabUser {
  username: string;
}

/** An issue as GraphQL says it; only one read alone has the last two. */
export interface GitLabIssue {
  iid: string;
  title: string;
  webUrl: string;
  state: string;
  createdAt: string;
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
}

const ISSUE_ROW = `iid title webUrl state createdAt
  author { username }
  assignees(first: 100) { nodes { username } }
  labels(first: 100) { nodes { title } }`;

const NOTE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { id system internal body createdAt author { username } }`;

const ISSUES_QUERY = `query($path: ID!, $cursor: String, $state: IssuableState, $authorUsername: String, $assigneeUsernames: [String!], $labelName: [String]) {
  project(fullPath: $path) {
    issues(first: 100, after: $cursor, sort: created_desc, state: $state, authorUsername: $authorUsername, assigneeUsernames: $assigneeUsernames, labelName: $labelName) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ROW} }
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

const LABELS_QUERY = `query($path: ID!, $cursor: String) {
  project(fullPath: $path) {
    labels(first: 100, after: $cursor, includeAncestorGroups: true) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }
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

/** What a pick field lists: a name as `IssueField.value` shows it, with the id GitLab addresses it by. */
interface NamedId {
  id: string;
  name: string;
}

/** A project's labels by name, with their ids, those of its groups included. */
async function allLabels(send: GraphqlSend, path: string): Promise<NamedId[]> {
  const entries = await allNodes<{ id: string; title: string }>(send, LABELS_QUERY, { path }, (data) => {
    const { project } = data as { project: { labels: GraphqlPage<{ id: string; title: string }> } | null };
    return reached(project, path).labels;
  });
  return entries.map((entry) => ({ id: entry.id, name: entry.title }));
}

/** Who can be assigned, by login, with their ids. */
async function allPeople(send: GraphqlSend, path: string): Promise<NamedId[]> {
  // relations: the default leaves out who reaches the project through a group shared with it.
  const query = `query($path: ID!, $cursor: String) {
    project(fullPath: $path) {
      projectMembers(relations: [DIRECT, INHERITED, INVITED_GROUPS, SHARED_INTO_ANCESTORS], first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { user { id username } }
      }
    }
  }`;
  type Member = { user: { id: string; username: string } | null };
  const entries = await allNodes<Member>(send, query, { path }, (data) => {
    const { project } = data as { project: { projectMembers: GraphqlPage<Member> } | null };
    return reached(project, path).projectMembers;
  });
  return entries.flatMap((entry) => (entry.user ? [{ id: entry.user.id, name: entry.user.username }] : []));
}

/** The milestones a project can set, those of its groups included, with their ids. */
async function allMilestones(send: GraphqlSend, path: string): Promise<NamedId[]> {
  const query = `query($path: ID!, $cursor: String) {
    project(fullPath: $path) {
      milestones(first: 100, after: $cursor, state: active, includeAncestors: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id title }
      }
    }
  }`;
  const entries = await allNodes<{ id: string; title: string }>(send, query, { path }, (data) => {
    const { project } = data as { project: { milestones: GraphqlPage<{ id: string; title: string }> } | null };
    return reached(project, path).milestones;
  });
  return entries.map((entry) => ({ id: entry.id, name: entry.title }));
}

/** The iterations a project can set, those of its groups included, with their ids. */
async function allIterations(send: GraphqlSend, path: string): Promise<NamedId[]> {
  const query = `query($path: ID!, $cursor: String) {
    project(fullPath: $path) {
      iterations(first: 100, after: $cursor, state: opened, includeAncestors: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id title startDate dueDate iterationCadence { title } }
      }
    }
  }`;
  const entries = await allNodes<GitLabIteration>(send, query, { path }, (data) => {
    const { project } = data as { project: { iterations: GraphqlPage<GitLabIteration> } | null };
    return reached(project, path).iterations;
  });
  return entries.map((entry) => ({ id: entry.id, name: iterationName(entry) }));
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

function pickField(
  id: string,
  name: string,
  value: string[],
  {
    several = false,
    shown = "text",
    editable = true,
  }: { several?: boolean; shown?: "text" | "people" | "labels"; editable?: boolean } = {},
): IssueField {
  return { id, name, editable, kind: "pick", value, several, shown };
}

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

/** What a pick field's choices are read with. */
interface FieldContext {
  send: GraphqlSend;
  path: string;
  number: number;
  target: Target;
}

/** A pick field of GitLab: what its values are, where its choices are listed and what `workItemUpdate`
 *  takes to set the ids chosen. */
interface PickField {
  /** What one value is, for the refusal of an unknown name. */
  what: string;
  choices: (context: FieldContext) => Promise<NamedId[]>;
  input: (ids: string[], target: Pick<Target, "labels">) => object;
}

/** What a work item's type allows of one widget's definition: its statuses, the types of its parent. */
async function definitionOf(
  context: FieldContext,
  selection: string,
): Promise<{ allowedStatuses?: NamedId[]; allowedParentTypes?: { nodes: { name: string }[] } }[]> {
  const query = `query($path: ID!, $iid: String!) {
    project(fullPath: $path) { workItems(iids: [$iid]) { nodes { workItemType { widgetDefinitions { type ${selection} } } } } }
  }`;
  const { project } = (await context.send(query, { path: context.path, iid: String(context.number) })) as {
    project: {
      workItems: {
        nodes: {
          workItemType: { widgetDefinitions: { allowedStatuses?: NamedId[]; allowedParentTypes?: { nodes: { name: string }[] } }[] };
        }[];
      };
    } | null;
  };
  return reached(reached(project, context.path).workItems.nodes[0], `Issue #${context.number}`).workItemType.widgetDefinitions;
}

/** The work items of a namespace that are one of `types`, open and not the item itself. */
async function openWorkItems(context: FieldContext, namespace: string, types: string[], ancestors: boolean): Promise<NamedId[]> {
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
  return entries.filter((entry) => entry.id !== context.target.id).map((entry) => ({ id: entry.id, name: parentName(entry) }));
}

const PICK_FIELDS: Record<string, PickField> = {
  status: {
    what: "status",
    choices: async (context) => {
      const definitions = await definitionOf(context, "... on WorkItemWidgetDefinitionStatus { allowedStatuses { id name } }");
      return definitions.flatMap((definition) => definition.allowedStatuses ?? []);
    },
    input: ([status]) => {
      if (status === undefined) {
        throw new Error("A status cannot be taken off");
      }
      return { statusWidget: { status } };
    },
  },
  assignees: {
    what: "person to assign",
    choices: ({ send, path }) => allPeople(send, path),
    input: (assigneeIds) => ({ assigneesWidget: { assigneeIds } }),
  },
  labels: {
    what: "label",
    // What the item carries stays offered, as a group's labels may be left out of what the project lists.
    choices: async ({ send, path, target }) => {
      const listed = await allLabels(send, path);
      return [...listed, ...target.labels.filter((label) => !listed.some((entry) => entry.id === label.id))];
    },
    input: (ids, target) => ({
      labelsWidget: {
        addLabelIds: ids.filter((id) => !target.labels.some((label) => label.id === id)),
        removeLabelIds: target.labels.map((label) => label.id).filter((id) => !ids.includes(id)),
      },
    }),
  },
  parent: {
    what: "parent",
    // An epic belongs to a group, whose own and ancestors' are listed from its path; the other types
    // are work items of the project.
    choices: async (context) => {
      const definitions = await definitionOf(context, "... on WorkItemWidgetDefinitionHierarchy { allowedParentTypes { nodes { name } } }");
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
    input: ([parentId]) => ({ hierarchyWidget: { parentId: parentId ?? null } }),
  },
  milestone: {
    what: "milestone",
    choices: ({ send, path }) => allMilestones(send, path),
    input: ([milestoneId]) => ({ milestoneWidget: { milestoneId: milestoneId ?? null } }),
  },
  iteration: {
    what: "iteration",
    choices: ({ send, path }) => allIterations(send, path),
    input: ([iterationId]) => ({ iterationWidget: { iterationId: iterationId ?? null } }),
  },
  health: {
    what: "health status",
    choices: () => Promise.resolve(HEALTH_STATUSES),
    input: ([healthStatus]) => ({ healthStatusWidget: { healthStatus: healthStatus ?? null } }),
  },
};

function pickFieldOf(fieldId: string): PickField {
  const pick = PICK_FIELDS[fieldId];
  if (!pick) {
    throw new Error(`${fieldId} is no field to choose from`);
  }
  return pick;
}

function numberOf(value: IssueFieldValue): number | null {
  if (value !== null && !Number.isInteger(value)) {
    throw new Error("It takes a whole number");
  }
  return value as number | null;
}

function textOf(value: IssueFieldValue): string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error("It takes text");
  }
  return value;
}

/** The other fields of GitLab: what `workItemUpdate` takes to set the value typed. */
const VALUE_FIELDS: Record<string, (value: IssueFieldValue) => object> = {
  weight: (value) => ({ weightWidget: { weight: numberOf(value) } }),
  startDate: (value) => ({ startAndDueDateWidget: { startDate: textOf(value) } }),
  dueDate: (value) => ({ startAndDueDateWidget: { dueDate: textOf(value) } }),
  // "0" is how GitLab takes an estimate off.
  timeEstimate: (value) => ({ timeTrackingWidget: { timeEstimate: textOf(value) ?? "0" } }),
  timeSpent: (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !("timeSpent" in value)) {
      throw new Error("Time spent is added as an entry");
    }
    const { timeSpent, spentAt, summary } = value;
    // What was left empty is left out, as GitLab takes now and no summary then.
    return { timeTrackingWidget: { timelog: { timeSpent, spentAt: spentAt || undefined, summary: summary || undefined } } };
  },
  confidential: (value) => {
    if (typeof value !== "boolean") {
      throw new Error("It is on or off");
    }
    return { confidential: value };
  },
};

/** What `workItemUpdate` takes to set a field to `value`: for a pick field, `ids` are the ids of the
 *  values, which only `setField` can look up. */
export function toWorkItemInput(fieldId: string, value: IssueFieldValue, ids: string[], target: Pick<Target, "labels">): object {
  const pick = PICK_FIELDS[fieldId];
  if (pick) {
    return pick.input(ids, target);
  }
  const set = VALUE_FIELDS[fieldId];
  if (!set) {
    throw new Error(`An issue of GitLab has no field ${fieldId}`);
  }
  return set(value);
}

/** The work item an issue is, with what a change of its fields needs of it. */
async function readTarget(send: GraphqlSend, path: string, number: number): Promise<Target> {
  const query = `query($path: ID!, $iid: String!) {
    project(fullPath: $path) {
      workItems(iids: [$iid]) { nodes { id widgets { type ... on WorkItemWidgetLabels { labels { nodes { id title } } } } } }
    }
  }`;
  const { project } = (await send(query, { path, iid: String(number) })) as {
    project: {
      workItems: { nodes: { id: string; widgets: { type: string; labels?: { nodes: { id: string; title: string }[] } }[] }[] };
    } | null;
  };
  const item = reached(reached(project, path).workItems.nodes[0], `Issue #${number}`);
  const labels = item.widgets.find((widget) => widget.type === "LABELS")?.labels?.nodes ?? [];
  return { id: item.id, labels: labels.map((label) => ({ id: label.id, name: label.title })) };
}

/** The widgets only some plans have, which an instance without them does not answer: the item shows
 *  without their fields, as it has none there. */
async function readExtraWidgets(send: GraphqlSend, path: string, iid: string): Promise<GitLabWidget[]> {
  try {
    const data = (await send(EXTRA_WIDGETS_QUERY, { path, iid })) as {
      project: { workItems: { nodes: { widgets: GitLabWidget[] }[] } } | null;
    };
    return data.project?.workItems.nodes[0]?.widgets ?? [];
  } catch {
    return [];
  }
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

/** What a filter asks for, in the words of `ISSUES_QUERY`. */
export function issuesVariables(path: string, filter: IssueFilter): Record<string, unknown> {
  return {
    path,
    state: filter.state && (filter.state === "open" ? "opened" : "closed"),
    authorUsername: filter.author,
    assigneeUsernames: filter.assignee ? [filter.assignee] : undefined,
    labelName: filter.labels.length > 0 ? filter.labels : undefined,
  };
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
    events.push({ ...base(entry), kind: entry.state === "closed" ? "closed" : "reopened" });
  }
  for (const entry of milestones) {
    if (entry.milestone) {
      events.push({ ...base(entry), kind: entry.action === "remove" ? "demilestoned" : "milestoned", milestone: entry.milestone.title });
    }
  }
  return events;
}

export const gitlab: GitProvider = {
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

  async listIssues({ host, token, path }, filter) {
    const entries = await allNodes<GitLabIssue>(sender(host, token), ISSUES_QUERY, issuesVariables(path, filter), (data) => {
      const { project } = data as { project: { issues: GraphqlPage<GitLabIssue> } | null };
      return reached(project, path).issues;
    });
    return entries.map(toIssue);
  },

  async listLabels({ host, token, path }) {
    return (await allLabels(sender(host, token), path)).map((entry) => entry.name);
  },

  async listPeople({ host, token, path }) {
    return (await allPeople(sender(host, token), path)).map((entry) => entry.name);
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

  internalNotes: true,

  async addComment({ host, token, path }, number, body, internal) {
    const send = sender(host, token);
    const query = "query($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { id } } }";
    const { project } = (await send(query, { path, iid: String(number) })) as { project: { issue: { id: string } | null } | null };
    const { id } = reachedIssue(project, path, number);
    await mutate(send, "createNote", "CreateNoteInput", { noteableId: id, body, internal });
  },

  async listOptions({ host, token, path }, number, fieldId) {
    const pick = pickFieldOf(fieldId);
    const send = sender(host, token);
    const choices = await pick.choices({ send, path, number, target: await readTarget(send, path, number) });
    return choices.map((choice) => choice.name);
  },

  async setField({ host, token, path }, number, fieldId, value) {
    const send = sender(host, token);
    // `workItemUpdate` has no way to take a booking back: it has a mutation of its own.
    if (fieldId === "timeSpent" && value !== null && typeof value === "object" && !Array.isArray(value) && "remove" in value) {
      await mutate(send, "timelogDelete", "TimelogDeleteInput", { id: value.remove });
      return;
    }
    const target = await readTarget(send, path, number);
    const pick = PICK_FIELDS[fieldId];
    if (pick && !Array.isArray(value)) {
      throw new Error(`${fieldId} takes a list of values`);
    }
    const ids = pick ? idsByName(value as string[], await pick.choices({ send, path, number, target }), pick.what) : [];
    await mutate(send, "workItemUpdate", "WorkItemUpdateInput", { id: target.id, ...toWorkItemInput(fieldId, value, ids, target) });
  },

  async createIssue({ host, token, path }, title, body) {
    const { issue } = await mutate<{ issue: { iid: string } | null }>(
      sender(host, token),
      "createIssue",
      "CreateIssueInput",
      { projectPath: path, title, description: body },
      "issue { iid }",
    );
    return Number(reached(issue, `The new issue of ${path}`).iid);
  },

  async editComment({ host, token }, id, body) {
    await mutate(sender(host, token), "updateNote", "UpdateNoteInput", { id, body });
  },

  async deleteComment({ host, token }, id) {
    await mutate(sender(host, token), "destroyNote", "DestroyNoteInput", { id });
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
    await mutate(sender(host, token), "updateIssue", "UpdateIssueInput", toIssueInput(path, number, change));
  },
};
