import type { IssueFilter, ChangeRequestFilter, ChangeRequestState } from "../../../shared/types/providers";

export const ISSUE_ROW = `number title url state createdAt updatedAt
  author { login avatarUrl }
  assignees(first: 100) { nodes { login avatarUrl } }
  labels(first: 100) { nodes { name } }`;

export const COMMENT_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { id body createdAt author { login avatarUrl } }`;

export const ACTOR = "createdAt actor { login avatarUrl }";

export const TIMELINE_ARGUMENTS = `itemTypes: [CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, LABELED_EVENT, UNLABELED_EVENT,
  MILESTONED_EVENT, DEMILESTONED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT]`;

/** The timeline items an issue and a pull request both have, as `toEvent` reads them. */
export const EVENT_SELECTION = `__typename
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

export const TIMELINE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { ${EVENT_SELECTION} }`;

export const ISSUES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $cursor: String, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }, filterBy: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ROW} }
    }
  }
}`;

export const LATEST_QUERY = `query($owner: String!, $name: String!, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }, filterBy: $filter) {
      totalCount
      nodes { updatedAt }
    }
  }
}`;

/** `ISSUES_QUERY` and `LATEST_QUERY` for a filter with text, which `issues` cannot search
 *  (`issueSearch`). */
export const ISSUE_SEARCH_QUERY = `query($query: String!, $first: Int!, $cursor: String) {
  search(query: $query, type: ISSUE, first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${ISSUE_ROW} } }
  }
}`;

export const ISSUE_SEARCH_LATEST_QUERY = `query($query: String!) {
  search(query: $query, type: ISSUE, first: 1) {
    issueCount
    nodes { ... on Issue { updatedAt } }
  }
}`;

export const ISSUE_VARIABLES = "$owner: String!, $name: String!, $number: Int!";

export const ISSUE_QUERY = `query(${ISSUE_VARIABLES}) {
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
export function fieldDefinitions(withOptions: boolean): string {
  const options = withOptions ? " options { id name }" : "";
  return `__typename
  ... on IssueFieldText { id name }
  ... on IssueFieldNumber { id name }
  ... on IssueFieldDate { id name }
  ... on IssueFieldSingleSelect { id name${options} }
  ... on IssueFieldMultiSelect { id name${options} }`;
}

export const FIELD_VALUES = `... on IssueFieldTextValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldNumberValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldDateValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldSingleSelectValue { value field { ... on IssueFieldCommon { name } } }
  ... on IssueFieldMultiSelectValue { options { id name } field { ... on IssueFieldCommon { name } } }`;

export const TYPE_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 50) { nodes { name isEnabled } }
    issue(number: $number) { viewerCanType issueType { name } }
  }
}`;

export const PARENT_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) { issue(number: $number) { parent { number title repository { nameWithOwner } } } }
}`;

export const FIELDS_QUERY = `query(${ISSUE_VARIABLES}) {
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

export const COMMENTS_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) { issue(number: $number) { comments(first: 100, after: $cursor) { ${COMMENT_PAGE} } } }
}`;

export const TIMELINE_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { timelineItems(first: 100, after: $cursor, ${TIMELINE_ARGUMENTS}) { ${TIMELINE_PAGE} } }
  }
}`;

/** A pull request as a row reads it: an issue's, its draft state, where its branch is, and how its head
 *  commit's checks stand. */
export const PULL_REQUEST_ROW = `${ISSUE_ROW} isDraft headRepository { nameWithOwner }
  head: commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`;

/** GraphQL's `pullRequests` narrows by no person, so a list is GitHub's search (`pullRequestSearch`). */
export const PULL_REQUESTS_QUERY = `query($query: String!, $first: Int!, $cursor: String) {
  search(query: $query, type: ISSUE, first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PULL_REQUEST_ROW} } }
  }
}`;

/** Paged whole: the search also finds pull requests from forks, which only their nodes tell apart. */
export const PULL_REQUESTS_LATEST_QUERY = `query($query: String!, $cursor: String) {
  search(query: $query, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest { number updatedAt headRepository { nameWithOwner } head: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }
}`;

export const PULL_REQUEST_TIMELINE_ARGUMENTS = `itemTypes: [CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, LABELED_EVENT,
  UNLABELED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT, REVIEW_REQUESTED_EVENT,
  PULL_REQUEST_REVIEW, MERGED_EVENT, PULL_REQUEST_COMMIT]`;

