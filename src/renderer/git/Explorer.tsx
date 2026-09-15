import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ExplorerListing, ExplorerRoot, ExplorerSortOrder, FileChange, Project } from "../../shared/types";
import { absolutePath, revealLabel } from "../platform";
import { type FileAct } from "./ChangesList";
import { FILE_EXTENSIONS, FILE_NAMES, type FileMark } from "./file-icons";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt } from "../ui/Dialog";
import { ChevronIcon, SearchIcon, TREE_CHEVRON } from "../ui/icons";

/** As VS Code resolves an icon theme: the name, then each extension from the longest (`a.spec.ts`
 *  is `spec.ts`, then `ts`). Tables from scripts/file-icons.js. */
function fileMark(name: string): FileMark | null {
  const lower = name.toLowerCase();
  if (Object.hasOwn(FILE_NAMES, lower)) {
    return FILE_NAMES[lower];
  }
  for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
    const extension = lower.slice(dot + 1);
    if (Object.hasOwn(FILE_EXTENSIONS, extension)) {
      return FILE_EXTENSIONS[extension];
    }
  }
  return null;
}

/** A Seti font glyph, sized by `.file-mark` in styles.css (`Svg`'s extent-cropping reaches only a
 *  path); its color class maps to the theme's terminal colors. */
