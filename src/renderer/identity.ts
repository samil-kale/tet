/**
 * "Same contents, same identity": the views under `App` are memoized on their props (see "The
 * renderer" in CLAUDE.md), so a list or record rebuilt every render must come back as the
 * previous instance whenever nothing in it changed — or the memo never holds.
 */

/** `next` unless `previous` already holds the same items — then that one, identity and all. */
export function sameList<T>(previous: T[] | undefined, next: T[], empty: T[]): T[] {
  if (next.length === 0) {
    return empty;
  }
  return previous && previous.length === next.length && previous.every((item, i) => item === next[i]) ? previous : next;
}

/** `next` unless `previous` already holds the same keys and values — then that one, identity and all. */
export function sameRecord<V>(previous: Record<string, V>, next: Record<string, V>): Record<string, V> {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) {
    return next;
  }
  return keys.every((key) => previous[key] === next[key]) ? previous : next;
}
