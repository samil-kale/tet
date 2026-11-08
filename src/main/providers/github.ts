import type { Issue, IssueChange, IssueEvent, IssueFilter, IssueNote, RemoteRepository } from "../../shared/types/providers";
import {
  allNodes,
  ApiError,
  fetchImageOk,
  fetchOk,
  idsByName,
  sendGraphql,
  type GitProvider,
  type GraphqlPage,
  type GraphqlSend,
} from "./provider";

// All of it GraphQL, but for what it does not carry: a file going up, through the upload's own
// endpoint, and an image coming down.

/** GitHub rejects requests without a User-Agent. */
function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tet",
  };
}

/** Whether an image of an issue's text may be asked for with the token: on the account's host alone,
 *  as anyone can write any address into a text. */
export function readsWithToken(host: string, source: string): boolean {
  const url = URL.parse(source);
  return url?.protocol === "https:" && url.host.toLowerCase() === host.toLowerCase();
}

/** A user as GraphQL says it; null for a deleted account. */
interface GitHubUser {
  login: string;
  avatarUrl: string;
}

/** An issue as GraphQL says it; only one read alone has the last two. */
export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  author: GitHubUser | null;
  assignees: { nodes: (GitHubUser | null)[] };
  labels: { nodes: { name: string }[] };
  body?: string | null;
  milestone?: { title: string } | null;
}

/** A comment as GraphQL says it. */
export interface GitHubComment {
  id: string;
  body: string;
  createdAt: string;
  author: GitHubUser | null;
}

/** A timeline item as GraphQL says it; which of the rest it has goes by its `__typename`. */
export interface GitHubEvent {
  __typename: string;
  createdAt: string;
  actor: GitHubUser | null;
  assignee?: { login?: string } | null;
  label?: { name: string };
  milestoneTitle?: string;
  previousTitle?: string;
  currentTitle?: string;
  source?: { number?: number; title?: string; url?: string };
}

const ISSUE_ROW = `number title url state createdAt
  author { login avatarUrl }
  assignees(first: 100) { nodes { login avatarUrl } }
  labels(first: 100) { nodes { name } }`;

const COMMENT_PAGE = `pageInfo { hasNextPage endCursor }
  nodes { id body createdAt author { login avatarUrl } }`;

const ACTOR = "createdAt actor { login avatarUrl }";

/** The kinds of timeline item the tab draws, as `toEvent` reads them. */
const EVENT_KINDS: Record<string, Exclude<IssueEvent["kind"], "text"> | undefined> = {
  ClosedEvent: "closed",
  ReopenedEvent: "reopened",
  AssignedEvent: "assigned",
  UnassignedEvent: "unassigned",
  LabeledEvent: "labeled",
  UnlabeledEvent: "unlabeled",
  MilestonedEvent: "milestoned",
  DemilestonedEvent: "demilestoned",
  RenamedTitleEvent: "renamed",
  CrossReferencedEvent: "linked",
};

const TIMELINE_ARGUMENTS = `itemTypes: [CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, LABELED_EVENT, UNLABELED_EVENT,
  MILESTONED_EVENT, DEMILESTONED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT]`;

const TIMELINE_PAGE = `pageInfo { hasNextPage endCursor }
  nodes {
    __typename
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
    }
  }`;

const ISSUES_QUERY = `query($owner: String!, $name: String!, $cursor: String, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }, filterBy: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_ROW} }
    }
  }
}`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ${ISSUE_ROW}
      body
      milestone { title }
      commentPage: comments(first: 100) { ${COMMENT_PAGE} }
      timelineItems(first: 100, ${TIMELINE_ARGUMENTS}) { ${TIMELINE_PAGE} }
    }
  }
}`;

const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { issue(number: $number) { comments(first: 100, after: $cursor) { ${COMMENT_PAGE} } } }
}`;

