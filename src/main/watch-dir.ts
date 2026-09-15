import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Whether an `fs.watch` event means the watched directory itself is gone, which raises no `error`:
 * on win32 an endless storm of events naming its absolute path (measured on a repository watcher,
 * each scheduling a refresh), on Linux one event with its basename, then a silently dead watch.
 * Only such an event pays for the `existsSync`; the caller closes the watcher and re-arms later.
 */
export function watchedDirectoryGone(dir: string, filename: string | null | undefined): boolean {
  return (!filename || path.isAbsolute(filename) || filename === path.basename(dir)) && !fs.existsSync(dir);
}

/**
 * Watches the directory an agent keeps a repository's transcripts in, or the root above it while
 * that is missing — fs.watch throws ENOENT on one, and the agent creates it with the first
 * transcript. Non-recursive on purpose: writes in a session's subdirectory (Claude's `subagents/`)
 * don't fire, the rest are filtered by `wanted`. `find` may reject when the root itself is absent
 * (a fresh install), read as "not yet". Returns the stop function.
 */
export function watchTranscriptDir(
  root: () => string,
  find: () => Promise<string | undefined>,
  wanted: (filename: string) => boolean,
  onChange: () => void
): () => void {
  let dirWatcher: fs.FSWatcher | undefined;
  let rootWatcher: fs.FSWatcher | undefined;
  let stopped = false;

  const armDirWatcher = async (): Promise<void> => {
    if (stopped || dirWatcher) {
      return;
    }
    const dir = await find().catch(() => undefined);
    if (!dir || stopped || dirWatcher) {
      return;
    }
    const onEvent = (_eventType: string, filename: string | null): void => {
      // Directory deleted: back to watching the root until the agent recreates it.
      if (watchedDirectoryGone(dir, filename)) {
        dirWatcher?.close();
        dirWatcher = undefined;
        armRootWatcher();
        return;
      }
      // A null filename means "something changed" — reconcile to be safe.
      if (filename === null || wanted(filename)) {
        onChange();
      }
    };
    try {
      dirWatcher = fs.watch(dir, onEvent);
    } catch {
      // Gone again since the lookup, or no descriptor left: the listing stays polled.
      return;
    }
    rootWatcher?.close();
    rootWatcher = undefined;
  };

  const armRootWatcher = (): void => {
    if (stopped || dirWatcher || rootWatcher) {
      return;
    }
    try {
      rootWatcher = fs.watch(root(), () => void armDirWatcher());
    } catch {
      // The agent never ran on this machine: the listing stays polled.
    }
  };

  void armDirWatcher().then(armRootWatcher);

  return () => {
    stopped = true;
    dirWatcher?.close();
    rootWatcher?.close();
  };
}
