import type { ExplorerListing, ExplorerRoot, ExplorerSortOrder } from "../../shared/types";

export interface TreeNode {
  /** Key for `expanded`, the row map and React. The path; with `folders`, prefixed by the root's
   *  index ("1:src/a.ts"), so a file under two roots folds and scrolls independently. */
  id: string;
  /** A compacted chain's is `a/b/c`. */
  name: string;
  /** Repository-relative, forward-slashed; for a compacted chain, the innermost folder's. */
  path: string;
  /** Present exactly for a folder. */
  children?: TreeNode[];
  /** A `folders` entry's top-level node: open by default, removable, never compacted. */
  root?: true;
}

/** Case-insensitive, locale-aware. */
function compareNames(a: TreeNode, b: TreeNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function compareGrouped(a: TreeNode, b: TreeNode, foldersFirst: boolean): number {
  if (!!a.children !== !!b.children) {
    return (a.children ? -1 : 1) * (foldersFirst ? 1 : -1);
  }
  return compareNames(a, b);
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

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
        return extensionOf(a.name).localeCompare(extensionOf(b.name)) || compareNames(a, b);
      };
    case "modified":
      return (a, b) => (mtimes[b.path] ?? 0) - (mtimes[a.path] ?? 0) || compareNames(a, b);
    default:
      return (a, b) => compareGrouped(a, b, true);
  }
}

function sortTree(nodes: TreeNode[], compare: (a: TreeNode, b: TreeNode) => number): void {
  nodes.sort(compare);
  for (const node of nodes) {
    if (node.children) {
      sortTree(node.children, compare);
    }
  }
}

/** Files under `under` ("" for all) nested into folders, plus `emptyDirs`. Paths stay
 *  repository-relative; `idOf` adds the root prefix (`TreeNode.id`). */
function buildTree(files: string[], emptyDirs: string[], under: string, idOf: (path: string) => string): TreeNode[] {
  const top: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();
  const ensureFolder = (folderPath: string, name: string, siblings: TreeNode[]): TreeNode => {
    let folder = folders.get(folderPath);
    if (!folder) {
      folder = { id: idOf(folderPath), name, path: folderPath, children: [] };
      folders.set(folderPath, folder);
      siblings.push(folder);
    }
    return folder;
  };
  const insert = (entryPath: string, isDirectory: boolean): void => {
    if (under && !entryPath.startsWith(`${under}/`)) {
      return;
    }
    const parts = (under ? entryPath.slice(under.length + 1) : entryPath).split("/");
    let siblings = top;
    let prefix = under;
    for (let depth = 0; depth < parts.length - 1; depth++) {
      prefix = prefix ? `${prefix}/${parts[depth]}` : parts[depth];
      siblings = ensureFolder(prefix, parts[depth], siblings).children!;
    }
    const name = parts[parts.length - 1];
    if (isDirectory) {
      ensureFolder(entryPath, name, siblings);
    } else {
      siblings.push({ id: idOf(entryPath), name, path: entryPath });
    }
  };
  for (const file of files) {
    insert(file, false);
  }
  for (const dir of emptyDirs) {
    insert(dir, true);
  }
  return top;
}

/** `explorer.compactFolders`: a chain of only-child folders becomes one row, acting as the innermost
 *  folder for folding, reveal and the menu. Roots are never compacted. */
export function compactTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (!node.children) {
      return node;
    }
    let folded = node;
    while (!folded.root && folded.children!.length === 1 && folded.children![0].children) {
      const inner = folded.children![0];
      folded = { id: inner.id, name: `${folded.name}/${inner.name}`, path: inner.path, children: inner.children };
    }
    return { ...folded, children: compactTree(folded.children!) };
  });
}

/** One tree without `folders`, else a subtree per root — overlapping roots each list the file. */
export function buildForest(files: ExplorerListing): TreeNode[] {
  const compare = comparatorFor(files.sortOrder, files.mtimes ?? {});
  if (!files.roots) {
    const tree = buildTree(files.files, files.emptyDirs, "", (path) => path);
    sortTree(tree, compare);
    return tree;
  }
  return files.roots.map((root, index) => {
    const children = buildTree(files.files, files.emptyDirs, root.path, (path) => `${index}:${path}`);
    sortTree(children, compare);
    return { id: `${index}:`, name: root.name, path: root.path, children, root: true };
  });
}

/** A root with an open child folder? Defaults match `toggle`'s. */
export function hasExpandedRootChild(roots: TreeNode[], expanded: Record<string, boolean>): boolean {
  return roots.some(
    (root) =>
      (expanded[root.id] ?? root.root === true) &&
      root.children!.some((child) => child.children && (expanded[child.id] ?? false))
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

/** "" at the root. */
export function parentOf(entryPath: string): string {
  const index = entryPath.lastIndexOf("/");
  return index === -1 ? "" : entryPath.slice(0, index);
}

/** A matching folder keeps its whole subtree; otherwise only matches survive, with their ancestors. */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const matches = node.path.toLowerCase().includes(query);
    if (node.children) {
      if (matches) {
        result.push(node);
        continue;
      }
      const children = filterTree(node.children, query);
      if (children.length > 0) {
        result.push({ ...node, children });
      }
    } else if (matches) {
      result.push(node);
    }
  }
  return result;
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
