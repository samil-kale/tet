import { requestUnfollowed, type FetchLike } from "../util/image-response";
import { ApiError } from "./provider";

/** What `provider-api` sends: `path` is relative to the host's API, with `{repo}` standing for the
 *  repository's path, and `body` is JSON text. */
export interface ApiRequest {
  method: string;
  path: string;
  body?: string;
}

/** What the host answered, a 2xx one: the headers a caller pages and paces by, and the body as JSON
 *  where it is one. */
export interface ApiAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** The body was cut at `MAX_BODY_BYTES`; `body` is then the text read. */
  truncated?: true;
}

/** Where a host serves its APIs. */
export interface ApiEndpoints {
  rest: string;
  graphql: string;
}

/** More than this of an answer is not read. */
const MAX_BODY_BYTES = 1024 * 1024;

const TIMEOUT_MS = 30_000;

const MAX_HOPS = 5;

/** The headers of an answer worth telling: how to reach the next page and how much of the rate limit
 *  is left. */
const ANSWER_HEADERS = [
  "link",
  "content-type",
  "retry-after",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-remaining",
  "ratelimit-reset",
];

/**
 * The address of a request, on the host's API and nowhere else: `path` with or without its leading
 * slash (a shell on Windows turns one into a path of its own), `{repo}` replaced by `repo` as the
 * host's paths take it, `graphql` the host's GraphQL endpoint (which does not lie under its REST
 * one), and the address as the URL parser reads it has to stay under the endpoint it was built on —
 * `..` is resolved by then, however it is spelled.
 */
export function apiUrl(endpoints: ApiEndpoints, path: string, repo: string): string {
  const full = `/${path.replaceAll("{repo}", repo).replace(/^\/+/, "")}`;
  const route = full.split("?", 1)[0];
  const endpoint = route === "/graphql" ? endpoints.graphql : endpoints.rest;
  const root = new URL(endpoint);
  const url = URL.parse(endpoint + (route === "/graphql" ? full.slice(route.length) : full));
  if (url?.origin !== root.origin || !(url.pathname === root.pathname || url.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/`))) {
    throw new Error(`not a path of the host's API: ${path}`);
  }
  return url.href;
}

/** Reads at most `MAX_BODY_BYTES` of an answer. */
async function readBody(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader && size <= MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  void reader?.cancel();
  return { text: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8"), truncated: size > MAX_BODY_BYTES };
}

/** A refusal in the words of the host where it has some (`message`, or `error` or GraphQL's `errors`),
 *  else the text it sent, as `apiError` words one. */
function refusal(response: Response, text: string): ApiError {
  const code = `${response.status} ${response.statusText}`.trim();
  let said = text.trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; errors?: unknown };
    const message = parsed.message ?? parsed.error ?? parsed.errors;
    if (message !== undefined) {
      said = typeof message === "string" ? message : JSON.stringify(message);
    }
  } catch {
    // Not JSON, e.g. a proxy's error page.
  }
  return new ApiError(response.status, said === "" ? code : `${said.slice(0, 2000)} (${code})`);
}

/**
 * One request to the host's API (`apiUrl`) with the account's headers. A redirect is followed only
 * within the host the request went to: the token goes with every hop. Anything but a 2xx answer throws,
 * so that the next account of the host gets to try (`onTracker`). `fetcher` is `net.request`'s
 * (`requestUnfollowed`): `net.fetch` throws on a redirect it is told not to follow. `no-cache`: the
 * HTTP cache would answer a read for its `max-age`, after a write that changed it (see `fetchOk`).
 */
export async function sendApi(
  endpoints: ApiEndpoints,
  repo: string,
  headers: Record<string, string>,
  { method, path, body }: ApiRequest,
  fetcher: FetchLike = requestUnfollowed,
): Promise<ApiAnswer> {
  let target = apiUrl(endpoints, path, repo);
  const origin = new URL(target).origin;
  let verb = method;
  let payload = body;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const response = await fetcher(target, {
      method: verb,
      headers: { "Cache-Control": "no-cache", ...headers, ...(payload !== undefined && { "Content-Type": "application/json" }) },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      void response.body?.cancel();
      const next = URL.parse(location, target);
      if (next?.origin !== origin) {
        throw new ApiError(response.status, `${response.status}: redirected to ${next?.origin ?? location}, which is not followed`);
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && verb === "POST")) {
        verb = "GET";
        payload = undefined;
      }
      target = next.href;
      continue;
    }
    const { text, truncated } = await readBody(response);
    if (!response.ok) {
      throw refusal(response, text);
    }
    let parsed: unknown = text;
    if (!truncated) {
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        // Not JSON: the text stands.
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(
        ANSWER_HEADERS.flatMap((name) => {
          const value = response.headers.get(name);
          return value === null ? [] : [[name, value]];
        }),
      ),
      body: parsed,
      ...(truncated && { truncated: true as const }),
    };
  }
  throw new ApiError(310, "too many redirects");
}
