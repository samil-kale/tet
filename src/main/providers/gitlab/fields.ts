import { type GitLabIteration, type GitLabParent, type GitLabWidget, HEALTH_STATUSES, iterationName, parentName } from "./mapping";
import {
  allNodes,
  fieldMethods,
  numberOf,
  pickHandler,
  reached,
  textOf,
  valueHandler,
  type FieldContext,
  type FieldHandler,
  type GraphqlPage,
  type GraphqlSend,
  type NamedId,
  type Write,
} from "../provider";
import { allLabels, allPeople, mutate, projectNodes, sender } from "./api";
import { isTimeRemoval } from "../../../shared/types/providers";
import { ownValue } from "../../../shared/own-value";
import { EXTRA_WIDGETS_QUERY } from "./queries";

/** The milestones a project can set, those of its groups included, with their ids. */
export function allMilestones(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return projectNodes(send, path, "milestones", "id name: title", "state: active, includeAncestors: true");
}

/** The iterations a project can set, those of its groups included, with their ids. */
export async function allIterations(send: GraphqlSend, path: string): Promise<NamedId[]> {
  const iterations = await projectNodes<GitLabIteration>(
    send,
    path,
    "iterations",
    "id title startDate dueDate iterationCadence { title }",
    "state: opened, includeAncestors: true",
  );
  return iterations.map((iteration) => ({ id: iteration.id, name: iterationName(iteration) }));
}

/** What a change of a work item's field needs of it: its id, and the labels it carries, whose ids a
 *  new set is told apart from. */
export interface Target {
  id: string;
  labels: NamedId[];
}

export type Context = FieldContext<Target>;

/** The work item an issue is, as far as `selection` reads it. */
export async function readWorkItem<T>(send: GraphqlSend, path: string, number: number, selection: string): Promise<T> {
  const query = `query($path: ID!, $iid: String!) {
    project(fullPath: $path) { workItems(iids: [$iid]) { nodes { ${selection} } } }
  }`;
  const { project } = (await send(query, { path, iid: String(number) })) as { project: { workItems: { nodes: T[] } } | null };
  return reached(reached(project, path).workItems.nodes[0], `Issue #${number}`);
}

/** What a work item's type allows of one widget: its statuses, the types of its parent. */
export interface WidgetDefinition {
  allowedStatuses?: NamedId[];
  allowedParentTypes?: { nodes: { name: string }[] };
}

export async function definitionOf(context: Context, selection: string): Promise<WidgetDefinition[]> {
  const item = await readWorkItem<{ workItemType: { widgetDefinitions: WidgetDefinition[] } }>(
    context.send,
    context.path,
    context.number,
    `workItemType { widgetDefinitions { type ${selection} } }`,
  );
  return item.workItemType.widgetDefinitions;
}

/** The work items of a namespace that are one of `types`, open and not the item itself. */
export async function openWorkItems(context: Context, namespace: string, types: string[], ancestors: boolean): Promise<NamedId[]> {
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
export function workItemUpdate(target: Target, input: object): Write {
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

export function fieldHandlerOf(fieldId: string): FieldHandler<Target> {
  const handler = ownValue(FIELD_HANDLERS, fieldId);
  if (!handler) {
    throw new Error(`An issue of GitLab has no field ${fieldId}`);
  }
  return handler;
}
/** The work item an issue is, with what a change of its fields needs of it. */

export async function readTarget(send: GraphqlSend, path: string, number: number): Promise<Target> {
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
export async function readExtraWidgets(send: GraphqlSend, path: string, iid: string): Promise<GitLabWidget[]> {
  const data = (await send(EXTRA_WIDGETS_QUERY, { path, iid }).catch(() => undefined)) as
    { project: { workItems: { nodes: { widgets: GitLabWidget[] }[] } } | null } | undefined;
  return data?.project?.workItems.nodes[0]?.widgets ?? [];
}

/** What a change of a merge request's field needs of it: where it is, as its mutations name it. */
export interface MergeRequestTarget {
  projectPath: string;
  iid: string;
}

/** People by login alone: a merge request's mutations name them so. */
export async function peopleByLogin(send: GraphqlSend, path: string): Promise<NamedId[]> {
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

export const mergeRequestFields = fieldMethods<MergeRequestTarget>({
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
