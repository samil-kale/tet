import type {
  Issue,
  IssueChange,
  IssueEvent,
  IssueFilter,
  IssueMilestone,
  IssueNote,
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
  milestone?: { title: string } | null;
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

const ISSUE_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    issue(iid: $iid) {
      ${ISSUE_ROW}
      description
      milestone { title }
      notes(first: 100) { ${NOTE_PAGE} }
    }
  }
}`;

const NOTES_QUERY = `query($path: ID!, $iid: String!, $cursor: String) {
  project(fullPath: $path) { issue(iid: $iid) { notes(first: 100, after: $cursor) { ${NOTE_PAGE} } } }
}`;

const LABELS_QUERY = `query($path: ID!, $cursor: String) {
  project(fullPath: $path) {
    labels(first: 100, after: $cursor) {
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

/** What of a change `updateIssue` sets, in GitLab's words: labels by their ids, a milestone by its id,
 *  null taking it off. */
export function toIssueInput(path: string, number: number, change: IssueChange, labelIds: string[] | undefined): object {
  const { title, body, milestone, state } = change;
  return {
    projectPath: path,
    iid: String(number),
    title,
    description: body,
    milestoneId: milestone === undefined ? undefined : (milestone?.id ?? null),
    labelIds,
    stateEvent: state && (state === "open" ? "REOPEN" : "CLOSE"),
  };
}

/** A project's labels by name, with their ids. */
async function allLabels(send: GraphqlSend, path: string): Promise<{ id: string; name: string }[]> {
  const entries = await allNodes<{ id: string; title: string }>(send, LABELS_QUERY, { path }, (data) => {
    const { project } = data as { project: { labels: GraphqlPage<{ id: string; title: string }> } | null };
    return reached(project, path).labels;
  });
  return entries.map((entry) => ({ id: entry.id, name: entry.title }));
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
    // relations: the default leaves out who reaches the project through a group shared with it.
    const query = `query($path: ID!, $cursor: String) {
      project(fullPath: $path) {
        projectMembers(relations: [DIRECT, INHERITED, INVITED_GROUPS, SHARED_INTO_ANCESTORS], first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { user { username } }
        }
      }
    }`;
    type Member = { user: { username: string } | null };
    const entries = await allNodes<Member>(sender(host, token), query, { path }, (data) => {
      const { project } = data as { project: { projectMembers: GraphqlPage<Member> } | null };
      return reached(project, path).projectMembers;
    });
    return entries.flatMap((entry) => entry.user?.username ?? []);
  },

  async readIssue({ host, token, path }, number) {
    const send = sender(host, token);
    const url = `${projectUrl(host, path)}/issues/${number}`;
    const iid = String(number);
    const [issue, labels, states, milestones] = await Promise.all([
      send(ISSUE_QUERY, { path, iid }),
      getPaged(`${url}/resource_label_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_state_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_milestone_events?per_page=100`, headers(token)),
    ]);
    const { project } = issue as { project: { issue: (GitLabIssue & { notes: GraphqlPage<GitLabNote> }) | null } | null };
    const found = reachedIssue(project, path, number);
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
      assignees: found.assignees.nodes.map((assignee) => assignee.username),
      milestone: found.milestone?.title,
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

  async listMilestones({ host, token, path }) {
    // includeAncestors: those of its groups can be set as well.
    const query = `query($path: ID!, $cursor: String) {
      project(fullPath: $path) {
        milestones(first: 100, after: $cursor, state: active, includeAncestors: true) {
          pageInfo { hasNextPage endCursor }
          nodes { id title }
        }
      }
    }`;
    return allNodes<IssueMilestone>(sender(host, token), query, { path }, (data) => {
      const { project } = data as { project: { milestones: GraphqlPage<IssueMilestone> } | null };
      return reached(project, path).milestones;
    });
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
    const send = sender(host, token);
    const { assignees, ...rest } = change;
    if (assignees !== undefined) {
      await mutate(send, "issueSetAssignees", "IssueSetAssigneesInput", {
        projectPath: path,
        iid: String(number),
        assigneeUsernames: assignees,
      });
    }
    if (Object.values(rest).some((value) => value !== undefined)) {
      const labelIds = rest.labels && idsByName(rest.labels, await allLabels(send, path), "label");
      await mutate(send, "updateIssue", "UpdateIssueInput", toIssueInput(path, number, rest, labelIds));
    }
  },
};
