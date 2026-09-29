import type { MouseEvent, ReactNode, Ref } from "react";
import { ChevronIcon, TREE_CHEVRON } from "./icons";

/* VS Code's indent: TreeRenderer's DefaultIndent and `workbench.tree.indent` (both 8). The chevron
 * sits as in the branch tree's headers (`.tree-header` in styles.css: 9px in, 4px before the label),
 * not as VS Code's `.monaco-tl-twistie`. A file has no twistie — views.css zeroes it under
 * `align-icons-and-twisties`, which Seti (file icons, no folder icons) turns on — so its mark sits
 * where a sibling folder's chevron does, its label level with the folder's (.file-mark in styles.css). */
export const INDENT_STEP = 8;
export const INDENT_BASE = 9;
/** Holds a folder's chevron: the chevron's own 12px box. */
const TWISTIE_WIDTH = 12;
const TWISTIE_GAP = 4;
/** A match row starts a pixel past its file row's label (`INDENT_BASE` plus the twistie and its
 *  gap): the line it found gets the width the rest of the nesting would have eaten. */
export const MATCH_INDENT = INDENT_BASE + TWISTIE_WIDTH + TWISTIE_GAP + 1;

/**
 * A row of a tree or list (`.tree-item`), in the branch tree, the Explorer, SEARCH and LOCAL
 * CHANGES alike: what leads it (`icon`: an icon, a twistie, a status letter), its label, then what
 * trails it (`children`: counts, a folder, a branch's base). `indent` is its left padding.
 */
export function TreeRow({
  icon,
  label,
  children,
  className,
  indent,
  title,
  onClick,
  onDoubleClick,
  onContextMenu,
  ref
}: {
  icon?: ReactNode;
  label: ReactNode;
  children?: ReactNode;
  /** Beside `tree-item`: `current`, `selected`, the view's own. */
  className?: string;
  indent?: number;
  title?: string;
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={className ? `tree-item ${className}` : "tree-item"}
      style={indent === undefined ? undefined : { paddingLeft: indent }}
      title={title}
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

/** A folder's or a result file's chevron, in the box the labels are measured against. */
export function Twistie({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: "flex",
        flex: "none",
        width: TWISTIE_WIDTH,
        alignSelf: "stretch",
        alignItems: "center",
        justifyContent: "center",
        marginRight: TWISTIE_GAP
      }}
    >
      <ChevronIcon expanded={open} className="tree-icon" scale={TREE_CHEVRON} />
    </span>
  );
}
