import type { ReactNode } from "react";
import { CloseIcon } from "./icons";

/** Every row's last cell. */
export function RemoveRow({ title, onClick }: { title: string; onClick: () => void }) {
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
      <div className="sbx-rows">
        {rows.length === 0 && <p className="dialog-detail">{empty}</p>}
        {rows.map(renderRow)}
      </div>
      {add}
    </div>
  );
}
