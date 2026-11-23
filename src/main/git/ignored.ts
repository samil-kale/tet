import * as path from "node:path";
import { git } from "./git-client";

/**
 * git's ignore list per repository root (git.ts's `listIgnored`), asked once per change: the
 * Explorer's listing and each search query read it, and so does the watcher to drop what happens
 * under an ignored folder. The list changes only where a path appears or goes or an ignore file is
 * edited, which `invalidateIgnored` is told of.
 */

interface Cached {
  generation: number;
  /** In flight or done: callers arriving meanwhile share it. */
  list: Promise<string[]>;
}

const generations = new Map<string, number>();
const cached = new Map<string, Cached>();

/** The entries are shared between callers: not to be changed. A failed read is not kept. */
export function listIgnored(root: string): Promise<string[]> {
  const key = path.resolve(root);
  const generation = generations.get(key) ?? 0;
  const known = cached.get(key);
  if (known?.generation === generation) {
    return known.list;
  }
  const list = git.listIgnored(root);
  cached.set(key, { generation, list });
  list.catch(() => {
    if (cached.get(key)?.list === list) {
      cached.delete(key);
    }
  });
  return list;
}

/** The next `listIgnored` asks git again; a read already running stays what it was for its callers. */
export function invalidateIgnored(root: string): void {
  const key = path.resolve(root);
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

/** For a repository that closed. */
export function forgetIgnored(root: string): void {
  const key = path.resolve(root);
  generations.delete(key);
  cached.delete(key);
}
