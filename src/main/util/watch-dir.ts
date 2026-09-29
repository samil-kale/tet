import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Whether an `fs.watch` event means the watched directory itself is gone, which raises no `error`:
 * on win32 an endless storm of events naming its absolute path, on Linux one event with its
 * basename, then a silently dead watch. Only such an event pays for the `existsSync`; the caller
 * closes the watcher and re-arms later.
 */
export function watchedDirectoryGone(dir: string, filename: string | null | undefined): boolean {
  return (!filename || path.isAbsolute(filename) || filename === path.basename(dir)) && !fs.existsSync(dir);
}
