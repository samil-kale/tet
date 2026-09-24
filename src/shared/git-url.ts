/** What tet reads off a remote's url for a login: the host it is for, the user it names, and the
 *  url as it may be shown. An scp-style `git@host:path` is no url at all here, and gets nothing. */

/** "https://host[:port]" for an http(s) url, username and path dropped; "" for anything else — an
 *  ssh remote or a local path has no login to type, and neither has a url carrying its own
 *  password, which git uses in place of asking. askpass never answers for "". */
export function urlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.password === ""
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

/** The username written into a url (`https://saka@host/...`), "" where there is none: git then
 *  asks only for its password. */
export function urlUsername(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return "";
  }
}