export const PULL_REQUEST_TIMELINE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes {
    ${EVENT_SELECTION}
    ... on ReviewRequestedEvent { ${ACTOR} requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } }
    ... on PullRequestReview { id createdAt actor: author { login avatarUrl } state body }
    ... on MergedEvent { ${ACTOR} }
    ... on PullRequestCommit { commit { committedDate author { user { login avatarUrl } } } }
  }`;

/** A pull request's review threads, each with its first 100 comments, which no thread outgrows. */
export const REVIEW_THREAD_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { id path line originalLine isResolved isOutdated comments(first: 100) { ${COMMENT_PAGE} } }`;

export const PULL_REQUEST_QUERY = `query(${ISSUE_VARIABLES}) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${ISSUE_ROW}
      isDraft body baseRefName headRefName additions deletions mergeable mergeStateStatus reviewDecision mergedAt
      mergedBy { login }
      autoMergeRequest { enabledAt } viewerCanEnableAutoMerge
      commitCount: commits { totalCount }
      head: commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
                  ... on StatusContext { context state description targetUrl isRequired(pullRequestNumber: $number) }
                }
              }
            }
          }
        }
      }
      reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login avatarUrl } ... on Bot { login avatarUrl } } } }
      latestReviews(first: 50) { nodes { author { login avatarUrl } } }
      latestOpinionatedReviews(first: 100) { nodes { author { login } state } }
      closingIssuesReferences(first: 25) { nodes { number title } }
      participants(first: 100) { nodes { login avatarUrl } }
      commentPage: comments(first: 100) { ${COMMENT_PAGE} }
      timelineItems(first: 100, ${PULL_REQUEST_TIMELINE_ARGUMENTS}) { ${PULL_REQUEST_TIMELINE_PAGE} }
      reviewThreads(first: 100) { ${REVIEW_THREAD_PAGE} }
    }
  }
}`;

export const PULL_REQUEST_REVIEW_THREADS_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { ${REVIEW_THREAD_PAGE} } } }
}`;

export const PULL_REQUEST_COMMENTS_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(first: 100, after: $cursor) { ${COMMENT_PAGE} } } }
}`;

export const PULL_REQUEST_TIMELINE_QUERY = `query(${ISSUE_VARIABLES}, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $cursor, ${PULL_REQUEST_TIMELINE_ARGUMENTS}) { ${PULL_REQUEST_TIMELINE_PAGE} }
    }
  }
}`;

/** A filter's text in the words of GitHub's search: each word quoted, so none is read as a qualifier. */
export function titleTerms(text: string | undefined): string[] {
  const words = (text ?? "")
    .replaceAll('"', "")
    .split(/\s+/)
    .filter((word) => word !== "");
  return words.length === 0 ? [] : ["in:title", ...words.map((word) => `"${word}"`)];
}

/** A filter in the words of GitHub's search, after the qualifiers of what it lists, newest first by
 *  `sort`; its labels are all required. */
export function searchOf(
  path: string,
  qualifiers: string[],
  filter: IssueFilter | ChangeRequestFilter,
  sort: "created" | "updated",
): string {
  return [
    `repo:${path}`,
    ...qualifiers,
    ...(filter.author ? [`author:${filter.author}`] : []),
    ...(filter.assignee ? [`assignee:${filter.assignee}`] : []),
    ...filter.labels.map((label) => `label:"${label.replaceAll('"', "")}"`),
    ...titleTerms(filter.text),
    `sort:${sort}-desc`,
  ].join(" ");
}

export const PULL_REQUEST_STATE_TERMS: Record<ChangeRequestState, string[]> = {
  open: ["is:open"],
  merged: ["is:merged"],
  closed: ["is:closed", "is:unmerged"],
};

/** A change request filter in the words of GitHub's search (`searchOf`). */
export function pullRequestSearch(path: string, filter: ChangeRequestFilter, sort: "created" | "updated"): string {
  const qualifiers = [
    "is:pr",
    ...(filter.state ? PULL_REQUEST_STATE_TERMS[filter.state] : []),
    ...(filter.reviewer ? [`review-requested:${filter.reviewer}`] : []),
  ];
  return searchOf(path, qualifiers, filter, sort);
}

/** An issue filter in the words of GitHub's search (`searchOf`). Taken only for a filter with text: the
 *  search's index follows a change late, `issues` at once. */
export function issueSearch(path: string, filter: IssueFilter, sort: "created" | "updated"): string {
  return searchOf(path, ["is:issue", ...(filter.state ? [`is:${filter.state}`] : [])], filter, sort);
}
