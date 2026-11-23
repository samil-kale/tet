import type { IssueFilter } from "../../../shared/types/providers";
import {
  type GitProviderIssues,
  firstNodes,
  type GraphqlPage,
  allNodes,
  fetchUploadOk,
  fieldMethods,
  fetchOk,
  ApiError,
} from "../provider";
import { headers, issueNodeId, mutate, readIssueNode, readsWithToken, repositoryIds, repositoryOf, sender } from "./api";
import { fieldHandlerOf, readExtras, readTarget, updateIssueWrite } from "./fields";
import {
  assigneesOf,
  avatarsOf,
  carriesAll,
  type GitHubComment,
  type GitHubEvent,
  type GitHubIssue,
  githubState,
  toEvents,
  toFields,
  toIssue,
  toIssueInput,
  toNote,
} from "./mapping";
import {
  ISSUE_SEARCH_QUERY,
  issueSearch,
  ISSUES_QUERY,
  ISSUE_SEARCH_LATEST_QUERY,
  LATEST_QUERY,
  ISSUE_QUERY,
  COMMENTS_QUERY,
  TIMELINE_QUERY,
} from "./queries";

/** The file name of an upload in an issue's text, on the account's host alone as `readsWithToken`:
 *  under `user-attachments/`, or an older one under its repository's `files/` or `assets/`. */

export function attachmentName(host: string, source: string): string | undefined {
  const match = readsWithToken(host, source)
    ? /^\/(?:user-attachments|[^/]+\/[^/]+)\/(?:files|assets)\/(?:[^/]+\/)*([^/]+)$/.exec(new URL(source).pathname)
    : null;
  try {
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** The only files its upload takes from a token, by extension: it refuses any other type. */
export const UPLOAD_TYPES: Record<string, string> = {
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
export function hasUpload(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}
/** What a filter asks for, in the words of `ISSUES_QUERY` and `LATEST_QUERY`. Its `labels` leave an issue with any of
 *  them, so `carriesAll` narrows what it answers. */

export function issuesVariables(path: string, filter: IssueFilter): Record<string, unknown> {
  return {
    ...repositoryOf(path),
    filter: {
      states: filter.state && [githubState(filter.state)],
      createdBy: filter.author,
      assignee: filter.assignee,
      labels: filter.labels.length > 0 ? filter.labels : undefined,
    },
  };
}

export const githubIssues: GitProviderIssues = {
  async list({ host, token, path }, filter, limit, after) {
    const { items, ...rest } = filter.text
      ? await firstNodes<GitHubIssue>(
          sender(host, token),
          ISSUE_SEARCH_QUERY,
          { query: issueSearch(path, filter, "created") },
          (data) => (data as { search: GraphqlPage<GitHubIssue> }).search,
          { limit, after },
        )
      : await firstNodes<GitHubIssue>(
          sender(host, token),
          ISSUES_QUERY,
          issuesVariables(path, filter),
          (data) => (data as { repository: { issues: GraphqlPage<GitHubIssue> } }).repository.issues,
          // `filterBy` leaves an issue with any of several labels.
          { limit, after, ...(filter.labels.length > 1 && { keep: (entry: GitHubIssue) => carriesAll(entry, filter.labels) }) },
        );
    return { items: items.map(toIssue), ...rest };
  },

  async readLatest({ host, token, path }, filter) {
    if (filter.text) {
      const found = (await sender(host, token)(ISSUE_SEARCH_LATEST_QUERY, { query: issueSearch(path, filter, "updated") })) as {
        search: { issueCount: number; nodes: { updatedAt: string }[] };
      };
      return { total: found.search.issueCount, updatedAt: found.search.nodes[0]?.updatedAt };
    }
    const data = (await sender(host, token)(LATEST_QUERY, issuesVariables(path, filter))) as {
      repository: { issues: { totalCount: number; nodes: { updatedAt: string }[] } };
    };
    const { totalCount, nodes } = data.repository.issues;
    return { total: totalCount, updatedAt: nodes[0]?.updatedAt };
  },

  async read({ host, token, path }, number) {
    const send = sender(host, token);
    const variables = { ...repositoryOf(path), number };
    const [issueData, extras] = await Promise.all([send(ISSUE_QUERY, variables), readExtras(send, variables)]);
    const data = issueData as {
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
      avatars: avatarsOf([
        found.author,
        ...assignees,
        ...(found.participants?.nodes ?? []),
        ...comments.map((comment) => comment.author),
        ...items.map((item) => item.actor),
      ]),
      events: toEvents(items),
      fields: toFields(found, extras),
      body: found.body ?? "",
      notes: comments.map(toNote),
    };
  },

  async readUpdate({ host, token, path }, number) {
    const { updatedAt } = await readIssueNode<{ updatedAt: string }>(sender(host, token), path, number, "updatedAt");
    return { updatedAt };
  },

  uploadName: attachmentName,

  async readUpload({ host, token }, source) {
    return attachmentName(host, source) === undefined
      ? undefined
      : fetchUploadOk(source, { Authorization: `Bearer ${token}`, "User-Agent": "tet" });
  },

  internalNotes: false,

  async comment({ host, token, path }, number, body) {
    const send = sender(host, token);
    await mutate(send, {
      mutation: "addComment",
      inputType: "AddCommentInput",
      input: { subjectId: await issueNodeId(send, path, number), body },
    });
  },

  async update({ host, token, path }, number, change) {
    const send = sender(host, token);
    await mutate(send, updateIssueWrite(toIssueInput(await issueNodeId(send, path, number), change)));
  },

  ...fieldMethods({ graphql: sender, handlerOf: fieldHandlerOf, readTarget, mutate }),

  confidential: false,

  async create({ host, token, path }, title, body) {
    const send = sender(host, token);
    const { id } = await repositoryIds(send, path);
    const { issue } = await mutate<{ issue: { number: number } }>(
      send,
      { mutation: "createIssue", inputType: "CreateIssueInput", input: { repositoryId: id, title, body } },
      "issue { number }",
    );
    return issue.number;
  },

  async delete({ host, token, path }, number) {
    const send = sender(host, token);
    await mutate(send, {
      mutation: "deleteIssue",
      inputType: "DeleteIssueInput",
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
