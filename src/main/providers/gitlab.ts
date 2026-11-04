import type {
  Issue,
  IssueChange,
  IssueEvent,
  IssueFilter,
  IssueMilestone,
  IssueNote,
  RemoteRepository,
} from "../../shared/types/providers";
import { fetchOk, getJson, getPaged, sendDelete, sendJson, type GitProvider } from "./provider";

function apiBase(host: string): string {
  return `https://${host}/api/v4`;
}

function headers(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token };
}

interface GitLabProject {
  path_with_namespace: string;
  path: string;
  http_url_to_repo: string;
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
  id: number;
  /** What GitLab wrote itself (a label added, an assignee changed), not a comment. */
  system: boolean;
  author: GitLabUser;
  created_at: string;
  body: string;
}

export interface GitLabMember extends GitLabUser {
  id: number;
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

/** A change in GitLab's words: labels as one list, assignees by id. Refuses a login no member has,
 *  so an assignee is not dropped unseen. */
export function toIssueUpdate(change: IssueChange, members: GitLabMember[]): object {
  return {
    title: change.title,
    description: change.body,
    state_event: change.state && (change.state === "open" ? "reopen" : "close"),
    // 0 takes it off.
    milestone_id: change.milestone === undefined ? undefined : (change.milestone?.id ?? 0),
    labels: change.labels?.join(","),
    assignee_ids: change.assignees?.map((login) => {
      const member = members.find((candidate) => candidate.username === login);
      if (!member) {
        throw new Error(`${login} is no member of this project`);
      }
      return member.id;
    }),
  };
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

export function issuesUrl(host: string, path: string, filter: IssueFilter): string {
  const query = new URLSearchParams({ per_page: "100", order_by: "created_at", sort: "desc" });
  if (filter.state) {
    query.set("state", filter.state === "open" ? "opened" : "closed");
  }
  if (filter.author) {
    query.set("author_username", filter.author);
  }
  if (filter.assignee) {
    query.set("assignee_username", filter.assignee);
  }
  if (filter.labels.length > 0) {
    query.set("labels", filter.labels.join(","));
  }
  return `${projectUrl(host, path)}/issues?${query.toString()}`;
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
    const user = (await getJson(`${apiBase(host)}/user`, headers(token))) as { username?: unknown };
    if (typeof user.username !== "string" || user.username === "") {
      throw new Error("The API answered without a username");
    }
    return user.username;
  },

  async listRepositories(host, token) {
    // membership=true: without it a self-hosted instance answers with everything it can see.
    // simple=true: the full record's extra fields (permissions, statistics, owner, _links) are not read.
    const url = `${apiBase(host)}/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true`;
    const entries = (await getPaged(url, headers(token))) as GitLabProject[];
    return entries.map((entry): RemoteRepository => ({
      fullName: entry.path_with_namespace,
      name: entry.path,
      cloneUrl: entry.http_url_to_repo,
    }));
  },

  async listIssues(host, token, path, filter) {
    const entries = (await getPaged(issuesUrl(host, path, filter), headers(token))) as GitLabIssue[];
    return entries.map(toIssue);
  },

  async listLabels(host, token, path) {
    const entries = (await getPaged(`${projectUrl(host, path)}/labels?per_page=100`, headers(token))) as { name: string }[];
    return entries.map((entry) => entry.name);
  },

  async listPeople(host, token, path) {
    // members/all: with those of its parent groups, who can be assigned as well.
    const entries = (await getPaged(`${projectUrl(host, path)}/members/all?per_page=100`, headers(token))) as GitLabUser[];
    return entries.map((entry) => entry.username);
  },

  async readIssue(host, token, path, number) {
    const url = `${projectUrl(host, path)}/issues/${number}`;
    const [issue, notes, labels, states, milestones] = await Promise.all([
      getJson(url, headers(token)),
      getPaged(`${url}/notes?per_page=100&order_by=created_at&sort=asc`, headers(token)),
      getPaged(`${url}/resource_label_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_state_events?per_page=100`, headers(token)),
      getPaged(`${url}/resource_milestone_events?per_page=100`, headers(token)),
    ]);
    const entry = issue as GitLabIssue;
    const entries = notes as GitLabNote[];
    const resources = [...labels, ...states, ...milestones] as GitLabResourceEvent[];
    return {
      ...toIssue(entry),
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

  addComment(host, token, path, number, body) {
    return sendJson("POST", `${projectUrl(host, path)}/issues/${number}/notes`, headers(token), { body });
  },

  async listMilestones(host, token, path) {
    // include_ancestors: those of its groups can be set as well.
    const url = `${projectUrl(host, path)}/milestones?state=active&include_ancestors=true&per_page=100`;
    const entries = (await getPaged(url, headers(token))) as IssueMilestone[];
    return entries.map((entry): IssueMilestone => ({ id: entry.id, title: entry.title }));
  },

  async createIssue(host, token, path, title, body) {
    const response = await fetchOk(
      `${projectUrl(host, path)}/issues`,
      { ...headers(token), "Content-Type": "application/json" },
      { method: "POST", body: JSON.stringify({ title, description: body }) },
    );
    return ((await response.json()) as { iid: number }).iid;
  },

  editComment(host, token, path, number, id, body) {
    return sendJson("PUT", `${projectUrl(host, path)}/issues/${number}/notes/${id}`, headers(token), { body });
  },

  deleteComment(host, token, path, number, id) {
    return sendDelete(`${projectUrl(host, path)}/issues/${number}/notes/${id}`, headers(token));
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
    const members =
      change.assignees === undefined
        ? []
        : ((await getPaged(`${projectUrl(host, path)}/members/all?per_page=100`, headers(token))) as GitLabMember[]);
    await sendJson("PUT", `${projectUrl(host, path)}/issues/${number}`, headers(token), toIssueUpdate(change, members));
  },
};
