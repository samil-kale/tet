import { findUrls } from "../../../shared/urls";
import { runOpencode } from "./cli";
import { sessionSandbox } from "./sessions";

/**
 * A url too long for the terminal width is broken across rows by opencode's TUI at the last "."
 * that still fits, leaving nothing in the buffer to tell that break from an ordinary one. The
 * session's messages hold the url whole — see AgentDefinition.resolveUrlPrefix.
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
    // The cached answer may predate the message the url is in — worth one fresh look.
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

/**
 * `opencode export <id>` prints the whole session as json on stdout (its banner goes to stderr,
 * measured) — a process of its own (~1.5 s), affordable here: only on hover, at most once per
 * fragment, and where the session lives, host or sandbox, as its record says.
 */
async function fetchSessionUrls(executable: string, cwd: string, sessionId: string): Promise<string[]> {
  const output = await runOpencode(executable, cwd, sessionSandbox(cwd, sessionId), ["export", sessionId]);
  // Every string in the response, whatever its shape, so no part of opencode's message schema
  // has to be tracked here. Parsed rather than scanned as raw text: json escapes would end up
  // inside the urls — a "\n" before one turns it into "nhttps://...", an escaped "\/" cuts it
  // short.
  const strings: string[] = [];
  collectStrings(JSON.parse(output), strings);
  const urls = findUrls(strings.join("\n"));
  cache.set(sessionId, { at: Date.now(), urls });
  return urls;
}
