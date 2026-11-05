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

function graphql(host: string, token: string, query: string, variables: object = {}): Promise<unknown> {
  return sendGraphql(`https://${host}/api/graphql`, { Authorization: `Bearer ${token}` }, query, variables);
}

function sender(host: string, token: string): GraphqlSend {
  return (query, variables) => graphql(host, token, query, variables);
}

/** A project GraphQL answers null for says neither that it is missing nor that the token cannot read
 *  it: REST's 404 for both, which hands over to the next account. */
function reached<T>(found: T | null | undefined, what: string): T {
  if (found === null || found === undefined) {
    throw new ApiError(404, `${what} was not found, or this account cannot read it`);
  }
  return found;
}

/** What a mutation answered, which says what it refused in a field of its own. */
export function mutationError(result: { errors?: string[] } | null | undefined): string | undefined {
  if (!result) {
    return "GitLab answered the change with nothing";
  }
  return result.errors && result.errors.length > 0 ? result.errors.join("; ") : undefined;
}

/** One mutation, answering what it was asked to select beside its `errors`. */
async function mutate<T>(host: string, token: string, name: string, inputType: string, input: object, selection = ""): Promise<T> {
  const query = `mutation($input: ${inputType}!) { ${name}(input: $input) { ${selection} errors } }`;
  const data = (await graphql(host, token, query, { input })) as Record<string, (T & { errors?: string[] }) | null> | null;
  const result = data?.[name];
  const refused = mutationError(result);
  if (refused !== undefined || !result) {
    throw new Error(refused);
  }
  return result;
}

interface GitLabUser {
  username: string;
  avatar_url: string | null;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  web_url: string;
  state: string;
  author: GitLabUser;
  assignees: GitLabUser[];
  user_notes_count: number;
  created_at: string;
  labels: string[];
  description: string | null;
  milestone?: { title: string } | null;
}

export interface GitLabNote {
  id: string;
  /** What GitLab wrote itself (a label added, an assignee changed), not a comment. */
  system: boolean;
  author: GitLabUser;
  created_at: string;
  body: string;
}

/** A user as GraphQL says it; an uploaded picture's URL is relative to the host. */
interface GitLabGraphqlUser {
  username: string;
  avatarUrl: string | null;
}

/** An issue as GraphQL says it; only one read alone has the last two. */
export interface GitLabGraphqlIssue {
  iid: string;
  title: string;
  webUrl: string;
  state: string;
  createdAt: string;
  userNotesCount: number;
  author: GitLabGraphqlUser;
  assignees: { nodes: GitLabGraphqlUser[] };
  labels: { nodes: { title: string }[] };
  description?: string | null;
  milestone?: { title: string } | null;
}

/** A note as GraphQL says it; `author` is null for a deleted account. */
export interface GitLabGraphqlNote {
  id: string;
  system: boolean;
  body: string;
  createdAt: string;
  author: GitLabGraphqlUser | null;
}

const ISSUE_ROW = `iid title webUrl state createdAt userNotesCount
  author { username avatarUrl }
  assignees(first: 100) { nodes { username avatarUrl } }
  labels(first: 100) { nodes { title } }`;

const NOTE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { id system body createdAt author { username avatarUrl } }`;

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

/** A user's picture as a whole URL, a Gravatar one where only its path is given. */
export function avatarUrlOf(host: string, avatarUrl: string | null): string | null {
  if (!avatarUrl || avatarUrl.startsWith("http")) {
    return avatarUrl;
  }
  return avatarUrl.startsWith("/avatar") ? `https://secure.gravatar.com${avatarUrl}?s=80&d=identicon` : `https://${host}${avatarUrl}`;
}

function userOf(host: string, person: GitLabGraphqlUser): GitLabUser {
  return { username: person.username, avatar_url: avatarUrlOf(host, person.avatarUrl) };
}

/** An issue read over GraphQL as `toIssue` takes it. */
export function fromGraphql(host: string, entry: GitLabGraphqlIssue): GitLabIssue {
  return {
    iid: Number(entry.iid),
    title: entry.title,
    web_url: entry.webUrl,
    state: entry.state,
    author: userOf(host, entry.author),
    assignees: entry.assignees.nodes.map((person) => userOf(host, person)),
    user_notes_count: entry.userNotesCount,
    created_at: entry.createdAt,
    labels: entry.labels.nodes.map((label) => label.title),
    description: entry.description ?? null,
    milestone: entry.milestone,
  };
}

