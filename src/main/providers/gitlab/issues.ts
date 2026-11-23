import {
  type GitProviderIssues,
  firstNodes,
  type GraphqlPage,
  reached,
  getPaged,
  allNodes,
  fetchUploadOk,
  fieldMethods,
  sendDelete,
  fetchOk,
} from "../provider";
import { sender, reachedIssue, projectUrl, headers, uploadOf, mutate } from "./api";
import { fieldHandlerOf, readExtraWidgets, readTarget } from "./fields";
import {
  type GitLabIssue,
  toIssue,
  type GitLabNote,
  type GitLabWorkItem,
  toEvents,
  type GitLabLabelEvent,
  type GitLabStateEvent,
  type GitLabMilestoneEvent,
  toFields,
  toNotes,
  toIssueInput,
} from "./mapping";
import { ISSUES_QUERY, issuesVariables, LATEST_QUERY, ISSUE_QUERY, NOTES_QUERY } from "./queries";

export const gitlabIssues: GitProviderIssues = {
  async list({ host, token, path }, filter, limit, after) {
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

  async readUpdate({ host, token, path }, number) {
    const query = "query($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { updatedAt } } }";
    const { project } = (await sender(host, token)(query, { path, iid: String(number) })) as {
      project: { issue: { updatedAt: string } | null } | null;
    };
    return reachedIssue(project, path, number);
  },

  async read({ host, token, path }, number) {
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

  uploadName(host, source) {
    const upload = uploadOf(host, source);
    return upload && decodeURIComponent(upload.file);
  },

  async readUpload({ host, token, path }, source) {
    const upload = uploadOf(host, source);
    return upload && fetchUploadOk(`${projectUrl(host, path)}/uploads/${upload.secret}/${upload.file}`, headers(token));
  },

  internalNotes: true,

  async comment({ host, token, path }, number, body, internal) {
    const send = sender(host, token);
    const query = "query($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { id } } }";
    const { project } = (await send(query, { path, iid: String(number) })) as { project: { issue: { id: string } | null } | null };
    const { id } = reachedIssue(project, path, number);
    await mutate(send, { mutation: "createNote", inputType: "CreateNoteInput", input: { noteableId: id, body, internal } });
  },

  ...fieldMethods({ graphql: sender, handlerOf: (_send, _path, fieldId) => fieldHandlerOf(fieldId), readTarget, mutate }),

  confidential: true,

  async create({ host, token, path }, title, body, confidential) {
    const { issue } = await mutate<{ issue: { iid: string } | null }>(
      sender(host, token),
      { mutation: "createIssue", inputType: "CreateIssueInput", input: { projectPath: path, title, description: body, confidential } },
      "issue { iid }",
    );
    return Number(reached(issue, `The new issue of ${path}`).iid);
  },

  delete({ host, token, path }, number) {
    return sendDelete(`${projectUrl(host, path)}/issues/${number}`, headers(token));
  },

  uploads: () => ({}),

  async uploadFile({ host, token, path }, name, bytes) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(bytes)]), name);
    const response = await fetchOk(`${projectUrl(host, path)}/uploads`, headers(token), { method: "POST", body: form });
    return ((await response.json()) as { markdown: string }).markdown;
  },

  async update({ host, token, path }, number, change) {
    await mutate(sender(host, token), {
      mutation: "updateIssue",
      inputType: "UpdateIssueInput",
      input: toIssueInput(path, number, change),
    });
  },
};
