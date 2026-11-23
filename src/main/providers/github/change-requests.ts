import {
  type GitProviderChangeRequests,
  ApiError,
  firstNodes,
  type GraphqlPage,
  checksText,
  reached,
  allNodes,
  ownTotal,
} from "../provider";
import { sender, repositoryOf, repositoryIds, mutate, readPullRequestNode, pullRequestName } from "./api";
import { pullRequestFields, updatePullRequestWrite } from "./fields";
import {
  type GitHubPullRequest,
  ownPullRequest,
  type GitHubPullRequestRow,
  fromOwnBranch,
  toChangeRequestRow,
  checksOf,
  type GitHubPullRequestDetail,
  type GitHubComment,
  type GitHubEvent,
  type GitHubReviewThread,
  avatarsOf,
  assigneesOf,
  toPullRequestEvents,
  toPullRequestFields,
  toNote,
  reviewNotes,
  toReviewThreads,
  checkListOf,
  blockersOf,
  reviewersOf,
  githubState,
  defaultMergeMethod,
} from "./mapping";
import {
  PULL_REQUESTS_QUERY,
  pullRequestSearch,
  PULL_REQUESTS_LATEST_QUERY,
  PULL_REQUEST_QUERY,
  PULL_REQUEST_COMMENTS_QUERY,
  PULL_REQUEST_TIMELINE_QUERY,
  PULL_REQUEST_REVIEW_THREADS_QUERY,
} from "./queries";

