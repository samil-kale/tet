import { allAssignable, allLabels, mutate, readIssueNode, readPullRequestNode, repositoryNodes, repositoryOf, sender } from "./api";
import {
  fieldMethods,
  numberOf,
  pickHandler,
  textOf,
  valueHandler,
  type FieldContext,
  type FieldHandler,
  type GraphqlSend,
  type NamedId,
  type Write,
} from "../provider";
import { type GitHubExtras, type GitHubFieldDefinition, type GitHubFieldValue, type GitHubParent, parentName } from "./mapping";
import { fieldDefinitions, FIELDS_QUERY, PARENT_QUERY, TYPE_QUERY } from "./queries";
import { ownValue } from "../../../shared/own-value";

/** What a change of an issue's field needs of the issue: its id, and the id of its parent, which
 *  taking the parent off names. */
export interface Target {
  id: string;
  parentId?: string;
}

export function updateIssueWrite(input: object): Write {
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
export function issueFieldWrite(definition: GitHubFieldDefinition, target: Target, entry: object | null): Write {
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
/** A repository's open milestones by title, with their ids. */

export function allMilestones(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return repositoryNodes(send, path, "milestones", "id name: title", "states: [OPEN], orderBy: { field: DUE_DATE, direction: ASC }");
}
/** The issue types a repository offers, by name, with their ids. */

export async function allIssueTypes(send: GraphqlSend, path: string): Promise<NamedId[]> {
  const types = await repositoryNodes<NamedId & { isEnabled: boolean }>(send, path, "issueTypes", "id name isEnabled");
  return types.filter((type) => type.isEnabled).map(({ id, name }) => ({ id, name }));
}
/** The open issues of a repository but the issue itself, by the name `parentName` gives them: the
 *  parents it can be given. */

export async function openIssues({ send, path, number }: FieldContext<Target>): Promise<NamedId[]> {
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
export async function readFieldDefinitions(send: GraphqlSend, path: string): Promise<GitHubFieldDefinition[]> {
  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { issueFields(first: 50) { nodes { ${fieldDefinitions(true)} } } }
  }`;
  const data = (await send(query, repositoryOf(path))) as { repository: { issueFields: { nodes: GitHubFieldDefinition[] } | null } };
  return data.repository.issueFields?.nodes ?? [];
}

/** The field of GitHub an id names: one of the table, or an issue field of the organization. */
export async function fieldHandlerOf(send: GraphqlSend, path: string, fieldId: string): Promise<FieldHandler<Target>> {
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

export async function readTarget(send: GraphqlSend, path: string, number: number): Promise<Target> {
  type WithParent = { parent?: { id: string } | null };
  // A host without sub-issues refuses the query that asks for the parent.
  const issue = await readIssueNode<WithParent>(send, path, number, "parent { id }").catch(() =>
    readIssueNode<WithParent>(send, path, number),
  );
  return { id: issue.id, parentId: issue.parent?.id };
}

/** What a change of a pull request's field needs of it: its id, and the ids of who reviewed it, whose
 *  review stays and is not asked for again. */
export interface PullRequestTarget {
  id: string;
  reviewedIds: string[];
}

export function updatePullRequestWrite(input: object): Write {
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

export async function readPullRequestTarget(send: GraphqlSend, path: string, number: number): Promise<PullRequestTarget> {
  const found = await readPullRequestNode<{ latestReviews: { nodes: { author: { id?: string } | null }[] } }>(
    send,
    path,
    number,
    "latestReviews(first: 50) { nodes { author { ... on User { id } } } }",
  );
  return { id: found.id, reviewedIds: found.latestReviews.nodes.flatMap((review) => review.author?.id ?? []) };
}

export const pullRequestFields = fieldMethods<PullRequestTarget>({
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
export async function readExtras(send: GraphqlSend, variables: object): Promise<GitHubExtras> {
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