const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { timelineItems(first: 100, after: $cursor, ${TIMELINE_ARGUMENTS}) { ${TIMELINE_PAGE} } }
  }
}`;

/** What a timeline item shows, for those the tab draws; a comment is read on its own. */
function toEvent(item: GitHubEvent): IssueEvent | undefined {
  const base = { actor: item.actor?.login ?? "ghost", createdAt: item.createdAt };
  const kind = EVENT_KINDS[item.__typename];
  switch (kind) {
    case "closed":
    case "reopened":
      return { ...base, kind };
    case "assigned":
    case "unassigned":
      return item.assignee?.login === undefined ? undefined : { ...base, kind, login: item.assignee.login };
    case "labeled":
    case "unlabeled":
      return item.label && { ...base, kind, label: item.label.name };
    case "milestoned":
    case "demilestoned":
      return item.milestoneTitle === undefined ? undefined : { ...base, kind, milestone: item.milestoneTitle };
    case "renamed":
      return item.previousTitle === undefined ? undefined : { ...base, kind, from: item.previousTitle, to: item.currentTitle ?? "" };
    case "linked": {
      const { number, title, url } = item.source ?? {};
      return number === undefined ? undefined : { ...base, kind, number, title: title ?? "", url: url ?? "" };
    }
    case undefined:
      return undefined;
  }
}

export function toEvents(items: GitHubEvent[]): IssueEvent[] {
  return items.map(toEvent).filter((event) => event !== undefined);
}

/** What of a change `updateIssue` sets, in GitHub's words. */
export function toIssueInput(issueId: string, { title, body, state }: IssueChange): object {
  return { id: issueId, title, body, state: state && (state === "open" ? "OPEN" : "CLOSED") };
}

/** What `updateIssue` takes of a pick field: its input, and where its names and ids are listed. */
interface PickField {
  input: string;
  /** What one of its values is, for the refusal of an unknown name. */
  what: string;
  /** Takes one value, null taking it off, instead of a list. */
  single?: boolean;
  list: (send: GraphqlSend, path: string) => Promise<{ id: string; name: string }[]>;
}

const PICK_FIELDS: Record<string, PickField> = {
  assignees: { input: "assigneeIds", what: "person to assign", list: allAssignable },
  labels: { input: "labelIds", what: "label", list: allLabels },
  milestone: { input: "milestoneId", what: "milestone", single: true, list: allMilestones },
};

function pickFieldOf(fieldId: string): PickField {
  const field = PICK_FIELDS[fieldId];
  if (!field) {
    throw new Error(`An issue of GitHub has no field ${fieldId}`);
  }
  return field;
}

/** What `updateIssue` sets of a pick field, in GitHub's words: the ids of its values. */
export function toFieldInput(issueId: string, fieldId: string, ids: string[]): object {
  const { input, single } = pickFieldOf(fieldId);
  return { id: issueId, [input]: single ? (ids[0] ?? null) : ids };
}

/** github.com's GraphQL lives on its own subdomain; GitHub Enterprise serves it under /api. */
function graphqlUrl(host: string): string {
  return host === "github.com" ? "https://api.github.com/graphql" : `https://${host}/api/graphql`;
}

function sender(host: string, token: string): GraphqlSend {
  return (query, variables) => sendGraphql(graphqlUrl(host), headers(token), query, variables);
}

/** A repository's path as GraphQL asks for it. */
function repositoryOf(path: string): { owner: string; name: string } {
  const [owner, name] = path.split("/");
  return { owner, name };
}

/** The node id GraphQL addresses a repository's issue by. */
async function issueNodeId(send: GraphqlSend, path: string, number: number): Promise<string> {
  const query =
    "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }";
  const data = (await send(query, { ...repositoryOf(path), number })) as { repository: { issue: { id: string } } };
  return data.repository.issue.id;
}

/** The node id GraphQL addresses a repository by, and the number its upload goes by. */
async function repositoryIds(send: GraphqlSend, path: string): Promise<{ id: string; databaseId: number }> {
  const query = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }";
  return ((await send(query, repositoryOf(path))) as { repository: { id: string; databaseId: number } }).repository;
}

/** A repository's labels by name, with their ids. */
async function allLabels(send: GraphqlSend, path: string): Promise<{ id: string; name: string }[]> {
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      labels(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id name }
      }
    }
  }`;
  return allNodes<{ id: string; name: string }>(
    send,
    query,
    repositoryOf(path),
    (data) => (data as { repository: { labels: GraphqlPage<{ id: string; name: string }> } }).repository.labels,
  );
}

/** Who can be assigned, by login, with their ids. */
async function allAssignable(send: GraphqlSend, path: string): Promise<{ id: string; name: string }[]> {
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      assignableUsers(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id login }
      }
    }
  }`;
  const entries = await allNodes<{ id: string; login: string }>(
    send,
    query,
    repositoryOf(path),
    (data) => (data as { repository: { assignableUsers: GraphqlPage<{ id: string; login: string }> } }).repository.assignableUsers,
  );
  return entries.map((entry) => ({ id: entry.id, name: entry.login }));
}