export const githubChangeRequests: GitProviderChangeRequests = {
  kind: { noun: "pull request", prefix: "#", checks: "checks", selfApproval: false, deletesSourceBranch: false },

  async find({ host, token, path }, head) {
    // `headRefName` matches a fork's branch of that name too, so its repository is read alongside.
    // Paged whole, as forks' pull requests of that branch name may come first.
    const query = `query($owner: String!, $name: String!, $head: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $head, states: OPEN, first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { number url headRepository { nameWithOwner } }
        }
      }
    }`;
    const found = await allNodes<GitHubPullRequest>(sender(host, token), query, { ...repositoryOf(path), head }, (data) => {
      const repository = (data as { repository: { pullRequests: GraphqlPage<GitHubPullRequest> } | null }).repository;
      if (!repository) {
        throw new ApiError(404, `${path} was not found, or this account cannot read it`);
      }
      return repository.pullRequests;
    });
    return ownPullRequest(found, path);
  },

  async create({ host, token, path }, { head, base, title, body, draft }) {
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
  async approve({ host, token, path }, number) {
    const send = sender(host, token);
    const { id } = await readPullRequestNode(send, path, number);
    await mutate(send, {
      mutation: "addPullRequestReview",
      inputType: "AddPullRequestReviewInput",
      input: { pullRequestId: id, event: "APPROVE" },
    });
  },

  async autoMerge({ host, token, path }, number, squash) {
    const send = sender(host, token);
    const pullRequest = await readPullRequestNode(send, path, number);
    await mutate(send, {
      mutation: "enablePullRequestAutoMerge",
      inputType: "EnablePullRequestAutoMergeInput",
      input: { pullRequestId: pullRequest.id, mergeMethod: squash ? "SQUASH" : "MERGE" },
    });
  },

  async list({ host, token, path }, filter, limit, after) {
    const { items, ...rest } = await firstNodes<GitHubPullRequestRow>(
      sender(host, token),
      PULL_REQUESTS_QUERY,
      { query: pullRequestSearch(path, filter, "created") },
      (data) => (data as { search: GraphqlPage<GitHubPullRequestRow> }).search,
      { limit, after, keep: (entry) => fromOwnBranch(entry, path) },
    );
    return { items: items.map(toChangeRequestRow), ...rest };
  },

  async readLatest({ host, token, path }, filter) {
    type Latest = Pick<GitHubPullRequestRow, "number" | "updatedAt" | "headRepository"> & {
      head: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
    };
    let found = 0;
    const nodes = await allNodes<Latest>(
      sender(host, token),
      PULL_REQUESTS_LATEST_QUERY,
      { query: pullRequestSearch(path, filter, "updated") },
      (data) => {
        const { search } = data as { search: GraphqlPage<Latest> & { issueCount: number } };
        found = search.issueCount;
        return search;
      },
    );
    const own = nodes.filter((entry) => fromOwnBranch(entry, path));
    return {
      total: ownTotal(own.length, nodes.length, found),
      updatedAt: own[0]?.updatedAt,
      checks: checksText(own.map((entry) => ({ number: entry.number, checks: checksOf(entry.head.nodes[0]?.commit.statusCheckRollup) }))),
    };
  },

  async read({ host, token, path }, number) {
    const send = sender(host, token);
    const variables = { ...repositoryOf(path), number };
    const data = (await send(PULL_REQUEST_QUERY, variables)) as { repository: { pullRequest: GitHubPullRequestDetail | null } | null };
    const found = reached(data.repository?.pullRequest, pullRequestName(path, number));
    type Answer = {
      repository: {
        pullRequest: {
          comments: GraphqlPage<GitHubComment>;
          timelineItems: GraphqlPage<GitHubEvent>;
          reviewThreads: GraphqlPage<GitHubReviewThread>;
        };
      };
    };
    const [laterComments, laterItems, laterThreads] = await Promise.all([
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
      found.reviewThreads.pageInfo.hasNextPage
        ? allNodes<GitHubReviewThread>(
            send,
            PULL_REQUEST_REVIEW_THREADS_QUERY,
            { ...variables, cursor: found.reviewThreads.pageInfo.endCursor },
            (answer) => (answer as Answer).repository.pullRequest.reviewThreads,
          )
        : [],
    ]);
    const comments = [...found.commentPage.nodes, ...laterComments];
    const items = [...found.timelineItems.nodes, ...laterItems];
    const threads = [...found.reviewThreads.nodes, ...laterThreads];
    const row = toChangeRequestRow(found);
    const rollup = found.head.nodes[0]?.commit.statusCheckRollup;
    return {
      ...row,
      provider: "github",
      kind: githubChangeRequests.kind,
      avatars: avatarsOf([
        found.author,
        ...assigneesOf(found),
        ...found.participants.nodes,
        ...found.reviewRequests.nodes.map((request) => request.requestedReviewer),
        ...found.latestReviews.nodes.map((review) => review.author),
        ...comments.map((comment) => comment.author),
        ...items.map((item) => item.actor),
        ...threads.flatMap((thread) => thread.comments.nodes.map((comment) => comment.author)),
      ]),
      events: toPullRequestEvents(items),
      fields: toPullRequestFields(found),
      body: found.body,
      notes: [...comments.map(toNote), ...reviewNotes(items)],
      reviewThreads: toReviewThreads(threads),
      status: {
        checks: checkListOf(rollup),
        checksUrl: rollup ? `${found.url}/checks` : undefined,
        blockers: blockersOf(found),
        // GitHub says that approvals are due, not how many: that is the branch protection's, which only an admin reads.
        approvalsOutstanding: found.reviewDecision === "REVIEW_REQUIRED" ? {} : undefined,
        conflicts: found.mergeable === "CONFLICTING",
        autoMerge: found.autoMergeRequest !== null,
        // GitHub refuses auto-merge for one that can merge at once, which `viewerCanEnableAutoMerge`
        // leaves out: that is `MERGEABLE` and neither blocked nor behind its base.
        autoMergeable:
          found.viewerCanEnableAutoMerge &&
          (found.mergeable !== "MERGEABLE" || found.mergeStateStatus === "BLOCKED" || found.mergeStateStatus === "BEHIND"),
        reviewers: reviewersOf(found),
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

  async readUpdate({ host, token, path }, number) {
    const found = await readPullRequestNode<Pick<GitHubPullRequestRow, "updatedAt" | "head">>(
      sender(host, token),
      path,
      number,
      "updatedAt head: commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }",
    );
    return { updatedAt: found.updatedAt, checks: checksOf(found.head.nodes[0]?.commit.statusCheckRollup) };
  },

  listOptions: pullRequestFields.listOptions,

  setField: pullRequestFields.setField,

  async update({ host, token, path }, number, { title, body, state }) {
    const send = sender(host, token);
    const { id } = await readPullRequestNode(send, path, number);
    await mutate(send, updatePullRequestWrite({ pullRequestId: id, title, body, state: state && githubState(state) }));
  },

  async comment({ host, token, path }, number, body) {
    const send = sender(host, token);
    const { id } = await readPullRequestNode(send, path, number);
    await mutate(send, { mutation: "addComment", inputType: "AddCommentInput", input: { subjectId: id, body } });
  },

  async merge({ host, token, path }, number, whenChecksPass) {
    const send = sender(host, token);
    const { id, baseRepository } = await readPullRequestNode<{
      baseRepository: { mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean };
    }>(send, path, number, "baseRepository { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }");
    const input = { pullRequestId: id, mergeMethod: defaultMergeMethod(baseRepository) };
    await mutate(
      send,
      whenChecksPass
        ? { mutation: "enablePullRequestAutoMerge", inputType: "EnablePullRequestAutoMergeInput", input }
        : { mutation: "mergePullRequest", inputType: "MergePullRequestInput", input },
    );
  },
};
