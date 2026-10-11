import type { HTMLAttributes, ReactNode } from "react";
import { overridesMachineNote } from "../../shared/types/environment";
import { ActionLink } from "./ActionLink";
import { useDragReorder } from "./drag-reorder";
import { FieldGroup } from "./Field";
import { IconButton } from "./IconButton";
import { CircleAlertIcon, CloseIcon, GripIcon } from "./icons";

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
 * What a section of typed rows adds and removes, named by `noun` ("+ Add port", "Remove port"):
 * `add` for `RowSection`, `remove(id)` spread onto each `EditRow`. A removed last row leaves `blank`
 * in its place (`atLeastOne`), the row "+ Add" makes too. `change` edits the rows.
 */
export function typedRows<T>(
  noun: string,
  blank: T,
  change: (update: (rows: Row<T>[]) => Row<T>[]) => void,
): { add: ReactNode; remove: (id: string) => { remove: string; onRemove: () => void } } {
  return {
    add: <ActionLink onClick={() => change((rows) => [...rows, withId(blank)])}>+ Add {noun}</ActionLink>,
    remove: (id) => ({ remove: `Remove ${noun}`, onRemove: () => change((rows) => atLeastOne(without(rows, id), blank)) }),
  };
}

/** What a section that can be reordered (`RowSection`'s `reorder`) hands each row to spread onto it:
 *  the row's drag handlers and its drag classes (drag-reorder.ts). */
export interface RowReorder {
  props: HTMLAttributes<HTMLElement> & { draggable: true };
  classes: string[];
}

/**
 * A section's row: its fields, then the mark saying what is wrong with it, then its remove button —
 * none for a row that is asked for rather than kept (EnvDialog). The mark takes its room from the
 * field before it (styles.css), so nothing else in the row moves. A row of a reorderable section
 * (`reorder`) leads with a grip and is dragged whole; one switched off (`off`) is dimmed, but for
 * its buttons, which still switch it on.
 */
export function EditRow({
  mark,
  remove,
  onRemove,
  reorder,
  off,
  className,
  children,
}: {
  mark?: string;
  reorder?: RowReorder;
  off?: boolean;
  /** Beside `edit-row`, for a section's own placement of its fields. */
  className?: string;
  children: ReactNode;
} & ({ remove: string; onRemove: () => void } | { remove?: undefined; onRemove?: undefined })) {
  return (
    <div
      className={["edit-row", ...(className ? [className] : []), ...(reorder?.classes ?? []), ...(off ? ["off"] : [])].join(" ")}
      {...reorder?.props}
    >
      {reorder && <GripIcon className="row-grip" />}
      {children}
      <RowMark title={mark} />
      {onRemove && (
        <IconButton title={remove} onClick={onRemove}>
          <CloseIcon />
        </IconButton>
      )}
    </div>
  );
}

/** A row's text field: taking the row's free room, a fixed width (`fixed`), or a port's (`port`,
 *  digits on a touch keyboard). */
export function RowInput({
  width = "fill",
  placeholder,
  title,
  readOnly,
  value,
  onChange,
}: {
  width?: "fill" | "fixed" | "port";
  placeholder?: string;
  title?: string;
  /** A field that only shows: not dimmed, as an unavailable one is. */
  readOnly?: boolean;
  value: string;
  /** Left out for a field that only shows (`readOnly`). */
  onChange?: (value: string) => void;
}) {
  return (
    <input
      className={width === "port" ? "sbx-port-input" : `row-${width}-input`}
      type="text"
      inputMode={width === "port" ? "numeric" : undefined}
      placeholder={placeholder}
      title={title}
      readOnly={readOnly}
      value={value}
      onChange={onChange && ((event) => onChange(event.target.value))}
    />
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
}: {
  stored: boolean;
  storedTitle?: string;
  emptyTitle?: string;
  /** What an empty field without a stored value says it takes. */
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
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

/** The first of the rows' marks: Save waits for every marked row, and the dialog's tab repeats it. */
export function firstMark(marks: Iterable<string | undefined>): string | undefined {
  return Array.from(marks).find((mark) => mark !== undefined);
}

/**
 * The box a section's rows sit in: its label, the rows, and what adds one underneath — nothing for
 * rows that come from elsewhere. A section has rows to type into or none (`atLeastOne`); only one
 * whose rows a picker adds says when there are none. With `reorder`, its rows are dragged into
 * another order: `renderRow` hands each to its `EditRow`.
 */
export function RowSection<T extends { id: string }>({
  label,
  empty,
  rows,
  renderRow,
  add,
  reorder,
}: {
  label: string;
  /** Said where there are no rows, for a section a picker adds them to (the SBX paths); left out
   *  where a blank row stands in for none (`atLeastOne`), or rows always are. */
  empty?: string;
  rows: T[];
  renderRow: (row: T, reorder: RowReorder | undefined) => ReactNode;
  add?: ReactNode;
  /** The section's own drag type (drag-reorder.ts) and the move of the row at `from` to the
   *  insertion index `to` (`reorder()` there). */
  reorder?: { dragType: string; onMove: (from: number, to: number) => void };
}) {
  const drag = useDragReorder({
    dragType: reorder?.dragType ?? "",
    count: rows.length,
    payloadOf: (index) => rows[index].id,
    indexOf: (id) => rows.findIndex((row) => row.id === id),
    onMove: (from, to) => reorder?.onMove(from, to),
  });
  return (
    <FieldGroup label={label}>
      <div className="row-section-rows" {...(reorder ? drag.listProps : {})}>
        {rows.length === 0 && empty !== undefined && <p className="dialog-detail">{empty}</p>}
        {rows.map((row, index) => renderRow(row, reorder && { props: drag.rowProps(index), classes: drag.rowClasses(index) }))}
      </div>
      {add}
    </FieldGroup>
  );
}