/** A note read over GraphQL as `toNotes` and `toEvents` take it. */
export function noteFromGraphql(host: string, entry: GitLabGraphqlNote): GitLabNote {
  return {
    id: entry.id,
    system: entry.system,
    author: entry.author ? userOf(host, entry.author) : { username: "ghost", avatar_url: null },
    created_at: entry.createdAt,
    body: entry.body,
  };
}

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
async function allLabels(host: string, token: string, path: string): Promise<{ id: string; name: string }[]> {
  const entries = await allNodes<{ id: string; title: string }>(sender(host, token), LABELS_QUERY, { path }, (data) => {
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

/** Each user's picture by login, of those who have one. */
function avatarsOf(users: GitLabUser[]): Record<string, string> {
  const avatars: Record<string, string> = {};
  for (const user of users) {
    if (user.avatar_url) {
      avatars[user.username] = user.avatar_url;
    }
  }
  return avatars;
}

export function toIssue(entry: GitLabIssue): Issue {
  return {
    number: entry.iid,
    title: entry.title,
    url: entry.web_url,
    open: entry.state === "opened",
    author: entry.author.username,
    assignee: entry.assignees[0]?.username,
    comments: entry.user_notes_count,
    createdAt: entry.created_at,
    labels: entry.labels,
    avatars: avatarsOf([entry.author, ...entry.assignees]),
  };
}

/** The comments among an issue's notes. */
export function toNotes(entries: GitLabNote[]): IssueNote[] {
  return entries
    .filter((entry) => !entry.system)
    .map((entry) => ({ id: entry.id, author: entry.author.username, createdAt: entry.created_at, body: entry.body }));
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
      events.push({ actor: note.author.username, createdAt: note.created_at, kind: "text", text: note.body });
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
    const data = (await graphql(host, token, "{ currentUser { username } }")) as { currentUser: { username?: unknown } | null };
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

  async listIssues(host, token, path, filter) {
    const entries = await allNodes<GitLabGraphqlIssue>(sender(host, token), ISSUES_QUERY, issuesVariables(path, filter), (data) => {
      const { project } = data as { project: { issues: GraphqlPage<GitLabGraphqlIssue> } | null };
      return reached(project, path).issues;
    });
    return entries.map((entry) => toIssue(fromGraphql(host, entry)));
  },

  async listLabels(host, token, path) {
    return (await allLabels(host, token, path)).map((entry) => entry.name);
  },

  async listPeople(host, token, path) {
    const query = `query($path: ID!, $cursor: String) {
      project(fullPath: $path) {
        projectMembers(first: 100, after: $cursor) {
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

  async readIssue(host, token, path, number) {
    const url = `${projectUrl(host, path)}/issues/${number}`;
    const iid = String(number);
    const [issue, labels, states, milestones] = await Promise.all([
      graphql(host, token, ISSUE_QUERY, { path, iid }),
      getPaged(`${url}/resource_label_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_state_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_milestone_events?per_page=100`, headers(token)),
    ]);
    const { project } = issue as { project: { issue: (GitLabGraphqlIssue & { notes: GraphqlPage<GitLabGraphqlNote> }) | null } | null };
    const found = reached(reached(project, path).issue, `Issue #${number}`);
    const later = found.notes.pageInfo.hasNextPage
      ? await allNodes<GitLabGraphqlNote>(
          sender(host, token),
          NOTES_QUERY,
          { path, iid, cursor: found.notes.pageInfo.endCursor },
          (data) => {
            const answer = data as { project: { issue: { notes: GraphqlPage<GitLabGraphqlNote> } | null } | null };
            return reached(reached(answer.project, path).issue, `Issue #${number}`).notes;
          },
        )
      : [];
    const entry = fromGraphql(host, found);
    const entries = [...found.notes.nodes, ...later].map((note) => noteFromGraphql(host, note));
    const resources = [...labels, ...states, ...milestones] as GitLabResourceEvent[];
    return {
      ...toIssue(entry),
      provider: "gitlab",
      avatars: avatarsOf([
        entry.author,
        ...entry.assignees,
        ...entries.map((note) => note.author),
        ...resources.flatMap((event) => event.user ?? []),
      ]),
      events: toEvents(entries, labels as GitLabLabelEvent[], states as GitLabStateEvent[], milestones as GitLabMilestoneEvent[]),
      assignees: entry.assignees.map((assignee) => assignee.username),
      milestone: entry.milestone?.title,
      body: entry.description ?? "",
      notes: toNotes(entries),
    };
  },

  async readImage(host, token, path, source) {
    const upload = uploadOf(host, source);
    return upload && fetchOk(`${projectUrl(host, path)}/uploads/${upload.secret}/${upload.file}`, headers(token));
  },

  async addComment(host, token, path, number, body) {
    const query = "query($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { id } } }";
    const { project } = (await graphql(host, token, query, { path, iid: String(number) })) as {
      project: { issue: { id: string } | null } | null;
    };
    const { id } = reached(reached(project, path).issue, `Issue #${number}`);
    await mutate(host, token, "createNote", "CreateNoteInput", { noteableId: id, body });
  },

  async listMilestones(host, token, path) {
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

  async createIssue(host, token, path, title, body) {
    const { issue } = await mutate<{ issue: { iid: string } | null }>(
      host,
      token,
      "createIssue",
      "CreateIssueInput",
      { projectPath: path, title, description: body },
      "issue { iid }",
    );
    return Number(reached(issue, `The new issue of ${path}`).iid);
  },

  async editComment(host, token, _path, _number, id, body) {
    await mutate(host, token, "updateNote", "UpdateNoteInput", { id, body });
  },

  async deleteComment(host, token, _path, _number, id) {
    await mutate(host, token, "destroyNote", "DestroyNoteInput", { id });
  },

  deleteIssue(host, token, path, number) {
    return sendDelete(`${projectUrl(host, path)}/issues/${number}`, headers(token));
  },

  uploads: () => ({}),

  async uploadFile(host, token, path, name, bytes) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(bytes)]), name);
    const response = await fetchOk(`${projectUrl(host, path)}/uploads`, headers(token), { method: "POST", body: form });
    return ((await response.json()) as { markdown: string }).markdown;
  },

  async updateIssue(host, token, path, number, change) {
    const { assignees, ...rest } = change;
    if (assignees !== undefined) {
      await mutate(host, token, "issueSetAssignees", "IssueSetAssigneesInput", {
        projectPath: path,
        iid: String(number),
        assigneeUsernames: assignees,
      });
    }
    if (Object.values(rest).some((value) => value !== undefined)) {
      const labelIds = rest.labels && idsByName(rest.labels, await allLabels(host, token, path), "label");
      await mutate(host, token, "updateIssue", "UpdateIssueInput", toIssueInput(path, number, rest, labelIds));
    }
  },
};
