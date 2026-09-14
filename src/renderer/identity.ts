/**
 * "Same contents, same identity": the views under `App` are memoized on their props, so a list
 * or record rebuilt every render must come back as the previous instance whenever nothing in it
 * changed, or the memo never holds. See "The renderer" in CLAUDE.md.
 */

/** `next` unless `previous` already holds the same items — then that one. */
export function sameList<T>(previous: T[] | undefined, next: T[], empty: T[]): T[] {
  if (next.length === 0) {
    return empty;
  }
  return previous && previous.length === next.length && previous.every((item, i) => item === next[i]) ? previous : next;
}

/**
 * A per-project record without that project. Nothing pushes for a closed project, and a folder
 * opened again gets the same id, so stale entries would show for a frame.
 */
export function forget<T>(record: Record<string, T>, projectId: string): Record<string, T> {
  const rest = { ...record };
  delete rest[projectId];
  return rest;
}

/** `next` unless `previous` already holds the same keys and values — then that one. */
export function sameRecord<V>(previous: Record<string, V>, next: Record<string, V>): Record<string, V> {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) {
    return next;
  }
  return keys.every((key) => previous[key] === next[key]) ? previous : next;
}
