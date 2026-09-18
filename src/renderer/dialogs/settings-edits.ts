function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the dialog changed from `loaded` to `edited`, laid over `current` — what is saved by now.
 * Down to a nested object's own keys: `tet-ctl` may have changed one prompt meanwhile, and editing
 * another must not take it back.
 */
export function withEdits<T extends object>(current: T, loaded: T, edited: T): T {
  const merged: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  const [was, now] = [loaded as Record<string, unknown>, edited as Record<string, unknown>];
  for (const key of Object.keys(now)) {
    if (JSON.stringify(was[key]) === JSON.stringify(now[key])) {
      continue;
    }
    const saved = merged[key];
    merged[key] = isRecord(now[key]) && isRecord(was[key]) && isRecord(saved) ? withEdits(saved, was[key], now[key]) : now[key];
  }
  return merged as T;
}