function FileMarkIcon({ mark: [glyph, color] }: { mark: FileMark }) {
  return (
    <span className={`tree-icon file-mark${color ? ` ${color}` : ""}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

interface TreeNode {
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

/* VS Code's explorer geometry: TreeRenderer's DefaultIndent and `workbench.tree.indent` (both 8),
 * `.monaco-tl-twistie` in tree.css (16px wide, 6px right padding, nudged 3px right). A file has no
 * twistie — views.css zeroes it under `align-icons-and-twisties`, which Seti (file icons, no folder
 * icons) turns on — so its mark sits where a sibling folder's chevron does (.file-mark in styles.css). */
const INDENT_STEP = 8;
const INDENT_BASE = 8;
/** Holds a folder's chevron; empty on a file. */
const TWISTIE_WIDTH = 16;
const TWISTIE_GAP = 6;
const TWISTIE_NUDGE = 3;

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
function compactTree(nodes: TreeNode[]): TreeNode[] {
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
function buildForest(files: ExplorerListing): TreeNode[] {
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
function hasExpandedRootChild(roots: TreeNode[], expanded: Record<string, boolean>): boolean {
  return roots.some(
    (root) =>
      (expanded[root.id] ?? root.root === true) &&
      root.children!.some((child) => child.children && (expanded[child.id] ?? false))
  );
}

/** The innermost root containing the path. */
function rootIndexFor(roots: ExplorerRoot[], filePath: string): number | undefined {
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
function parentOf(entryPath: string): string {
  const index = entryPath.lastIndexOf("/");
  return index === -1 ? "" : entryPath.slice(0, index);
}

/** A matching folder keeps its whole subtree; otherwise only matches survive, with their ancestors. */
function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
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
function ancestorsOf(filePath: string): string[] {
  const parts = filePath.split("/");
  const ancestors: string[] = [];
  let prefix = "";
  for (let depth = 0; depth < parts.length - 1; depth++) {
    prefix = prefix ? `${prefix}/${parts[depth]}` : parts[depth];
    ancestors.push(prefix);
  }
  return ancestors;
}

interface RowsProps {
  nodes: TreeNode[];
  depth: number;
  expanded: Record<string, boolean>;
  toggle: (node: TreeNode) => void;
  forceExpanded: boolean;
  selected: string | null;
  onOpen: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  rows: Map<string, HTMLButtonElement>;
}

function Rows({ nodes, depth, expanded, toggle, forceExpanded, selected, onOpen, onContextMenu, rows }: RowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.children !== undefined;
        // A root starts open, everything else closed.
        const open = forceExpanded || (expanded[node.id] ?? node.root === true);
        const mark = isFolder ? null : fileMark(node.name);
        return (
          <div key={node.id}>
            <button
              ref={(element) => {
                if (element) {
                  rows.set(node.id, element);
                } else {
                  rows.delete(node.id);
                }
              }}
              className={`tree-item${!isFolder && selected === node.path ? " selected" : ""}`}
              style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
              title={node.path || "."}
              onClick={() => (isFolder ? toggle(node) : onOpen(node.path))}
              onContextMenu={(event) => onContextMenu(event, node)}
            >
              {isFolder ? (
                <span
                  style={{
                    display: "flex",
                    flex: "none",
                    width: TWISTIE_WIDTH,
                    alignSelf: "stretch",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: TWISTIE_GAP,
                    transform: `translateX(${TWISTIE_NUDGE}px)`,
                  }}
                >
                  <ChevronIcon expanded={open} className="tree-icon" scale={TREE_CHEVRON} />
                </span>
              ) : mark ? (
                <FileMarkIcon mark={mark} />
              ) : (
                // Seti gives every file an icon, so the slot is kept even where tet draws no mark.
                <span className="tree-icon file-mark" aria-hidden="true" />
              )}
              <span className="tree-label">{node.name}</span>
            </button>
            {isFolder && open && (
              <Rows
                nodes={node.children!}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                forceExpanded={forceExpanded}
                selected={selected}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                rows={rows}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

interface ExplorerProps {
  project: Project;
  /** Undefined while the listing is read. */
  files: ExplorerListing | undefined;
  /** False while hidden behind the git view, where a row can't be scrolled to. */
  shown: boolean;
  /** The open file — revealed and highlighted. */
  selected: string | null;
  onOpen: (path: string) => void;
  /** The owner shows it running on its own bar. */
  act: FileAct;
  /** A create, rename or delete settled: an empty new folder never touches git status, so nothing
   *  else triggers a re-read. */
  onExplorerChanged: () => void;
  ref?: React.Ref<ExplorerHandle>;
}

/** For the EXPLORER header's title-bar buttons. */
export interface ExplorerHandle {
  newFile(): void;
  newFolder(): void;
  collapseAll(): void;
}

/**
 * The files pane's tree of every repository file. No ↑/↓ of its own. Shaped by tet.json via the
 * listing: `folders` make it multi-root (overlap allowed); `exclude`/`excludeGitIgnore` are already
 * applied; `sortOrder`/`compactFolders` are applied here.
 */
export function Explorer({ project, files, shown: visible, selected, onOpen, act, onExplorerChanged, ref }: ExplorerProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const tree = useMemo(() => (files ? buildForest(files) : []), [files]);
  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;
  // Compacted after filtering: a folder pruned to one subfolder folds with it.
  const shown = useMemo(() => {
    const filtered = filtering ? filterTree(tree, query) : tree;
    return files?.compactFolders ? compactTree(filtered) : filtered;
  }, [tree, query, filtering, files?.compactFolders]);

  // Reveals the editor tab's file in the innermost root containing it.
  const roots = files?.roots;
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) {
      return;
    }
    let idOf = (path: string): string => path;
    const ids: string[] = [];
    if (roots) {
      const index = rootIndexFor(roots, selected);
      if (index === undefined) {
        return;
      }
      idOf = (path) => `${index}:${path}`;
      ids.push(idOf(""));
    }
    pendingReveal.current = idOf(selected);
    // Compacted-away ancestors too: an id no row carries is simply never read.
    ids.push(...ancestorsOf(selected).map(idOf));
    setExpanded((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of ids) {
        if (!next[id]) {
          next[id] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [selected, roots]);
  // The scroll, once the row exists: re-run on `expanded` (a collapsed folder's rows aren't in the
  // DOM yet) and `shown` (the listing arrives after the view opens). The pending ref keeps a fold
  // toggle from yanking back to an old selection; it stays pending while hidden behind git.
  useEffect(() => {
    if (visible && pendingReveal.current) {
      const row = rows.current.get(pendingReveal.current);
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        pendingReveal.current = null;
      }
    }
  }, [selected, expanded, shown, visible]);

  const toggle = (node: TreeNode): void =>
    setExpanded((current) => ({ ...current, [node.id]: !(current[node.id] ?? node.root === true) }));

  /** "Collapse Folders in Explorer" in two stages: what is open below the roots, then everything
   *  (at once without roots). Walks the uncompacted `tree`, whose ids compacted rows keep. */
  const collapseAll = (): void => {
    const ids: string[] = [];
    const collect = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.children) {
          ids.push(node.id);
          collect(node.children);
        }
      }
    };
    if (roots && hasExpandedRootChild(tree, expanded)) {
      tree.forEach((root) => collect(root.children!));
    } else {
      collect(tree);
    }
    setExpanded((current) => {
      const next = { ...current };
      for (const id of ids) {
        next[id] = false;
      }
      return next;
    });
  };

  /** `act`, then a listing re-read on success. */
  const run: FileAct = (action) =>
    act(() =>
      action().then((result) => {
        if (result.ok) {
          onExplorerChanged();
        }
        return result;
      })
    );

  const askNewFile = async (dir: string): Promise<void> => {
    const answer = await prompt({
      title: "New File",
      label: "Name",
      detail: dir ? `Created inside ${dir}.` : "Created at the repository root.",
      value: "",
      confirmLabel: "Create"
    });
    if (answer) {
      run(() => window.tet.repository.createFile(project.id, dir ? `${dir}/${answer.value}` : answer.value));
    }
  };

  const askNewFolder = async (dir: string): Promise<void> => {
    const answer = await prompt({
      title: "New Folder",
      label: "Name",
      detail: dir ? `Created inside ${dir}.` : "Created at the repository root.",
      value: "",
      confirmLabel: "Create"
    });
    if (answer) {
      run(() => window.tet.repository.createDirectory(project.id, dir ? `${dir}/${answer.value}` : answer.value));
    }
  };

  const askRename = async (node: TreeNode): Promise<void> => {
    const answer = await prompt({ title: "Rename", label: "Name", value: node.name, confirmLabel: "Rename" });
    if (answer && answer.value !== node.name) {
      // A compacted row's answer replaces the whole chain, so it goes where the outermost folder is.
      const dir = node.path.split("/").slice(0, -node.name.split("/").length).join("/");
      run(() => window.tet.repository.renamePath(project.id, node.path, dir ? `${dir}/${answer.value}` : answer.value));
    }
  };

  const askDelete = async (node: TreeNode): Promise<void> => {
    const isFolder = node.children !== undefined;
    const answer = await confirm({
      title: isFolder ? "Delete folder" : "Delete file",
      message: `Are you sure you want to delete ${node.path}?`,
      detail: "Goes to the trash and can be restored from there.",
      confirmLabel: "Delete"
    });
    if (answer.confirmed) {
      run(() => window.tet.repository.deletePath(project.id, node.path));
    }
  };

  // The header's buttons act on the repository root.
  useImperativeHandle(ref, () => ({
    newFile: () => void askNewFile(""),
    newFolder: () => void askNewFolder(""),
    collapseAll
  }));

  /** `ChangesList`'s menu minus the change-only entries, plus new/rename/delete and the workspace
   *  entries writing tet.json. A root is a view onto a folder, so it is never renamed or deleted. */
  const menuEntries = (node: TreeNode | null): ContextMenuEntry[] => {
    const dir = node ? (node.children !== undefined ? node.path : parentOf(node.path)) : "";
    const isFile = node !== null && node.children === undefined;
    const isRoot = node?.root === true;

    const openEntries: ContextMenuEntry[] = isFile
      ? [
          { label: "Open", run: () => onOpen(node.path) },
          { label: "Open in external editor", run: () => void window.tet.shell.openFileExternally(project.id, node.path) },
          SEPARATOR
        ]
      : [];
    const editEntries: ContextMenuEntry[] =
      node && !isRoot
        ? [
            SEPARATOR,
            { label: "Rename...", run: () => void askRename(node) },
            { label: "Delete...", run: () => void askDelete(node) }
          ]
        : [];
    const viewEntries: ContextMenuEntry[] = [];
    if (node) {
      viewEntries.push(SEPARATOR);
      if (isRoot) {
        viewEntries.push({
          label: "Remove Folder from Workspace",
          run: () => run(() => window.tet.repository.removeFolder(project.id, node.path))
        });
      } else {
        if (!isFile) {
          viewEntries.push({
            label: "Add Folder to Workspace",
            run: () => run(() => window.tet.repository.addFolder(project.id, node.path))
          });
        }
        viewEntries.push({
          label: "Exclude from Files",
          run: () => run(() => window.tet.repository.excludePath(project.id, node.path))
        });
      }
    }
    const pathEntries: ContextMenuEntry[] = node
      ? [
          SEPARATOR,
          { label: revealLabel(), run: () => void window.tet.shell.revealFile(project.id, node.path) },
          {
            label: isFile ? "Copy file path" : "Copy path",
            run: () => void navigator.clipboard.writeText(absolutePath(project.path, node.path))
          },
          ...(node.path
            ? [
                {
                  label: isFile ? "Copy relative file path" : "Copy relative path",
                  run: () => void navigator.clipboard.writeText(node.path)
                }
              ]
            : [])
        ]
      : [];

    return [
      ...openEntries,
      { label: "New File...", run: () => void askNewFile(dir) },
      { label: "New Folder...", run: () => void askNewFolder(dir) },
      ...editEntries,
      ...viewEntries,
      ...pathEntries
    ];
  };

  return (
    <div className="explorer-tree">
      <div className="filter-field">
        <SearchIcon className="filter-icon" />
        <input type="text" placeholder="Filter files..." value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div
        className="tree"
        onContextMenu={(event) => {
          // Only the empty space below the rows.
          if (event.target === event.currentTarget) {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, node: null });
          }
        }}
      >
        {files !== undefined && !files.roots && files.files.length === 0 && files.emptyDirs.length === 0 && (
          <div className="placeholder">No files.</div>
        )}
        <Rows
          nodes={shown}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          forceExpanded={filtering}
          selected={selected}
          onOpen={onOpen}
          onContextMenu={(event, node) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, node });
          }}
          rows={rows.current}
        />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.node)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * The Explorer's listing, carrying the tet.json view settings. Re-read when a non-"modified" entry
 * in `changes` comes or goes, on tet.json writes, on `onFilesChanged` (a checkout, pull or reset
 * adds and removes files never in `changes`, and ignored files never are), and via
 * `refreshExplorer` after the tree's own edits (an empty new folder never touches git status).
 *
 * Held with its project: one files pane serves all, and a switch must not show the previous tree.
 */
export function useExplorerListing(
  projectId: string,
  changes: FileChange[],
  shown: boolean
): { explorerListing: ExplorerListing | undefined; listing: boolean; refreshExplorer: () => void } {
  const [held, setHeld] = useState<{ projectId: string; listing: ExplorerListing } | undefined>(undefined);
  const [listing, setListing] = useState(false);
  const [explorerVersion, setExplorerVersion] = useState(0);
  const refreshExplorer = useCallback(() => setExplorerVersion((count) => count + 1), []);
  useEffect(() => {
    const bump = (payload: { projectId: string }): void => {
      if (payload.projectId === projectId) {
        setExplorerVersion((count) => count + 1);
      }
    };
    const unsubscribeCommands = window.tet.commands.onChanged(bump);
    const unsubscribeFiles = window.tet.repository.onFilesChanged(bump);
    return () => {
      unsubscribeCommands();
      unsubscribeFiles();
    };
  }, [projectId]);
  const changesKey = useMemo(
    () =>
      changes
        .filter((entry) => entry.status !== "modified")
        .map((entry) => entry.path)
        .join("\n"),
    [changes]
  );
  // Read only while shown, and again on return: changes meanwhile went unread.
  useEffect(() => {
    if (!shown) {
      return;
    }
    let cancelled = false;
    setListing(true);
    void window.tet.repository.listExplorer(projectId).then((result) => {
      if (!cancelled) {
        setHeld({ projectId, listing: result });
        setListing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, changesKey, explorerVersion, shown]);
  return { explorerListing: held?.projectId === projectId ? held.listing : undefined, listing, refreshExplorer };
}
