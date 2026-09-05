import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Whether an `fs.watch` event means the watched directory itself is gone. Its deletion raises
 * no `error`: on win32 it is reported as an unending storm of events naming the directory's own
 * absolute path (measured on a repository watcher, each one scheduling a refresh), and on
 * Linux as one event carrying its basename after which the watch is silently
 * dead. Only an event that could be that pays for the `existsSync`. The caller closes the
 * watcher and arranges to pick the directory back up when it reappears — the repository's
 * retry loop, Claude's projects-root watcher.
 */
export function watchedDirectoryGone(dir: string, filename: string | null | undefined): boolean {
  return (!filename || path.isAbsolute(filename) || filename === path.basename(dir)) && !fs.existsSync(dir);
}
