/**
 * `record[key]` only where the record itself holds it. For a key that comes from outside — a
 * branch, a typed row, a flag: one named as a property every object has (`constructor`) would
 * read that property off the record instead of nothing.
 */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
