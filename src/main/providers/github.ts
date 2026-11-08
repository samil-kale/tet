import { ownValue } from "../../shared/own-value";
import type { Issue, IssueChange, IssueEvent, IssueField, IssueFilter, IssueNote, RemoteRepository } from "../../shared/types/providers";
import {
  allNodes,
  ApiError,
  fetchImageOk,
  fetchOk,
  fieldMethods,
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

const TIMELINE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes {
    __typename
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
    }
  }`;

const ISSUES_QUERY = `query($owner: String!, $name: String!, $cursor: String, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }, filterBy: $filter) {
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

export const github: GitProvider = {
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

  async listIssues({ host, token, path }, filter) {
    const entries = await allNodes<GitHubIssue>(
      sender(host, token),
      ISSUES_QUERY,
      issuesVariables(path, filter),
      (data) => (data as { repository: { issues: GraphqlPage<GitHubIssue> } }).repository.issues,
    );
    return entries.filter((entry) => carriesAll(entry, filter.labels)).map(toIssue);
  },

  async readLatest({ host, token, path }, filter) {
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
