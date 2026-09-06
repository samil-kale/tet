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

/**
 * Watches the one directory an agent keeps a repository's transcripts in, for as long as it
 * exists — and the root above it while it does not, since fs.watch throws ENOENT on a missing
 * directory and the agent creates it only with the repository's first transcript (Claude Code's
 * project directory, pi's session directory). Non-recursive on purpose: a write inside a
 * session's own subdirectory (Claude's `subagents/`) then doesn't fire at all, and the entries
 * that do are filtered by `wanted`. `find` answers the directory or undefined, and may reject
 * when the root itself is absent — the normal starting state for a fresh install, read here as
 * "not yet". Returns the stop function.
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
      // The directory itself deleted (a cleared `~/.claude/projects`): back to the first
      // stage, which arms this again once the agent recreates it.
      if (watchedDirectoryGone(dir, filename)) {
        dirWatcher?.close();
        dirWatcher = undefined;
        armRootWatcher();
        return;
      }
      // A null filename means "something here changed" on platforms that don't report
      // it — reconciling then is the safe read.
      if (filename === null || wanted(filename)) {
        onChange();
      }
    };
    try {
      dirWatcher = fs.watch(dir, onEvent);
    } catch {
      // Gone again between the lookup and the watch, or no descriptor left for one: the
      // listing stays polled, as it is before the agent ever ran here. Codex and opencode
      // guard their watch the same way.
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
      // The agent has never run on this machine — nothing to watch, listing stays polled.
    }
  };

  void armDirWatcher().then(armRootWatcher);

  return () => {
    stopped = true;
    dirWatcher?.close();
    rootWatcher?.close();
  };
}
