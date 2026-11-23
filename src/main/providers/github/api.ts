import { allNodes, type GraphqlPage, type GraphqlSend, type NamedId, reached, sendGraphql, sendMutation, type Write } from "../provider";
import { ISSUE_VARIABLES } from "./queries";

// All of it GraphQL, but for what it does not carry: a file going up, through the upload's own
// endpoint, and an image coming down.

/** GitHub rejects requests without a User-Agent. */
export function headers(token: string): Record<string, string> {
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

/** github.com and its data residency tenants (`*.ghe.com`), unlike a GitHub Enterprise Server. */
export function isDotcom(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/** github.com's GraphQL, and a tenant's, lives on an `api.` subdomain; GitHub Enterprise Server serves it under /api. */
export function graphqlUrl(host: string): string {
  return isDotcom(host) ? `https://api.${host}/graphql` : `https://${host}/api/graphql`;
}

export function sender(host: string, token: string): GraphqlSend {
  return (query, variables) => sendGraphql(graphqlUrl(host), headers(token), query, variables);
}

/** A repository's path as GraphQL asks for it. */
export function repositoryOf(path: string): { owner: string; name: string } {
  const [owner, name] = path.split("/");
  return { owner, name };
}

/** An issue of a repository by its number, as far as `selection` reads it beside its node id, the id
 *  GraphQL addresses it by. */
export async function readIssueNode<T extends object = object>(
  send: GraphqlSend,
  path: string,
  number: number,
  selection = "",
): Promise<{ id: string } & T> {
  const query = `query(${ISSUE_VARIABLES}) { repository(owner: $owner, name: $name) { issue(number: $number) { id ${selection} } } }`;
  const data = (await send(query, { ...repositoryOf(path), number })) as { repository: { issue: { id: string } & T } };
  return data.repository.issue;
}

export async function issueNodeId(send: GraphqlSend, path: string, number: number): Promise<string> {
  return (await readIssueNode(send, path, number)).id;
}

/** The node id GraphQL addresses a repository by, and the number its upload goes by. */
export async function repositoryIds(send: GraphqlSend, path: string): Promise<{ id: string; databaseId: number }> {
  const query = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId } }";
  return ((await send(query, repositoryOf(path))) as { repository: { id: string; databaseId: number } }).repository;
}

/** Every node of one of a repository's connections, up to the cap; `args` beyond the paging. */
export function repositoryNodes<T>(send: GraphqlSend, path: string, connection: string, selection: string, args = ""): Promise<T[]> {
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      ${connection}(first: 100, after: $cursor${args === "" ? "" : `, ${args}`}) {
        pageInfo { hasNextPage endCursor }
        nodes { ${selection} }
      }
    }
  }`;
  return allNodes<T>(
    send,
    query,
    repositoryOf(path),
    (data) => (data as { repository: Record<string, GraphqlPage<T>> }).repository[connection],
  );
}

/** A repository's labels by name, with their ids. */
export function allLabels(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return repositoryNodes(send, path, "labels", "id name");
}

/** Who can be assigned, by login, with their ids. */
export function allAssignable(send: GraphqlSend, path: string): Promise<NamedId[]> {
  return repositoryNodes(send, path, "assignableUsers", "id name: login");
}

/** A pull request of a repository by its number, as far as `selection` reads it beside its node id. */
export async function readPullRequestNode<T extends object = object>(
  send: GraphqlSend,
  path: string,
  number: number,
  selection = "",
): Promise<{ id: string } & T> {
  const query = `query(${ISSUE_VARIABLES}) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id ${selection} } } }`;
  const data = (await send(query, { ...repositoryOf(path), number })) as {
    repository: { pullRequest: ({ id: string } & T) | null } | null;
  };
  return reached(data.repository?.pullRequest, pullRequestName(path, number));
}

/** A pull request as a refusal names it. */
export function pullRequestName(path: string, number: number): string {
  return `Pull request #${number} of ${path}`;
}

/** One mutation. GitHub words a refusal as a GraphQL error, so a payload is asked for no more than its
 *  `clientMutationId`. */
export function mutate<T>(send: GraphqlSend, write: Write, selection = "clientMutationId"): Promise<T> {
  return sendMutation<T>(send, write, selection);
}
