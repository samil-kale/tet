import { findUrls } from "../../../shared/urls";
import { runningServer } from "./server";

/**
 * A url too long for the terminal width is broken across rows by opencode's TUI at the last "."
 * that still fits, which leaves nothing in the buffer to tell that break from an ordinary one.
 * The session's messages hold the url whole, so what the screen shows is completed from those —
 * see AgentDefinition.resolveUrlPrefix.
 */

/** Long enough that holding the modifier over the same link twice doesn't refetch, short
 * enough that a url printed moments ago is found. */
const CACHE_TTL_MS = 15_000;

const cache = new Map<string, { at: number; urls: string[] }>();

export async function resolveOpencodeUrlPrefix(
  executable: string,
  cwd: string,
  sessionId: string,
  prefix: string
): Promise<string | undefined> {
  const cached = cache.get(sessionId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    const found = longestStartingWith(cached.urls, prefix);
    if (found !== undefined) {
      return found;
    }
    // Nothing found — but the cached answer may just predate the message the url is in, and
    // the caller remembers a "no" for a while. Worth one fresh look before saying it.
  }
  return longestStartingWith(await fetchSessionUrls(executable, cwd, sessionId), prefix);
}

/** Every string value in a parsed json response, at any depth. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, out);
    }
  }
}

function longestStartingWith(urls: string[], prefix: string): string | undefined {
  let best: string | undefined;
  for (const url of urls) {
    if (url.length > prefix.length && url.startsWith(prefix) && (best === undefined || url.length > best.length)) {
      best = url;
    }
  }
  return best;
}

async function fetchSessionUrls(executable: string, cwd: string, sessionId: string): Promise<string[]> {
  const server = await runningServer(executable, cwd);
  if (!server) {
    return [];
  }
  const response = await server.request(`/session/${encodeURIComponent(sessionId)}/message`, cwd);
  // Every string in the response, whatever its shape: a url can sit in a message part, a
  // tool result or a summary, and this way no part of opencode's message schema has to be
  // tracked here. Parsed rather than scanned as raw text, though — json escapes would
  // otherwise end up inside the urls: a "\n" before one turns it into "nhttps://...", and
  // an escaped "\/" cuts it short, neither of which can ever match what's on screen.
  const strings: string[] = [];
  collectStrings(await response.json(), strings);
  const urls = findUrls(strings.join("\n"));
  cache.set(sessionId, { at: Date.now(), urls });
  return urls;
}
