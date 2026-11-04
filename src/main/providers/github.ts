import type {
  Issue,
  IssueChange,
  IssueEvent,
  IssueFilter,
  IssueMilestone,
  IssueNote,
  RemoteRepository,
} from "../../shared/types/providers";
import { ApiError, fetchOk, getJson, getPaged, sendDelete, sendJson, type GitProvider } from "./provider";

/** github.com's API lives on its own subdomain; GitHub Enterprise serves it under /api/v3. */
function apiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

/** GitHub rejects requests without a User-Agent. */
function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tet",
  };
}

/** With each text's `body_html` too, whose images of a private repository carry their own signed
 *  URLs: the ones in `body` answer no request, with a token or without. */
function fullHeaders(token: string): Record<string, string> {
  return { ...headers(token), Accept: "application/vnd.github.full+json" };
}

interface GitHubRepository {
  full_name: string;
  name: string;
  clone_url: string;
}

/** `user` is null for a deleted account. */
interface GitHubUser {
  login: string;
  avatar_url: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  user: GitHubUser | null;
  assignees: GitHubUser[];
  comments: number;
  created_at: string;
  labels: (string | { name: string })[];
  body: string | null;
  body_html?: string;
  milestone?: { title: string } | null;
  /** Present on a pull request, which the issues listing holds too. */
  pull_request?: unknown;
}

interface GitHubComment {
  id: number;
  user: GitHubUser | null;
  created_at: string;
  body: string | null;
  body_html?: string;
}

/** An entry of an issue's timeline; which of the rest it has goes by its `event`. */
export interface GitHubTimelineEntry {
  event: string;
  actor?: GitHubUser | null;
  created_at: string;
  assignee?: GitHubUser | null;
  label?: { name: string };
  milestone?: { title: string };
  rename?: { from: string; to: string };
  source?: { issue?: { number: number; title: string; html_url: string } };
}

/** What a timeline entry shows, for those the tab draws; a comment is read on its own. */
function toEvent(entry: GitHubTimelineEntry): IssueEvent | undefined {
  const base = { actor: entry.actor?.login ?? "ghost", createdAt: entry.created_at };
  switch (entry.event) {
    case "closed":
    case "reopened":
      return { ...base, kind: entry.event };
    case "assigned":
    case "unassigned":
      return entry.assignee ? { ...base, kind: entry.event, login: entry.assignee.login } : undefined;
    case "labeled":
    case "unlabeled":
      return entry.label && { ...base, kind: entry.event, label: entry.label.name };
    case "milestoned":
    case "demilestoned":
      return entry.milestone && { ...base, kind: entry.event, milestone: entry.milestone.title };
    case "renamed":
      return entry.rename && { ...base, kind: "renamed", from: entry.rename.from, to: entry.rename.to };
    case "cross-referenced": {
      const issue = entry.source?.issue;
      return issue && { ...base, kind: "linked", number: issue.number, title: issue.title, url: issue.html_url };
    }
    default:
      return undefined;
  }
}

export function toEvents(entries: GitHubTimelineEntry[]): IssueEvent[] {
  return entries.map(toEvent).filter((event) => event !== undefined);
}

/** A change in GitHub's words: a milestone by its number, null taking it off. */
export function toIssueUpdate({ milestone, ...rest }: IssueChange): object {
  return milestone === undefined ? rest : { ...rest, milestone: milestone?.id ?? null };
}

/** github.com's GraphQL lives on its own subdomain; GitHub Enterprise serves it under /api. */
function graphqlUrl(host: string): string {
  return host === "github.com" ? "https://api.github.com/graphql" : `https://${host}/api/graphql`;
}

/** What a GraphQL answer refused, which it says under a status of 200. */
export function graphqlError(body: { errors?: { message?: string }[] }): string | undefined {
  const messages = body.errors?.map((error) => error.message ?? "").filter((message) => message !== "");
  return body.errors === undefined || body.errors.length === 0 ? undefined : messages?.join("; ") || "GitHub refused the request";
}

