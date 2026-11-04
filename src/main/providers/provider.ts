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

/** A repository host: authenticate, list repositories with their clone url and read their issues.
 *  One interface for GitHub and GitLab, over plain REST rather than Octokit or GitBeaker, and kept
 *  out of the local git layer: everything past the clone goes through the local git CLI. `path` is
 *  a repository's on the host, "owner/name" or "group/subgroup/name". */
export interface GitProvider {
  /** Checks the token against the host and returns its login. */
  validate(host: string, token: string): Promise<string>;
  /** Every repository the token's user can reach, most recently active first. */
  listRepositories(host: string, token: string): Promise<RemoteRepository[]>;
  /** The issues the filter leaves, newest first. */
  listIssues(host: string, token: string, path: string, filter: IssueFilter): Promise<Issue[]>;
  /** Refuses a path the token cannot read, which is how a new issue source is checked. */
  listLabels(host: string, token: string, path: string): Promise<string[]>;
  /** Who can be assigned, so external authors are not among them. */
  listPeople(host: string, token: string, path: string): Promise<string[]>;
  readIssue(host: string, token: string, path: string, number: number): Promise<IssueDetail>;
  /** An image of an issue's text that takes the token to read; undefined for any other source. */
  readImage(host: string, token: string, path: string, source: string): Promise<Response | undefined>;
  listMilestones(host: string, token: string, path: string): Promise<IssueMilestone[]>;
  createIssue(host: string, token: string, path: string, title: string, body: string): Promise<number>;
  addComment(host: string, token: string, path: string, number: number, body: string): Promise<void>;
  editComment(host: string, token: string, path: string, number: number, id: number, body: string): Promise<void>;
  deleteComment(host: string, token: string, path: string, number: number, id: number): Promise<void>;
  deleteIssue(host: string, token: string, path: string, number: number): Promise<void>;
  /** What `uploadFile` takes on this host; undefined where it takes nothing. */
  uploads(host: string): IssueUploads | undefined;
  /** Uploads a file for an issue's text and answers the Markdown that shows it. */
  uploadFile(host: string, token: string, path: string, name: string, bytes: Buffer<ArrayBuffer>): Promise<string>;
  updateIssue(host: string, token: string, path: string, number: number, change: IssueChange): Promise<void>;
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

/** One write with a JSON body, whose answer is not read — see fetchOk. */
export async function sendJson(method: string, url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const response = await fetchOk(url, { ...headers, "Content-Type": "application/json" }, { method, body: JSON.stringify(body) });
  void response.body?.cancel();
}

/** One DELETE, whose answer is not read — see fetchOk. */
export async function sendDelete(url: string, headers: Record<string, string>): Promise<void> {
  const response = await fetchOk(url, headers, { method: "DELETE" });
  void response.body?.cancel();
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
