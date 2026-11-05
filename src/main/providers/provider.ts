import { net } from "electron";
import type {
  Issue,
  IssueChange,
  IssueDetail,
  IssueFilter,
  IssueMilestone,
  IssueUploads,
  RemoteRepository,
} from "../../shared/types/providers";
import { fetchHttpsImage } from "../util/image-response";

/** A repository's issue tracker as one call reaches it: the host, the token of the account it goes
 *  through, and the repository's path there, "owner/name" or "group/subgroup/name". */
export interface Tracker {
  host: string;
  token: string;
  path: string;
}

/** A repository host: authenticate, list repositories with their clone url and read their issues.
 *  One interface for GitHub and GitLab, over plain REST and GraphQL rather than Octokit or GitBeaker,
 *  and kept out of the local git layer: everything past the clone goes through the local git CLI. */
export interface GitProvider {
  /** Checks the token against the host and returns its login. */
  validate(host: string, token: string): Promise<string>;
  /** Every repository the token's user can reach, most recently active first. */
  listRepositories(host: string, token: string): Promise<RemoteRepository[]>;
  /** The issues the filter leaves, newest first. */
  listIssues(tracker: Tracker, filter: IssueFilter): Promise<Issue[]>;
  /** Refuses a path the token cannot read, which is how a new issue source is checked. */
  listLabels(tracker: Tracker): Promise<string[]>;
  /** Who can be assigned, so external authors are not among them. */
  listPeople(tracker: Tracker): Promise<string[]>;
  readIssue(tracker: Tracker, number: number): Promise<IssueDetail>;
  /** An image of an issue's text that takes the token to read; undefined for any other source. */
  readImage(tracker: Tracker, source: string): Promise<Response | undefined>;
  listMilestones(tracker: Tracker): Promise<IssueMilestone[]>;
  createIssue(tracker: Tracker, title: string, body: string): Promise<number>;
  addComment(tracker: Tracker, number: number, body: string): Promise<void>;
  /** A comment by its id, which the tracker knows without its issue. */
  editComment(tracker: Tracker, id: string, body: string): Promise<void>;
  deleteComment(tracker: Tracker, id: string): Promise<void>;
  deleteIssue(tracker: Tracker, number: number): Promise<void>;
  /** What `uploadFile` takes on this host; undefined where it takes nothing. */
  uploads(host: string): IssueUploads | undefined;
  /** Uploads a file for an issue's text and answers the Markdown that shows it. */
  uploadFile(tracker: Tracker, name: string, bytes: Buffer<ArrayBuffer>): Promise<string>;
  updateIssue(tracker: Tracker, number: number, change: IssueChange): Promise<void>;
}

/** Pages follow the RFC 5988 `Link` header both hosts send; the cap bounds an account reaching
 *  thousands of repositories. */
const PAGE_CAP = 10;

/** A host's non-2xx answer: `status` to go by, the message to tell. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One GET; a non-2xx status throws with what the API said. `net.fetch`, never the global fetch: only
 * Chromium's stack applies the machine's proxy settings and certificate store, so a company proxy or
 * private root certificate works. `no-store`: its HTTP cache would answer a host's reads for their
 * `max-age`, and a write invalidates only its own URL, so what was just written would not read back.
 */
export async function fetchOk(url: string, headers: Record<string, string>, init?: { method: string; body?: BodyInit }): Promise<Response> {
  const response = await net.fetch(url, { headers, cache: "no-store", ...init });
  if (!response.ok) {
    throw new ApiError(response.status, await apiError(response));
  }
  return response;
}

/** An image read with a token, which stays with its first hop: a redirect leads to storage. What the
 *  host refused throws — see fetchOk — so that the next account gets to try. */
export async function fetchImageOk(url: string, headers: Record<string, string>): Promise<Response | undefined> {
  const response = await fetchHttpsImage(url, undefined, headers);
  if (response && !response.ok) {
    void response.body?.cancel();
    throw new ApiError(response.status, `${response.status} ${response.statusText}`.trim());
  }
  return response;
}

/** One DELETE, whose answer is not read — see fetchOk. */
export async function sendDelete(url: string, headers: Record<string, string>): Promise<void> {
  const response = await fetchOk(url, headers, { method: "DELETE" });
  void response.body?.cancel();
}