/** A repository's open milestones by title, with their ids. */
async function allMilestones(send: GraphqlSend, path: string): Promise<{ id: string; name: string }[]> {
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      milestones(first: 100, after: $cursor, states: [OPEN], orderBy: { field: DUE_DATE, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes { id title }
      }
    }
  }`;
  const entries = await allNodes<{ id: string; title: string }>(
    send,
    query,
    repositoryOf(path),
    (data) => (data as { repository: { milestones: GraphqlPage<{ id: string; title: string }> } }).repository.milestones,
  );
  return entries.map((entry) => ({ id: entry.id, name: entry.title }));
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

/** What a filter asks for, in the words of `ISSUES_QUERY`. Its `labels` leave an issue with any of
 *  them, so `carriesAll` narrows what it answers. */
export function issuesVariables(path: string, filter: IssueFilter): Record<string, unknown> {
  return {
    ...repositoryOf(path),
    filter: {
      states: filter.state && [filter.state === "open" ? "OPEN" : "CLOSED"],
      createdBy: filter.author,
      assignee: filter.assignee,
      labels: filter.labels.length > 0 ? filter.labels : undefined,
    },
  };
}

/** Whether an issue carries every one of a filter's labels. */
export function carriesAll(entry: GitHubIssue, labels: string[]): boolean {
  return labels.every((label) => entry.labels.nodes.some((node) => node.name === label));
}

/** Each user's picture by login, at about twice the size it is drawn: unasked, GitHub sends the whole. */
function avatarsOf(users: (GitHubUser | null)[]): Record<string, string> {
  const avatars: Record<string, string> = {};
  for (const user of users) {
    const url = user && URL.parse(user.avatarUrl);
    if (user && url) {
      url.searchParams.set("s", "40");
      avatars[user.login] = url.href;
    }
  }
  return avatars;
}

/** Who an issue is assigned to; a deleted account is none. */
function assigneesOf(entry: GitHubIssue): GitHubUser[] {
  return entry.assignees.nodes.flatMap((person) => person ?? []);
}

export function toIssue(entry: GitHubIssue): Issue {
  const assignees = assigneesOf(entry);
  return {
    number: entry.number,
    title: entry.title,
    url: entry.url,
    open: entry.state === "OPEN",
    author: entry.author?.login ?? "ghost",
    assignee: assignees[0]?.login,
    createdAt: entry.createdAt,
    labels: entry.labels.nodes.map((label) => label.name),
    avatars: avatarsOf([entry.author, ...assignees]),
  };
}

function toNote(entry: GitHubComment): IssueNote {
  return {
    id: entry.id,
    author: entry.author?.login ?? "ghost",
    createdAt: entry.createdAt,
    body: entry.body,
  };
}

export const github: GitProvider = {
  async validate(host, token) {
    const data = (await sender(host, token)("{ viewer { login } }", {})) as { viewer: { login?: unknown } | null };
    const login = data.viewer?.login;
    if (typeof login !== "string" || login === "") {
      throw new Error("The API answered without a login");
    }
    return login;
  },

  async listRepositories(host, token) {
    // Both affiliations, or it leaves out the organizations' repositories.
    const query = `query($cursor: String) {
      viewer {
        repositories(
          first: 100
          after: $cursor
          orderBy: { field: PUSHED_AT, direction: DESC }
          affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
        ) {
          pageInfo { hasNextPage endCursor }
          nodes { nameWithOwner name url }
        }
      }
    }`;
    type Repository = { nameWithOwner: string; name: string; url: string };
    const entries = await allNodes<Repository>(
      sender(host, token),
      query,
      {},
      (data) => (data as { viewer: { repositories: GraphqlPage<Repository> } }).viewer.repositories,
    );
    return entries.map((entry): RemoteRepository => ({
      fullName: entry.nameWithOwner,
      name: entry.name,
      cloneUrl: `${entry.url}.git`,
    }));
  },

  async listIssues({ host, token, path }, filter) {
    const entries = await allNodes<GitHubIssue>(
      sender(host, token),
      ISSUES_QUERY,
      issuesVariables(path, filter),
      (data) => (data as { repository: { issues: GraphqlPage<GitHubIssue> } }).repository.issues,
    );
    return entries.filter((entry) => carriesAll(entry, filter.labels)).map(toIssue);
  },

  async listLabels({ host, token, path }) {
    return (await allLabels(sender(host, token), path)).map((entry) => entry.name);
  },

  async listPeople({ host, token, path }) {
    return (await allAssignable(sender(host, token), path)).map((entry) => entry.name);
  },

  async readIssue({ host, token, path }, number) {
    const send = sender(host, token);
    const variables = { ...repositoryOf(path), number };
    const data = (await send(ISSUE_QUERY, variables)) as {
      repository: {
        issue: GitHubIssue & { commentPage: GraphqlPage<GitHubComment>; timelineItems: GraphqlPage<GitHubEvent> };
      };
    };
    const found = data.repository.issue;
    const [laterComments, laterEvents] = await Promise.all([
      found.commentPage.pageInfo.hasNextPage
        ? allNodes<GitHubComment>(
            send,
            COMMENTS_QUERY,
            { ...variables, cursor: found.commentPage.pageInfo.endCursor },
            (answer) => (answer as { repository: { issue: { comments: GraphqlPage<GitHubComment> } } }).repository.issue.comments,
          )
        : [],
      found.timelineItems.pageInfo.hasNextPage
        ? allNodes<GitHubEvent>(
            send,
            TIMELINE_QUERY,
            { ...variables, cursor: found.timelineItems.pageInfo.endCursor },
            (answer) => (answer as { repository: { issue: { timelineItems: GraphqlPage<GitHubEvent> } } }).repository.issue.timelineItems,
          )
        : [],
    ]);
    const assignees = assigneesOf(found);
    const comments = [...found.commentPage.nodes, ...laterComments];
    const items = [...found.timelineItems.nodes, ...laterEvents];
    return {
      ...toIssue(found),
      provider: "github",
      avatars: avatarsOf([found.author, ...assignees, ...comments.map((comment) => comment.author), ...items.map((item) => item.actor)]),
      events: toEvents(items),
      fields: [
        {
          id: "assignees",
          name: "Assignees",
          editable: true,
          kind: "pick",
          several: true,
          shown: "people",
          value: assignees.map((assignee) => assignee.login),
        },
        {
          id: "labels",
          name: "Labels",
          editable: true,
          kind: "pick",
          several: true,
          shown: "labels",
          value: found.labels.nodes.map((label) => label.name),
        },
        {
          id: "milestone",
          name: "Milestone",
          editable: true,
          kind: "pick",
          several: false,
          shown: "text",
          value: found.milestone ? [found.milestone.title] : [],
        },
      ],
      body: found.body ?? "",
      notes: comments.map(toNote),
    };
  },

  async readImage({ host, token }, source) {
    return readsWithToken(host, source) ? fetchImageOk(source, { Authorization: `Bearer ${token}`, "User-Agent": "tet" }) : undefined;
  },

  internalNotes: false,

  async addComment({ host, token, path }, number, body) {
    const send = sender(host, token);
    await send("mutation($input: AddCommentInput!) { addComment(input: $input) { clientMutationId } }", {
      input: { subjectId: await issueNodeId(send, path, number), body },
    });
  },

  async updateIssue({ host, token, path }, number, change) {
    const send = sender(host, token);
    await send("mutation($input: UpdateIssueInput!) { updateIssue(input: $input) { clientMutationId } }", {
      input: toIssueInput(await issueNodeId(send, path, number), change),
    });
  },

  async listOptions({ host, token, path }, _number, fieldId) {
    return (await pickFieldOf(fieldId).list(sender(host, token), path)).map((entry) => entry.name);
  },

  async setField({ host, token, path }, number, fieldId, value) {
    const send = sender(host, token);
    const pick = pickFieldOf(fieldId);
    if (!Array.isArray(value)) {
      throw new Error(`${fieldId} takes a list of values`);
    }
    const [issueId, entries] = await Promise.all([issueNodeId(send, path, number), pick.list(send, path)]);
    await send("mutation($input: UpdateIssueInput!) { updateIssue(input: $input) { clientMutationId } }", {
      input: toFieldInput(issueId, fieldId, idsByName(value, entries, pick.what)),
    });
  },

  async createIssue({ host, token, path }, title, body) {
    const send = sender(host, token);
    const { id } = await repositoryIds(send, path);
    const data = (await send("mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }", {
      input: { repositoryId: id, title, body },
    })) as { createIssue: { issue: { number: number } } };
    return data.createIssue.issue.number;
  },

  async editComment({ host, token }, id, body) {
    await sender(host, token)("mutation($input: UpdateIssueCommentInput!) { updateIssueComment(input: $input) { clientMutationId } }", {
      input: { id, body },
    });
  },

  async deleteComment({ host, token }, id) {
    await sender(host, token)("mutation($input: DeleteIssueCommentInput!) { deleteIssueComment(input: $input) { clientMutationId } }", {
      input: { id },
    });
  },

  async deleteIssue({ host, token, path }, number) {
    const send = sender(host, token);
    await send("mutation($input: DeleteIssueInput!) { deleteIssue(input: $input) { clientMutationId } }", {
      input: { issueId: await issueNodeId(send, path, number) },
    });
  },

  uploads: (host) => (hasUpload(host) ? { extensions: Object.keys(UPLOAD_TYPES) } : undefined),

  // Undocumented, and the one GitHub's own CLI uploads with; the bytes go as they are.
  async uploadFile({ host, token, path }, name, bytes) {
    const contentType = contentTypeOf(name);
    if (contentType === undefined) {
      throw new Error(`GitHub takes only images and videos from a token: attach ${name} on ${host}`);
    }
    const { databaseId } = await repositoryIds(sender(host, token), path);
    const query = new URLSearchParams({ name, content_type: contentType, repository_id: String(databaseId) });
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
