import { net } from "electron";
import type { RemoteRepository } from "../../shared/types";

/** A repository host: authenticate and list repositories with their clone url. One interface for
 *  GitHub and GitLab, over plain REST rather than Octokit or GitBeaker, and kept out of the local
 *  git layer: everything past the clone goes through the local git CLI. */
export interface GitProvider {
  /** Checks the token against the host and returns its login. */
  validate(host: string, token: string): Promise<string>;
  /** Every repository the token's user can reach, most recently active first. */
  listRepositories(host: string, token: string): Promise<RemoteRepository[]>;
}

/** Pages follow the RFC 5988 `Link` header both hosts send; the cap bounds an account reaching
 *  thousands of repositories. */
const PAGE_CAP = 10;

/**
 * One GET; a non-2xx status throws with what the API said. `net.fetch`, never the global fetch: only
 * Chromium's stack applies the machine's proxy settings and certificate store, so a company proxy or
 * private root certificate works.
 */
async function fetchOk(url: string, headers: Record<string, string>): Promise<Response> {
  const response = await net.fetch(url, { headers });
  if (!response.ok) {
    throw new Error(await apiError(response));
  }
  return response;
}

/** One GET as JSON — see fetchOk. */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return (await fetchOk(url, headers)).json();
}

/**
 * Every page of a listing, up to the cap. With `rel="last"` the rest are fetched in parallel — a
 * page costs about a second, and following `rel="next"` one by one adds that up. Else `rel="next"`.
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
  const bodies = await Promise.all(
    urls.map(async (url) => arrayBody(await getJson(url, headers)))
  );
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
