/** A tree of repository paths, for the Explorer and LOCAL CHANGES alike. */
export interface TreeNode {
  /** Key for `expanded`, the row map and React. The path; in the Explorer with `folders`, prefixed
   *  by the root's index ("1:src/a.ts"), so a file under two roots folds and scrolls independently. */
  id: string;
  /** A compacted chain's is `a/b/c`. */
  name: string;
  /** Repository-relative, forward-slashed; for a compacted chain, the innermost folder's. */
  path: string;
  /** Present exactly for a folder. */
  children?: TreeNode[];
  /** A top-level node standing for more than a folder (an Explorer `folders` entry, the changes'
   *  "Changes"): open by default, never compacted. */
  root?: true;
}

/** Case-insensitive, locale-aware. */
export function compareNames(a: TreeNode, b: TreeNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function compareGrouped(a: TreeNode, b: TreeNode, foldersFirst: boolean): number {
  if (!!a.children !== !!b.children) {
    return (a.children ? -1 : 1) * (foldersFirst ? 1 : -1);
  }
  return compareNames(a, b);
}

export function sortTree(nodes: TreeNode[], compare: (a: TreeNode, b: TreeNode) => number): void {
  nodes.sort(compare);
  for (const node of nodes) {
    if (node.children) {
      sortTree(node.children, compare);
    }
  }
}

/** Files under `under` ("" for all) nested into folders, plus `emptyDirs`. Paths stay
 *  repository-relative; `idOf` adds a root's prefix (`TreeNode.id`). */
export function buildTree(
  files: string[],
  emptyDirs: string[] = [],
  under = "",
  idOf: (path: string) => string = (path) => path
): TreeNode[] {
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

/** VS Code's `explorer.compactFolders`: a chain of only-child folders becomes one row, acting as the
 *  innermost folder for folding, reveal and the menu. Roots are never compacted. */
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

/** A folder's fold state: a root starts open, everything else closed. */
export function isOpen(node: TreeNode, expanded: Record<string, boolean>): boolean {
  return expanded[node.id] ?? node.root === true;
}

/** The paths of the files at and below `node`. */
export function filesUnder(node: TreeNode, out: string[] = []): string[] {
  if (node.children) {
    for (const child of node.children) {
      filesUnder(child, out);
    }
  } else {
    out.push(node.path);
  }
  return out;
}

/** A row on screen: the tree flattened to what open folders show, as VS Code's list renders it. */
export interface VisibleRow {
  node: TreeNode;
  depth: number;
  open: boolean;
}

export function visibleRows(
  nodes: TreeNode[],
  open: (node: TreeNode) => boolean,
  depth = 0,
  out: VisibleRow[] = []
): VisibleRow[] {
  for (const node of nodes) {
    const shown = open(node);
    out.push({ node, depth, open: shown });
    if (node.children && shown) {
      visibleRows(node.children, open, depth + 1, out);
    }
  }
  return out;
}
