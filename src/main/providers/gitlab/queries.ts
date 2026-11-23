import type { ChangeRequestFilter, IssueFilter } from "../../../shared/types/providers";

export const ISSUE_ROW = `iid title webUrl state createdAt updatedAt
  author { username }
  assignees(first: 100) { nodes { username } }
  labels(first: 100) { nodes { title } }`;

export const NOTE_FIELDS = "id system internal body createdAt author { username }";

export const NOTE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { ${NOTE_FIELDS} }`;

export const MERGE_REQUEST_NOTE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { ${NOTE_FIELDS} position { filePath newLine oldLine } discussion { id resolved } }`;

/** What a filter asks for (`issuesVariables`), as the queries of a list and of its latest change take it. */
export const FILTER_VARIABLES =
  "$state: IssuableState, $authorUsername: String, $assigneeUsernames: [String!], $labelName: [String], $search: String, $in: [IssuableSearchableField!]";

export const FILTER_ARGUMENTS =
  "state: $state, authorUsername: $authorUsername, assigneeUsernames: $assigneeUsernames, labelName: $labelName, search: $search, in: $in";

export const ISSUES_QUERY = `query($path: ID!, $first: Int!, $cursor: String, ${FILTER_VARIABLES}) {
  project(fullPath: $path) {
    issues(first: $first, after: $cursor, sort: created_desc, ${FILTER_ARGUMENTS}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ROW} }
    }
  }
}`;

export const LATEST_QUERY = `query($path: ID!, ${FILTER_VARIABLES}) {
  project(fullPath: $path) {
    issues(first: 1, sort: updated_desc, ${FILTER_ARGUMENTS}) {
      count
      nodes { updatedAt }
    }
  }
}`;

/** The widgets of a work item every GitLab has, by the fields each holds; `type` tells which one a
 *  node is. */
export const WIDGETS = `confidential
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
export const EXTRA_WIDGETS = `widgets {
    type
    ... on WorkItemWidgetStatus { status { name } }
    ... on WorkItemWidgetWeight { weight }
    ... on WorkItemWidgetIteration { iteration { id title startDate dueDate iterationCadence { title } } }
    ... on WorkItemWidgetHealthStatus { healthStatus }
  }`;

export const ISSUE_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    issue(iid: $iid) {
      ${ISSUE_ROW}
      description
      notes(first: 100) { ${NOTE_PAGE} }
    }
    workItems(iids: [$iid]) { nodes { ${WIDGETS} } }
  }
}`;

export const EXTRA_WIDGETS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { workItems(iids: [$iid]) { nodes { ${EXTRA_WIDGETS} } } }
}`;

export const NOTES_QUERY = `query($path: ID!, $iid: String!, $cursor: String) {
  project(fullPath: $path) { issue(iid: $iid) { notes(first: 100, after: $cursor) { ${NOTE_PAGE} } } }
}`;

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
export function titleSearch(text: string | undefined): Record<string, unknown> {
  return text ? { search: text, in: ["TITLE"] } : {};
}

export const MERGE_REQUEST_ROW = `${ISSUE_ROW} draft sourceProject { fullPath } diffHeadSha headPipeline { status }`;

/** What a filter asks for (`mergeRequestsVariables`), as the queries of a list and of its latest change take it. */
export const MERGE_REQUEST_FILTER_VARIABLES =
  "$state: MergeRequestState, $authorUsername: String, $assigneeUsername: String, $reviewerUsername: String, $labels: [String!], $search: String, $in: [IssuableSearchableField!]";

export const MERGE_REQUEST_FILTER_ARGUMENTS =
  "state: $state, authorUsername: $authorUsername, assigneeUsername: $assigneeUsername, reviewerUsername: $reviewerUsername, labels: $labels, search: $search, in: $in";

export const MERGE_REQUESTS_QUERY = `query($path: ID!, $first: Int!, $cursor: String, ${MERGE_REQUEST_FILTER_VARIABLES}) {
  project(fullPath: $path) {
    mergeRequests(first: $first, after: $cursor, sort: CREATED_DESC, ${MERGE_REQUEST_FILTER_ARGUMENTS}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${MERGE_REQUEST_ROW} }
    }
  }
}`;

/** Paged whole: `count` takes in merge requests from forks, which only their nodes tell apart. */
export const MERGE_REQUESTS_LATEST_QUERY = `query($path: ID!, $cursor: String, ${MERGE_REQUEST_FILTER_VARIABLES}) {
  project(fullPath: $path) {
    mergeRequests(first: 100, after: $cursor, sort: UPDATED_DESC, ${MERGE_REQUEST_FILTER_ARGUMENTS}) {
      count
      pageInfo { hasNextPage endCursor }
      nodes { iid updatedAt sourceProject { fullPath } headPipeline { status } }
    }
  }
}`;

export const MERGE_REQUEST_QUERY = `query($path: ID!, $iid: String!) {
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

export const MERGE_REQUEST_NOTES_QUERY = `query($path: ID!, $iid: String!, $cursor: String) {
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
