import type { DragEvent, MouseEvent, ReactNode, Ref } from "react";
import { ChevronIcon } from "./icons";

/* VS Code's indent: TreeRenderer's DefaultIndent and `workbench.tree.indent` (both 8). The chevron
 * sits as in the branch tree's headers (`.tree-header` in styles.css: 9px in, 4px before the label),
 * not as VS Code's `.monaco-tl-twistie`. A file has no chevron — views.css zeroes it under
 * `align-icons-and-twisties`, which Seti (file icons, no folder icons) turns on — so its file icon sits
 * where a sibling folder's chevron does, its label level with the folder's (.file-icon in styles.css). */
export const INDENT_STEP = 8;
export const INDENT_BASE = 9;
/** Holds a folder's chevron: the chevron's own box, `--icon-size` in styles.css. */
const CHEVRON_WIDTH = 14;
const CHEVRON_GAP = 4;
/** A match row starts a pixel past its file row's label (`INDENT_BASE` plus the chevron and its
 *  gap): the line it found gets the width the rest of the nesting would have eaten. */
export const MATCH_INDENT = INDENT_BASE + CHEVRON_WIDTH + CHEVRON_GAP + 1;
/** A level of every other tree TET lays out itself (BRANCHES, the GRAPH's finds): one column, the
 *  width a chevron, an icon or a status letter takes with its gap, so a child starts under its
 *  parent's label. */
export const COLUMN_STEP = CHEVRON_WIDTH + CHEVRON_GAP;
/** A level of a tree with checkboxes, as IntelliJ's: every row keeps the chevron's box, so a child's
 *  checkbox stands just past its parent's (`.tree-checkbox`'s 16px and 1px more). */
export const CHECK_INDENT_STEP = 17;

/** What a row dragged onto a terminal carries: its path on this machine (`TreeRow`'s `dragPath`). */
export const PATH_DRAG_TYPE = "application/x-tet-path";
/** What a commit's row dragged onto a terminal carries: its full hash (`TreeRow`'s `dragCommit`). */
export const COMMIT_DRAG_TYPE = "application/x-tet-commit";

/**
 * A row of a tree or list (`.tree-row`), in the branch tree, the Explorer, SEARCH and LOCAL
 * CHANGES alike: what leads it (`icon`: an icon, a chevron, a checkbox), its label, then what
 * trails it (`children`: counts, a folder, a branch's base). `indent` is its left padding.
 */
export function TreeRow({
  icon,
  label,
  children,
  className,
  indent,
  title,
  dragPath,
  dragCommit,
  onDragStart,
  onDragOver,
  onClick,
  onDoubleClick,
  onContextMenu,
  ref,
}: {
  icon?: ReactNode;
  label: ReactNode;
  children?: ReactNode;
  /** Beside `tree-row`: `current`, `selected`, the view's own. */
  className?: string;
  indent?: number;
  title?: string;
  /** The row's absolute path, where it can be dragged onto a terminal, which types it as it does a
   *  dropped file's. Path alone, no text: a field or an editor takes nothing of it. */
  dragPath?: string;
  /** The row's commit, its full hash, where it can be dragged onto a terminal, which types it as
   *  its agent reads one. */
  dragCommit?: string;
  /** For a view that moves its rows by dragging them within it: a drag of this row began, and one
   *  is held over it. */
  onDragStart?: () => void;
  onDragOver?: (event: DragEvent) => void;
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  // A path is copied into a terminal and moved within its own view, a commit only copied.
  const drag =
    dragPath !== undefined
      ? ({ type: PATH_DRAG_TYPE, data: dragPath, effect: "copyMove" } as const)
      : dragCommit !== undefined
        ? ({ type: COMMIT_DRAG_TYPE, data: dragCommit, effect: "copy" } as const)
        : undefined;
  return (
    <button
      ref={ref}
      type="button"
      className={className ? `tree-row ${className}` : "tree-row"}
      style={indent === undefined ? undefined : { paddingLeft: indent }}
      title={title}
      draggable={drag !== undefined}
      onDragStart={
        drag === undefined
          ? undefined
          : (event) => {
              event.dataTransfer.setData(drag.type, drag.data);
              event.dataTransfer.effectAllowed = drag.effect;
              onDragStart?.();
            }
      }
      onDragOver={onDragOver}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span className="tree-label">{label}</span>
      {children}
    </button>
  );
}

/** Whether the files under a row are checked: all, some, or none of them. */
export type CheckState = boolean | "mixed";

/** A row's checkbox, drawn as the dialogs' (`.tree-checkbox` in styles.css); "mixed" for a folder
 *  partly checked. Not an `<input>`: the row is a button. Its click stays its own, as an
 *  `IconButton`'s `isolated`. */
export function TreeCheckbox({ checked, onToggle }: { checked: CheckState; onToggle: () => void }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      className="tree-checkbox"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

/** A folder's or a result file's chevron, in the box the labels are measured against. Without
 *  `expanded`, the box alone: a changed file's checkbox stands under its folder's. */
export function ChevronBox({ expanded }: { expanded?: boolean }) {
  return (
    <span
      style={{
        display: "flex",
        flex: "none",
        width: CHEVRON_WIDTH,
        alignSelf: "stretch",
        alignItems: "center",
        justifyContent: "center",
        marginRight: CHEVRON_GAP,
      }}
    >
      {expanded !== undefined && <ChevronIcon expanded={expanded} className="tree-icon" />}
    </span>
  );
}
