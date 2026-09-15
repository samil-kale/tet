import { findUrls } from "../../../shared/urls";
import { runOpencode } from "./cli";
import { sessionSandbox } from "./sessions";

/**
 * opencode's TUI breaks a long url at the last "." that fits, indistinguishable in the buffer; the
 * session's messages hold it whole (AgentDefinition.resolveUrlPrefix).
 */

/** Long enough to not refetch on a repeated hover, short enough to find a url just printed. */
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
    // The cache may predate the url's message.
  }
  return longestStartingWith(await fetchSessionUrls(executable, cwd, sessionId), prefix);
}

/** Every string value, at any depth. */
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
 * `opencode export <id>` prints the session as json on stdout (banner on stderr, measured). ~1.5 s
 * per run, fine on hover once per fragment; run where the session's record says it lives.
 */
async function fetchSessionUrls(executable: string, cwd: string, sessionId: string): Promise<string[]> {
  const output = await runOpencode(executable, cwd, sessionSandbox(cwd, sessionId), ["export", sessionId]);
  // Every string, so opencode's message schema needn't be tracked. Parsed, not scanned raw: json
  // escapes would corrupt urls ("\n" gives "nhttps://...", "\/" cuts one short).
  const strings: string[] = [];
  collectStrings(JSON.parse(output), strings);
  const urls = findUrls(strings.join("\n"));
  cache.set(sessionId, { at: Date.now(), urls });
  return urls;
}
