import type { ExplorerListing, ExplorerRoot, ExplorerSortOrder } from "../../../shared/types/files";
import { extensionOf } from "../../paths";
import { buildTree, compareGrouped, compareNames, isExpanded, sortTree, type TreeNode } from "../../ui/tree";

/** `explorer.sortOrder`: `default` (and `foldersNestsFiles`) folders first, then name; `mixed` name
 *  alone; `filesFirst` files first; `type` by extension, then name; `modified` newest first. */
function comparatorFor(order: ExplorerSortOrder, mtimes: Record<string, number>): (a: TreeNode, b: TreeNode) => number {
  switch (order) {
    case "mixed":
      return compareNames;
    case "filesFirst":
      return (a, b) => compareGrouped(a, b, false);
    case "type":
      return (a, b) => {
        if (a.children || b.children) {
          return compareGrouped(a, b, true);
        }
        const type = (node: TreeNode): string => extensionOf(node.name).slice(1).toLowerCase();
        return type(a).localeCompare(type(b)) || compareNames(a, b);
      };
    case "modified":
      return (a, b) => (mtimes[b.path] ?? 0) - (mtimes[a.path] ?? 0) || compareNames(a, b);
    case "default":
    case "foldersNestsFiles":
      return (a, b) => compareGrouped(a, b, true);
  }
}

/** One tree without `folders`, else a subtree per root — overlapping roots each list the file. */
export function buildForest(files: ExplorerListing): TreeNode[] {
  const compare = comparatorFor(files.sortOrder, files.mtimes ?? {});
  if (!files.roots) {
    const tree = buildTree(files.files, files.emptyDirs);
    sortTree(tree, compare);
    return tree;
  }
  return files.roots.map((root, index) => {
    const children = buildTree(files.files, files.emptyDirs, root.path, (path) => `${index}:${path}`);
    sortTree(children, compare);
    return { id: `${index}:`, name: root.name, path: root.path, children, root: true };
  });
}

/** A root with an open child folder? */
export function hasExpandedRootChild(roots: TreeNode[], expanded: Record<string, boolean>): boolean {
  return roots.some(
    (root) => isExpanded(root, expanded) && root.children!.some((child) => child.children && (expanded[child.id] ?? false)),
  );
}

/** The innermost root containing the path. */
export function rootIndexFor(roots: ExplorerRoot[], filePath: string): number | undefined {
  let best: number | undefined;
  roots.forEach((root, index) => {
    const inside = root.path === "" || filePath.startsWith(`${root.path}/`);
    if (inside && (best === undefined || root.path.length > roots[best].path.length)) {
      best = index;
    }
  });
  return best;
}

/** Outermost first. */
export function ancestorsOf(filePath: string): string[] {
  const parts = filePath.split("/");
  const ancestors: string[] = [];
  let prefix = "";
  for (let depth = 0; depth < parts.length - 1; depth++) {
    prefix = prefix ? `${prefix}/${parts[depth]}` : parts[depth];
    ancestors.push(prefix);
  }
  return ancestors;
}
