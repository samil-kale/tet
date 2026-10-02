import type { RefObject } from "react";
import { IconButton } from "./IconButton";
import { CollapseAllIcon, ExpandAllIcon } from "./icons";

/** What a tree header's fold button acts on, through the tree's handle. */
export interface FoldAll {
  expandAll(): void;
  collapseAll(): void;
}

/**
 * A tree header's one fold button: Collapse All while `expanded`, else Expand All. The tree reports
 * `expanded` as it changes, since it holds what is open.
 */
export function FoldAllButton({
  expanded,
  disabled,
  tree
}: {
  expanded: boolean;
  disabled: boolean;
  tree: RefObject<FoldAll | null>;
}) {
  return (
    <IconButton
      title={expanded ? "Collapse All" : "Expand All"}
      disabled={disabled}
      onClick={() => (expanded ? tree.current?.collapseAll() : tree.current?.expandAll())}
    >
      {expanded ? <CollapseAllIcon /> : <ExpandAllIcon />}
    </IconButton>
  );
}
