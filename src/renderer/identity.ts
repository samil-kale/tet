/**
 * Same contents, same identity: `App`'s views are memoized on their props, so a list or record
 * rebuilt each render must return the previous instance when unchanged. See "The renderer" in
 * CLAUDE.md.
 */

/** `previous` if it holds the same items, else `next`. */
export function sameList<T>(previous: T[] | undefined, next: T[], empty: T[]): T[] {
  if (next.length === 0) {
    return empty;
  }
  return previous && previous.length === next.length && previous.every((item, i) => item === next[i]) ? previous : next;
}

/**
 * Drops a closed project's entry: nothing pushes for it, and a reopened folder gets the same id, so
 * a stale entry would show for a frame.
 */
export function forget<T>(record: Record<string, T>, projectId: string): Record<string, T> {
  const rest = { ...record };
  delete rest[projectId];
  return rest;
}

/** `previous` if it holds the same keys and values, else `next`. */
export function sameRecord<V>(previous: Record<string, V>, next: Record<string, V>): Record<string, V> {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) {
    return next;
  }
  return keys.every((key) => previous[key] === next[key]) ? previous : next;
}
