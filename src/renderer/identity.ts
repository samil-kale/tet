/**
 * Same contents, same identity: `App`'s views are memoized on their props, so a list or record
 * rebuilt each render must return the previous instance when unchanged. See "The renderer" in
 * AGENTS.md.
 */

/** `previous` if it holds the same items, else `next`. */
export function sameList<T>(previous: T[] | undefined, next: T[], empty: T[]): T[] {
  if (next.length === 0) {
    return empty;
  }
  return previous && previous.length === next.length && previous.every((item, i) => item === next[i]) ? previous : next;
}

/**
 * Drops a closed checkout's (or project's) entry: nothing pushes for it, and a reopened folder gets
 * the same id, so a stale entry would show for a frame.
 */
export function forget<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/**
 * A record rebuilt every render, keeping each entry's identity where it is unchanged and the
 * record's own where every entry is. `same` decides what unchanged means; it defaults to the
 * entry's own fields compared by `===`, so a field added to the entry is compared without a line
 * of its own. `ref` holds what was last handed out.
 */
export function stableRecord<V extends object>(
  ref: { current: Record<string, V> },
  next: Record<string, V>,
  same: (previous: V, entry: V) => boolean = sameFields
): Record<string, V> {
  const held = ref.current;
  const kept: Record<string, V> = {};
  let changed = Object.keys(held).length !== Object.keys(next).length;
  for (const [key, entry] of Object.entries(next)) {
    const previous = held[key];
    kept[key] = previous !== undefined && same(previous, entry) ? previous : entry;
    changed ||= kept[key] !== previous;
  }
  if (!changed) {
    return held;
  }
  ref.current = kept;
  return kept;
}

/** The same own keys, each value the same object. */
function sameFields(previous: object, entry: object): boolean {
  const keys = Object.keys(entry);
  const before = previous as Record<string, unknown>;
  const after = entry as Record<string, unknown>;
  return keys.length === Object.keys(previous).length && keys.every((key) => before[key] === after[key]);
}

/** `previous` if it holds the same keys and values, else `next`. */
export function sameRecord<V>(previous: Record<string, V>, next: Record<string, V>): Record<string, V> {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) {
    return next;
  }
  return keys.every((key) => previous[key] === next[key]) ? previous : next;
}
