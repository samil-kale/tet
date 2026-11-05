import { Readable } from "node:stream";
import { net } from "electron";

/** A Markdown preview's web image: a badge service that hangs is given up on. */
const FETCH_IMAGE_TIMEOUT_MS = 15_000;
/** As many hops as a badge service needs; past that it is a loop, not a move. */
const MAX_IMAGE_REDIRECTS = 5;

/** What `fetchHttpsImage` sends a request with; `requestUnfollowed` in the app, a stand-in in the tests. */
type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers?: Record<string, string> }) => Promise<Response>;

/** The statuses a `Response` refuses a body for. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** One request answering a redirect instead of following it. `net.request`, as `net.fetch` throws on
 *  `redirect: "manual"`. */
function requestUnfollowed(url: string, init: { signal: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: "manual" });
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      request.setHeader(name, value);
    }
    init.signal.addEventListener("abort", () => request.abort(), { once: true });
    request.on("redirect", (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on("response", (response) => {
      const body = response as unknown as Readable;
      request.on("abort", () => body.destroy(new Error("The request was stopped")));
      const headers = Object.entries(response.headers).map(([name, value]): [string, string] => [name, [value].flat().join(", ")]);
      resolve(
        new Response(NULL_BODY_STATUSES.has(response.statusCode) ? null : (Readable.toWeb(body) as ReadableStream), {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers,
        }),
      );
    });
    request.on("abort", () => reject(new Error("The request was stopped")));
    request.on("error", reject);
    request.end();
  });
}

/**
 * Fetches `url` with every hop checked to be https, the whole chain under one timeout. Undefined
 * as soon as a hop is not https, names no location, or the chain runs long — a README's image must
 * not become a request to another scheme or to a host behind the machine. `headers`, a token's, go
 * with the first hop alone: where it redirects to has no business with them.
 */
export async function fetchHttpsImage(
  url: string,
  fetchFn: FetchLike = requestUnfollowed,
  headers?: Record<string, string>,
): Promise<Response | undefined> {
  const signal = AbortSignal.timeout(FETCH_IMAGE_TIMEOUT_MS);
  // A relative location resolves against the hop that sent it; undefined where it is no URL at all.
  const resolve = (value: string, base?: string): string | undefined => {
    const resolved = URL.parse(value, base);
    // A `javascript:` or `data:` location resolves to itself and is refused here, like `http:`.
    return resolved?.protocol === "https:" ? resolved.href : undefined;
  };

  let target = resolve(url);
  for (let hop = 0; target !== undefined && hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const response = await fetchFn(target, { signal, redirect: "manual", headers: hop === 0 ? headers : undefined });
    // 3xx without a location is not a redirect; anything else is the answer.
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location === null) {
      return response;
    }
    // Unread, a hop's body holds its request open until it is collected.
    void response.body?.cancel();
    target = resolve(location, target);
  }
  return undefined;
}

/** A response's image as a data URL; null for an error, anything but an image, or one over the cap. */
export async function imageDataUrl(response: Response, maxBytes: number): Promise<string | null> {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!response.ok || !type.startsWith("image/") || !response.body) {
    void response.body?.cancel();
    return null;
  }
  // Read in chunks against the cap: a response without a content-length would otherwise be held
  // whole before it could be measured. Leaving the loop cancels the rest.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      return null;
    }
    chunks.push(chunk);
  }
  return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
}
