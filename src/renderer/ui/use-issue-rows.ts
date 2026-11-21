import { useEffect, useState } from "react";
import type { Issue } from "../../shared/types/providers";

/** How long a row takes to unfold or fold away; the stylesheet's `.issue-item` transition. */
const ROW_MS = 350;

export interface IssueRowItem<T extends Issue = Issue> {
  issue: T;
  /** New to the tracker's list since the one before: it unfolds. */
  entering: boolean;
  /** Gone from the tracker's list: it folds away where it stood, then goes. */
  leaving: boolean;
}

function settled<T extends Issue>(issues: readonly T[] | undefined): IssueRowItem<T>[] {
  return (issues ?? []).map((issue) => ({ issue, entering: false, leaving: false }));
}

/**
 * `issues` as rows after `previous`: a row new to the list enters, one gone from it stays leaving
 * after the row it stood behind, one that comes back while leaving unfolds again from where it is.
 */
export function mergeIssueRows<T extends Issue>(previous: readonly IssueRowItem<T>[], issues: readonly T[]): IssueRowItem<T>[] {
  const before = new Map(previous.map((row) => [row.issue.number, row]));
  const rows = issues.map((issue): IssueRowItem<T> => ({ issue, entering: before.get(issue.number)?.entering ?? true, leaving: false }));
  let at = 0;
  for (const row of previous) {
    const found = rows.findIndex((kept) => kept.issue.number === row.issue.number);
    if (found !== -1) {
      at = found + 1;
      continue;
    }
    rows.splice(at, 0, { issue: row.issue, entering: false, leaving: true });
    at += 1;
  }
  return rows;
}

/**
 * The rows of the Issues section and of the change requests section: what the host added or removed
 * enters or leaves, in `ROW_MS`.
 * The first list and the first under a changed filter come as they are, as they change nothing on
 * the tracker. Worked out in render, so a row gone never paints without its leaving.
 */
export function useIssueRows<T extends Issue>(issues: T[] | undefined, filter: object): IssueRowItem<T>[] {
  const filterKey = JSON.stringify(filter);
  const [state, setState] = useState(() => ({ issues, filterKey, rows: settled(issues) }));
  if (state.issues !== issues) {
    const changed = state.issues !== undefined && state.filterKey === filterKey;
    setState({ issues, filterKey, rows: changed ? mergeIssueRows(state.rows, issues ?? []) : settled(issues) });
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
