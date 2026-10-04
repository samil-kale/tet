import type { RefObject } from "react";
import { IconButton } from "./IconButton";
import { CollapseAllIcon, ExpandAllIcon } from "./icons";

/** What a tree header's collapse/expand button acts on, through the tree's handle. */
export interface CollapseExpandAll {
  expandAll(): void;
  collapseAll(): void;
}

/**
 * A tree header's one collapse/expand button: Collapse All while `expanded`, else Expand All. The
 * tree reports `expanded` as it changes, since it holds what is expanded.
 */
export function CollapseExpandAllButton({
  expanded,
  disabled,
  tree
}: {
  expanded: boolean;
  disabled: boolean;
  tree: RefObject<CollapseExpandAll | null>;
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
