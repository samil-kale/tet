import {
  allNodes,
  checksText,
  fetchOk,
  firstNodes,
  getPaged,
  type GitProviderChangeRequests,
  type GraphqlPage,
  type GraphqlSend,
  reached,
} from "../provider";
import { sender, mutate, projectUrl, headers } from "./api";
import { mergeRequestFields } from "./fields";
import {
  type GitLabMergeRequest,
  ownMergeRequest,
  type GitLabMergeRequestRow,
  fromOwnProject,
  toChangeRequestRow,
  pipelineChecks,
  type GitLabMergeRequestDetail,
  type GitLabNote,
  toReviewThreads,
  toEvents,
  type GitLabLabelEvent,
  type GitLabStateEvent,
  type GitLabMilestoneEvent,
  toMergeRequestFields,
  toNotes,
  jobChecksOf,
  blockersOf,
  reviewersOf,
} from "./mapping";
import {
  MERGE_REQUESTS_QUERY,
  mergeRequestsVariables,
  MERGE_REQUESTS_LATEST_QUERY,
  MERGE_REQUEST_QUERY,
  MERGE_REQUEST_NOTES_QUERY,
} from "./queries";

/** A merge request by its number, as far as `selection` reads it (`readWorkItem`'s for one). */
export async function readMergeRequest<T>(send: GraphqlSend, path: string, number: number, selection: string): Promise<T> {
  const query = `query($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) { ${selection} } } }`;
  const { project } = (await send(query, { path, iid: String(number) })) as { project: { mergeRequest: T | null } | null };
  return reached(reached(project, path).mergeRequest, `Merge request !${number}`);
}

export const gitlabChangeRequests: GitProviderChangeRequests = {
  kind: { noun: "merge request", prefix: "!", checks: "pipeline", selfApproval: true, deletesSourceBranch: true },

  async find({ host, token, path }, head) {
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

  async create({ host, token, path }, { head, base, title, body, draft, deleteSourceBranch }) {
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

  async approve({ host, token, path }, number) {
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

  async autoMerge({ host, token, path }, number, squash) {
    const send = sender(host, token);
    // The commit it merges, which the mutation takes to refuse a branch pushed meanwhile.
    const { diffHeadSha } = await readMergeRequest<{ diffHeadSha: string | null }>(send, path, number, "diffHeadSha");
    await mutate(send, {
      mutation: "mergeRequestAccept",
      inputType: "MergeRequestAcceptInput",
      input: { projectPath: path, iid: String(number), sha: diffHeadSha, strategy: "MERGE_WHEN_CHECKS_PASS", squash },
    });
  },

  async list({ host, token, path }, filter, limit, after) {
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

  async readLatest({ host, token, path }, filter) {
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

  async read({ host, token, path }, number) {
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
      kind: gitlabChangeRequests.kind,
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
        // The strategy `changeRequests.merge` sets: GitLab offers it only while the merge request cannot merge at once.
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

  async readUpdate({ host, token, path }, number) {
    const found = await readMergeRequest<Pick<GitLabMergeRequestRow, "updatedAt" | "headPipeline">>(
      sender(host, token),
      path,
      number,
      "updatedAt headPipeline { status }",
    );
    return { updatedAt: found.updatedAt, checks: pipelineChecks(found.headPipeline) };
  },

  listOptions: mergeRequestFields.listOptions,

  setField: mergeRequestFields.setField,

  async update({ host, token, path }, number, { title, body, state }) {
    await mutate(sender(host, token), {
      mutation: "mergeRequestUpdate",
      inputType: "MergeRequestUpdateInput",
      input: { projectPath: path, iid: String(number), title, description: body, state: state && (state === "open" ? "OPENED" : "CLOSED") },
    });
  },

  async comment({ host, token, path }, number, body) {
    const send = sender(host, token);
    const { id } = await readMergeRequest<{ id: string }>(send, path, number, "id");
    await mutate(send, { mutation: "createNote", inputType: "CreateNoteInput", input: { noteableId: id, body } });
  },

  async merge({ host, token, path }, number, whenChecksPass) {
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
};
