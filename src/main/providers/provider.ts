import type { RemoteRepository } from "../../shared/types";

/**
 * What a repository host has to offer tet: authenticate, list repositories, and — through
 * the listing — the url a repository is cloned from. Everything past the clone goes through
 * the local git CLI like any other repository; a provider never touches a working tree.
 */
export interface GitProvider {
  /** Checks the token against the host and answers the login it belongs to. */
  validate(host: string, token: string): Promise<string>;
  /** Every repository the token's user can reach, most recently active first. */
  listRepositories(host: string, token: string): Promise<RemoteRepository[]>;
}

/**
 * Pages are followed through the RFC 5988 `Link` header, which GitHub and GitLab both send.
 * The cap bounds an account that can reach thousands of repositories — ten pages of a hundred
 * are more than a picker's search field needs.
 */
const PAGE_CAP = 10;

/** One GET as JSON; a non-2xx status becomes an Error carrying what the API said. */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(await apiError(response));
  }
  return response.json();
}

/**
 * Every page of a listing, up to the cap. The first says how many there are: both hosts send
 * `rel="last"` alongside `rel="next"`, so the rest are fetched at once — a page costs about a
 * second, and waiting for each to name the next spends that many seconds in a row for nothing.
 *
 * Where there is no `rel="last"` — a listing that fits on one page sends neither, and an
 * instance may leave it out past a certain size — it follows `rel="next"` instead.
 */
export async function getPaged(first: string, headers: Record<string, string>): Promise<unknown[]> {
  const response = await fetch(first, { headers });
  if (!response.ok) {
    throw new Error(await apiError(response));
  }
  const items = arrayBody(await response.json());
  const link = response.headers.get("link");
  const last = relLink(link, "last");
  const lastPage = last === undefined ? undefined : pageOf(last);
  if (last === undefined || lastPage === undefined) {
    let url = relLink(link, "next");
    for (let page = 1; url !== undefined && page < PAGE_CAP; page++) {
      const rest = await fetch(url, { headers });
      if (!rest.ok) {
        throw new Error(await apiError(rest));
      }
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
    urls.map(async (url) => {
      const rest = await fetch(url, { headers });
      if (!rest.ok) {
        throw new Error(await apiError(rest));
      }
      return arrayBody(await rest.json());
    })
  );
  for (const body of bodies) {
    items.push(...body);
  }
  return items;
}

/** An array body as itself; anything else — an object where a list was expected — as nothing. */
function arrayBody(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [];
}

function relLink(header: string | null, rel: string): string | undefined {
  const match = new RegExp(`<([^>]+)>;\\s*rel="${rel}"`).exec(header ?? "");
  return match?.[1];
}

/** The `page` a paging url carries; both hosts number their pages with that one parameter. */
function pageOf(url: string): number | undefined {
  const value = Number(new URL(url).searchParams.get("page"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The same url with its page replaced — the rest of the query has to be carried along. */
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
    // Not JSON — a proxy's error page, say. The status line is all there is.
  }
  return status;
}