/** The only files its upload takes from a token, by extension: it refuses any other type. */
const UPLOAD_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** What the upload takes a file as, off its name; undefined for one it refuses. */
export function contentTypeOf(name: string): string | undefined {
  return UPLOAD_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
}

/** What shows an upload in a text: an image by name, a video by its bare URL. */
export function uploadMarkdown(name: string, url: string, contentType: string): string {
  return contentType.startsWith("video/") ? url : `![${name.replace(/[\\[\]]/g, "\\$&")}](${url})`;
}

/** github.com and its data residency tenants have the upload; a GitHub Enterprise Server does not. */
function hasUpload(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

export function issuesUrl(host: string, path: string, filter: IssueFilter): string {
  // Without `state` the host lists only open issues.
  const query = new URLSearchParams({ per_page: "100", sort: "created", direction: "desc", state: filter.state ?? "all" });
  if (filter.author) {
    query.set("creator", filter.author);
  }
  if (filter.assignee) {
    query.set("assignee", filter.assignee);
  }
  if (filter.labels.length > 0) {
    query.set("labels", filter.labels.join(","));
  }
  return `${apiBase(host)}/repos/${path}/issues?${query.toString()}`;
}

/** Each user's picture by login, at about twice the size it is drawn: unasked, GitHub sends the whole. */
function avatarsOf(users: (GitHubUser | null)[]): Record<string, string> {
  const avatars: Record<string, string> = {};
  for (const user of users) {
    const url = user && URL.parse(user.avatar_url);
    if (user && url) {
      url.searchParams.set("s", "40");
      avatars[user.login] = url.href;
    }
  }
  return avatars;
}

export function toIssue(entry: GitHubIssue): Issue {
  return {
    number: entry.number,
    title: entry.title,
    url: entry.html_url,
    open: entry.state === "open",
    author: entry.user?.login ?? "ghost",
    assignee: entry.assignees[0]?.login,
    comments: entry.comments,
    createdAt: entry.created_at,
    labels: entry.labels.map((label) => (typeof label === "string" ? label : label.name)),
    avatars: avatarsOf([entry.user, ...entry.assignees]),
  };
}

function toNote(entry: GitHubComment): IssueNote {
  return {
    id: entry.id,
    author: entry.user?.login ?? "ghost",
    createdAt: entry.created_at,
    body: entry.body ?? "",
    bodyHtml: entry.body_html,
  };
}

export const github: GitProvider = {
  async validate(host, token) {
    const user = (await getJson(`${apiBase(host)}/user`, headers(token))) as { login?: unknown };
    if (typeof user.login !== "string" || user.login === "") {
      throw new Error("The API answered without a login");
    }
    return user.login;
  },

  async listRepositories(host, token) {
    // The default affiliation covers owned, collaborated and organization repositories.
    const url = `${apiBase(host)}/user/repos?per_page=100&sort=pushed`;
    const entries = (await getPaged(url, headers(token))) as GitHubRepository[];
    return entries.map((entry): RemoteRepository => ({
      fullName: entry.full_name,
      name: entry.name,
      cloneUrl: entry.clone_url,
    }));
  },

  async listIssues(host, token, path, filter) {
    const entries = (await getPaged(issuesUrl(host, path, filter), headers(token))) as GitHubIssue[];
    return entries.filter((entry) => entry.pull_request === undefined).map(toIssue);
  },

  async listLabels(host, token, path) {
    const entries = (await getPaged(`${apiBase(host)}/repos/${path}/labels?per_page=100`, headers(token))) as { name: string }[];
    return entries.map((entry) => entry.name);
  },

  async listPeople(host, token, path) {
    const entries = (await getPaged(`${apiBase(host)}/repos/${path}/assignees?per_page=100`, headers(token))) as GitHubUser[];
    return entries.map((entry) => entry.login);
  },

  async readIssue(host, token, path, number) {
    const url = `${apiBase(host)}/repos/${path}/issues/${number}`;
    const [issue, comments, timeline] = await Promise.all([
      getJson(url, fullHeaders(token)),
      getPaged(`${url}/comments?per_page=100`, fullHeaders(token)),
      getPaged(`${url}/timeline?per_page=100`, headers(token)),
    ]);
    const entry = issue as GitHubIssue;
    const notes = comments as GitHubComment[];
    const entries = timeline as GitHubTimelineEntry[];
    return {
      ...toIssue(entry),
      avatars: avatarsOf([entry.user, ...entry.assignees, ...notes.map((note) => note.user), ...entries.map((item) => item.actor ?? null)]),
      events: toEvents(entries),
      assignees: entry.assignees.map((assignee) => assignee.login),
      milestone: entry.milestone?.title,
      body: entry.body ?? "",
      bodyHtml: entry.body_html,
      notes: notes.map(toNote),
    };
  },

  // `body_html`'s signed URLs take no token.
  readImage: () => Promise.resolve(undefined),

  addComment(host, token, path, number, body) {
    return sendJson("POST", `${apiBase(host)}/repos/${path}/issues/${number}/comments`, headers(token), { body });
  },

  updateIssue(host, token, path, number, change) {
    return sendJson("PATCH", `${apiBase(host)}/repos/${path}/issues/${number}`, headers(token), toIssueUpdate(change));
  },

  async listMilestones(host, token, path) {
    const entries = (await getPaged(`${apiBase(host)}/repos/${path}/milestones?state=open&per_page=100`, headers(token))) as {
      number: number;
      title: string;
    }[];
    return entries.map((entry): IssueMilestone => ({ id: entry.number, title: entry.title }));
  },

  async createIssue(host, token, path, title, body) {
    const response = await fetchOk(
      `${apiBase(host)}/repos/${path}/issues`,
      { ...headers(token), "Content-Type": "application/json" },
      { method: "POST", body: JSON.stringify({ title, body }) },
    );
    return ((await response.json()) as { number: number }).number;
  },

  editComment(host, token, path, _number, id, body) {
    return sendJson("PATCH", `${apiBase(host)}/repos/${path}/issues/comments/${id}`, headers(token), { body });
  },

  deleteComment(host, token, path, _number, id) {
    return sendDelete(`${apiBase(host)}/repos/${path}/issues/comments/${id}`, headers(token));
  },

  // Its REST has no way to delete an issue; GraphQL does, by the issue's node id.
  async deleteIssue(host, token, path, number) {
    const issue = (await getJson(`${apiBase(host)}/repos/${path}/issues/${number}`, headers(token))) as { node_id: string };
    const response = await fetchOk(
      graphqlUrl(host),
      { ...headers(token), "Content-Type": "application/json" },
      {
        method: "POST",
        body: JSON.stringify({
          query: "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }",
          variables: { id: issue.node_id },
        }),
      },
    );
    const refused = graphqlError((await response.json()) as { errors?: { message?: string }[] });
    if (refused !== undefined) {
      throw new Error(refused);
    }
  },

  uploads: (host) => (hasUpload(host) ? { extensions: Object.keys(UPLOAD_TYPES) } : undefined),

  // Undocumented, and the one GitHub's own CLI uploads with; the bytes go as they are.
  async uploadFile(host, token, path, name, bytes) {
    const contentType = contentTypeOf(name);
    if (contentType === undefined) {
      throw new Error(`GitHub takes only images and videos from a token: attach ${name} on ${host}`);
    }
    const repository = (await getJson(`${apiBase(host)}/repos/${path}`, headers(token))) as { id: number };
    const query = new URLSearchParams({ name, content_type: contentType, repository_id: String(repository.id) });
    const response = await fetchOk(
      `https://uploads.${host}/user-attachments/assets?${query.toString()}`,
      { ...headers(token), "Content-Type": "application/octet-stream" },
      { method: "POST", body: bytes },
    ).catch((error: unknown) => {
      // It answers 404, not 403, to a token it takes no upload from, and to one that cannot write.
      throw error instanceof ApiError && error.status === 404
        ? new Error(`GitHub takes no upload of ${name} from this token: it needs write access and a token type it accepts`)
        : error;
    });
    const { url } = (await response.json()) as { url?: string };
    if (!url) {
      throw new Error(`GitHub answered the upload of ${name} without its URL`);
    }
    return uploadMarkdown(name, url, contentType);
  },
};
