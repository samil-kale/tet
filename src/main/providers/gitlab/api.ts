import { allNodes, type GraphqlPage, type GraphqlSend, type NamedId, reached, sendGraphql, sendMutation, type Write } from "../provider";

// GraphQL for all that it answers in structure and out of experiment. REST for the rest: the label,
// state and milestone events of an issue or merge request, which GraphQL words only as text, and the
// issues a merge request closes; deleting an issue and uploading a file, whose mutations are
// experiments; reading an upload's bytes, which GraphQL cannot carry; and approving a merge request,
// which it has no mutation for.

export function apiBase(host: string): string {
  return `https://${host}/api/v4`;
}

export function headers(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token };
}

export function graphqlUrl(host: string): string {
  return `https://${host}/api/graphql`;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function sender(host: string, token: string): GraphqlSend {
  return (query, variables) => sendGraphql(graphqlUrl(host), bearer(token), query, variables);
}

/** The issue a project's answer holds, both reached (`reached`). */
export function reachedIssue<T>(project: { issue: T | null } | null, path: string, number: number): T {
  return reached(reached(project, path).issue, `Issue #${number}`);
}

/** One mutation. GitLab words what it refused in the payload's `errors`, so every one asks for them. */
export function mutate<T>(send: GraphqlSend, write: Write, selection = ""): Promise<T> {
  return sendMutation<T>(send, write, `${selection} errors`);
}

/** Every node of one of a project's connections, up to the cap; `args` beyond the paging. */
export function projectNodes<T>(send: GraphqlSend, path: string, connection: string, selection: string, args: string): Promise<T[]> {
  const query = `query($path: ID!, $cursor: String) {
    project(fullPath: $path) {
      ${connection}(first: 100, after: $cursor, ${args}) {
        pageInfo { hasNextPage endCursor }
        nodes { ${selection} }
      }
    }
  }`;
  return allNodes<T>(send, query, { path }, (data) => {
    const { project } = data as { project: Record<string, GraphqlPage<T>> | null };
    return reached(project, path)[connection];
  });
}

/** A project's labels by name, with their ids, those of its groups included. */
export function allLabels(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return projectNodes(send, path, "labels", "id name: title", "includeAncestorGroups: true");
}

/** Who can be assigned, by login, with their ids. */
export async function allPeople(send: GraphqlSend, path: string): Promise<NamedId[]> {
  // relations: the default leaves out who reaches the project through a group shared with it.
  const members = await projectNodes<{ user: NamedId | null }>(
    send,
    path,
    "projectMembers",
    "user { id name: username }",
    "relations: [DIRECT, INHERITED, INVITED_GROUPS, SHARED_INTO_ANCESTORS]",
  );
  return members.flatMap((member) => (member.user ? [member.user] : []));
}

/** A project's API path takes its whole path as one segment. */
export function projectUrl(host: string, path: string): string {
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