/** What a GraphQL answer refused, which it says under a status of 200. */
export function graphqlError(body: { errors?: { message?: string }[] }): string | undefined {
  const messages = body.errors?.map((error) => error.message ?? "").filter((message) => message !== "");
  return body.errors === undefined || body.errors.length === 0 ? undefined : messages?.join("; ") || "The host refused the request";
}

/** One GraphQL request, answering its `data`; what it refused throws — see fetchOk. */
export async function sendGraphql(url: string, headers: Record<string, string>, query: string, variables: object): Promise<unknown> {
  const response = await fetchOk(
    url,
    { ...headers, "Content-Type": "application/json" },
    { method: "POST", body: JSON.stringify({ query, variables }) },
  );
  const body = (await response.json()) as { data?: unknown; errors?: { message?: string }[] };
  const refused = graphqlError(body);
  if (refused !== undefined) {
    throw new Error(refused);
  }
  return body.data;
}

/** Sends one GraphQL request to a host, answering its `data` (`sendGraphql`). */
export type GraphqlSend = (query: string, variables: object) => Promise<unknown>;

/** A page of a GraphQL listing, with where the next starts. */
export interface GraphqlPage<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/** Every page of a GraphQL listing up to the cap, from `variables`' `cursor` where it has one; `pageOf`
 *  finds it in an answer. */
export async function allNodes<T>(
  send: GraphqlSend,
  query: string,
  variables: Record<string, unknown>,
  pageOf: (data: unknown) => GraphqlPage<T>,
): Promise<T[]> {
  const nodes: T[] = [];
  let cursor = (variables.cursor ?? null) as string | null;
  for (let page = 0; page < PAGE_CAP; page++) {
    const answer = pageOf(await send(query, { ...variables, cursor }));
    nodes.push(...answer.nodes);
    if (!answer.pageInfo.hasNextPage) {
      break;
    }
    cursor = answer.pageInfo.endCursor;
  }
  return nodes;
}

/** The ids of what a host names, by those names; GraphQL sets labels and people by id alone. Refuses a
 *  name it does not know, so nothing is dropped unseen. */
export function idsByName(names: string[], known: { id: string; name: string }[], what: string): string[] {
  return names.map((name) => {
    const entry = known.find((candidate) => candidate.name === name);
    if (!entry) {
      throw new Error(`${name} is no ${what} of this project`);
    }
    return entry.id;
  });
}

/** One GET as JSON — see fetchOk. */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return (await fetchOk(url, headers)).json();
}

/**
 * Every page of a listing, up to the cap. With `rel="last"` the rest are fetched in parallel, as
 * following `rel="next"` one by one adds up each page's wait. Else `rel="next"`.
 */
export async function getPaged(first: string, headers: Record<string, string>): Promise<unknown[]> {
  const response = await fetchOk(first, headers);
  const items = arrayBody(await response.json());
  const link = response.headers.get("link");
  const last = relLink(link, "last");
  const lastPage = last === undefined ? undefined : pageOf(last);
  if (last === undefined || lastPage === undefined) {
    let url = relLink(link, "next");
    for (let page = 1; url !== undefined && page < PAGE_CAP; page++) {
      const rest = await fetchOk(url, headers);
      items.push(...arrayBody(await rest.json()));
      url = relLink(rest.headers.get("link"), "next");
    }
    return items;
  }
  const urls: string[] = [];
  for (let page = 2; page <= Math.min(lastPage, PAGE_CAP); page++) {
    urls.push(withPage(last, page));
  }
  const bodies = await Promise.all(urls.map(async (url) => arrayBody(await getJson(url, headers))));
  for (const body of bodies) {
    items.push(...body);
  }
  return items;
}

/** A body that is not an array counts as empty. */
function arrayBody(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [];
}

function relLink(header: string | null, rel: string): string | undefined {
  const match = new RegExp(`<([^>]+)>;\\s*rel="${rel}"`).exec(header ?? "");
  return match?.[1];
}

/** The url's `page` parameter, which both hosts page by. */
function pageOf(url: string): number | undefined {
  const value = Number(new URL(url).searchParams.get("page"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function withPage(url: string, page: number): string {
  const next = new URL(url);
  next.searchParams.set("page", String(page));
  return next.toString();
}

/** Both APIs put their reason in a `message` field; the status line is the fallback. */
async function apiError(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") {
      return `${body.message} (${status})`;
    }
  } catch {
    // Not JSON, e.g. a proxy's error page.
  }
  return status;
}
