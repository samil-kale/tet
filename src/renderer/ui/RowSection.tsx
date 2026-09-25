import type { ReactNode, Ref } from "react";
import { overridesMachineNote } from "../../shared/types";
import { FieldGroup } from "./Field";
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

/** The rows, or a `blank` one where there are none: a section whose rows are typed always shows
 *  one to type into, on opening and once the last is removed, never a line saying there are none.
 *  A blank row saves as no row (each section's Save drops it). */
export function atLeastOne<T>(rows: Row<T>[], blank: T): Row<T>[] {
  return rows.length === 0 ? [withId(blank)] : rows;
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

/**
 * A row's value field for a secret: a stored value shows as a set password, never the value itself
 * (the title says so).
 */
export function SecretInput({
  stored,
  storedTitle = "Stored on this machine; typing replaces it.",
  emptyTitle = "Stored on this machine.",
  placeholder = "Value",
  value,
  onChange,
  ref
}: {
  stored: boolean;
  storedTitle?: string;
  emptyTitle?: string;
  /** What an empty field without a stored value says it takes. */
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** The field a dialog opens focused. */
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={ref}
      className="row-fixed-input"
      type="password"
      autoComplete="off"
      placeholder={stored ? "••••••••" : placeholder}
      title={stored ? storedTitle : emptyTitle}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Beside the name of a variable TET keeps that the machine sets too. */
export function OverridesMachine({ name }: { name: string }) {
  return (
    <span className="env-overrides" title={overridesMachineNote([name])}>
      overrides machine
    </span>
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
    <button type="button" className="icon-button" title={title} onClick={onClick}>
      <CloseIcon />
    </button>
  );
}

/**
 * The box a section's rows sit in: its label, the rows, and what adds one underneath — nothing for
 * rows that come from elsewhere. A section has rows to type into or none (`atLeastOne`); only one
 * whose rows a picker adds says when there are none.
 */
export function RowSection<T extends { id: string }>({
  label,
  empty,
  rows,
  renderRow,
  add
}: {
  label: string;
  /** Said where there are no rows, for a section a picker adds them to (the SBX paths); left out
   *  where a blank row stands in for none (`atLeastOne`), or rows always are. */
  empty?: string;
  rows: T[];
  renderRow: (row: T) => ReactNode;
  add?: ReactNode;
}) {
  return (
    <FieldGroup label={label}>
      <div className="row-section-rows">
        {rows.length === 0 && empty !== undefined && <p className="dialog-detail">{empty}</p>}
        {rows.map(renderRow)}
      </div>
      {add}
    </FieldGroup>
  );
}
