import { useEffect, useState } from "react";
import type { TrackedRow } from "../../../shared/types/providers";

/** How long a row takes to unfold or fold away; the stylesheet's `.issue-item` transition. */
const ROW_MS = 350;

export interface TrackedRowItem<T extends TrackedRow = TrackedRow> {
  item: T;
  /** New to the host's list since the one before: it unfolds. */
  entering: boolean;
  /** Gone from the host's list: it folds away where it stood, then goes. */
  leaving: boolean;
}

function settled<T extends TrackedRow>(items: readonly T[] | undefined): TrackedRowItem<T>[] {
  return (items ?? []).map((item) => ({ item, entering: false, leaving: false }));
}

/**
 * `items` as rows after `previous`: a row new to the list enters, one gone from it stays leaving
 * after the row it stood behind, one that comes back while leaving unfolds again from where it is.
 */
export function mergeTrackedRows<T extends TrackedRow>(previous: readonly TrackedRowItem<T>[], items: readonly T[]): TrackedRowItem<T>[] {
  const before = new Map(previous.map((row) => [row.item.number, row]));
  const rows = items.map((item): TrackedRowItem<T> => ({ item, entering: before.get(item.number)?.entering ?? true, leaving: false }));
  let at = 0;
  for (const row of previous) {
    const found = rows.findIndex((kept) => kept.item.number === row.item.number);
    if (found !== -1) {
      at = found + 1;
      continue;
    }
    rows.splice(at, 0, { item: row.item, entering: false, leaving: true });
    at += 1;
  }
  return rows;
}

/**
 * The rows of the Issues section and of the change requests section: what the host added or removed
 * enters or leaves, in `ROW_MS`.
 * The first list and the first under a changed filter come as they are, as they change nothing on
 * the host. Worked out in render, so a row gone never paints without its leaving.
 */
export function useTrackedRows<T extends TrackedRow>(items: T[] | undefined, filter: object): TrackedRowItem<T>[] {
  const filterKey = JSON.stringify(filter);
  const [state, setState] = useState(() => ({ items, filterKey, rows: settled(items) }));
  if (state.items !== items) {
    const changed = state.items !== undefined && state.filterKey === filterKey;
    setState({ items, filterKey, rows: changed ? mergeTrackedRows(state.rows, items ?? []) : settled(items) });
  }

  const { rows } = state;
  useEffect(() => {
    if (!rows.some((row) => row.entering || row.leaving)) {
      return;
    }
    // Entering ends too: a row the text filter shows again would replay it.
    const timer = setTimeout(
      () =>
        setState((current) => ({
          ...current,
          rows: current.rows.filter((row) => !row.leaving).map((row) => (row.entering ? { ...row, entering: false } : row)),
        })),
      ROW_MS,
    );
    return () => clearTimeout(timer);
  }, [rows]);

  return rows;
}
