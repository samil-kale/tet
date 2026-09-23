import type { ReactNode } from "react";
import { CircleAlertIcon, CloseIcon } from "./icons";

/** A row as a dialog's fields hold it: the saved shape plus a local React key, never sent anywhere. */
export type Row<T> = T & { id: string };

let nextRowId = 0;
export function withId<T>(row: T): Row<T> {
  nextRowId += 1;
  return { ...row, id: `row-${nextRowId}` };
}

/** The two things every section does to one of its rows, by the id `withId` gave it. */
export function patched<T extends { id: string }>(rows: T[], id: string, change: Partial<T>): T[] {
  return rows.map((entry) => (entry.id === id ? { ...entry, ...change } : entry));
}

export function without<T extends { id: string }>(rows: T[], id: string): T[] {
  return rows.filter((entry) => entry.id !== id);
}

/**
 * A section's row: its fields, then the mark saying what is wrong with it, then its remove button —
 * none for a row that is asked for rather than kept (EnvDialog). The mark takes its room from the
 * field before it (styles.css), so nothing else in the row moves.
 */
export function EditRow({
  mark,
  remove,
  onRemove,
  children
}: {
  mark?: string;
  children: ReactNode;
} & ({ remove: string; onRemove: () => void } | { remove?: undefined; onRemove?: undefined })) {
  return (
    <div className="edit-row">
      {children}
      <RowMark title={mark} />
      {onRemove && <RemoveRow title={remove} onClick={onRemove} />}
    </div>
  );
}

/** Nothing without a reason. Outside an EditRow too, beside a field of a grid (the SBX Settings'
 *  knowledge). */
export function RowMark({ title }: { title: string | undefined }) {
  return title === undefined ? null : (
    <span className="row-mark" title={title}>
      <CircleAlertIcon />
    </span>
  );
}

function RemoveRow({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button className="icon-button" title={title} onClick={onClick}>
      <CloseIcon />
    </button>
  );
}

/**
 * The box a section's rows sit in: its label, the rows or a line saying there are none, and what
 * adds one underneath — nothing for rows that come from elsewhere.
 */
export function RowSection<T extends { id: string }>({
  label,
  empty,
  rows,
  renderRow,
  add
}: {
  label: string;
  empty: string;
  rows: T[];
  renderRow: (row: T) => ReactNode;
  add?: ReactNode;
}) {
  return (
    <div className="dialog-field">
      <span className="dialog-field-label">{label}</span>
      <div className="row-section-rows">
        {rows.length === 0 && <p className="dialog-detail">{empty}</p>}
        {rows.map(renderRow)}
      </div>
      {add}
    </div>
  );
}
