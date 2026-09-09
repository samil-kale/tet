import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ExplorerListing, ExplorerRoot, ExplorerSortOrder, Project } from "../../shared/types";
import { languageForPath } from "./diff-highlight";
import { absolutePath, revealLabel } from "../platform";
import { type FileAct } from "../git/ChangesList";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt } from "../ui/Dialog";
import {
  ChevronIcon,
  CIcon,
  CppIcon,
  CSharpIcon,
  CssIcon,
  GoIcon,
  HtmlIcon,
  IniIcon,
  JavaIcon,
  JavaScriptIcon,
  JsonIcon,
  JsxIcon,
  MarkdownIcon,
  PowerShellIcon,
  PythonIcon,
  RustIcon,
  SearchIcon,
  ShellScriptIcon,
  SMALLER,
  SqlIcon,
  TomlIcon,
  TsxIcon,
  TypeScriptIcon,
  XmlIcon,
  YamlIcon,
  type IconProps
} from "../ui/icons";

/** A file's language, marked in its twistie slot — one entry per grammar `diff-highlight.ts`
 *  bundles, so a mark only names a language the diff view can colour. */
const LANGUAGE_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  c: CIcon,
  cpp: CppIcon,
  csharp: CSharpIcon,
  css: CssIcon,
  go: GoIcon,
  html: HtmlIcon,
  ini: IniIcon,
  java: JavaIcon,
  javascript: JavaScriptIcon,
  json: JsonIcon,
  jsx: JsxIcon,
  markdown: MarkdownIcon,
  powershell: PowerShellIcon,
  python: PythonIcon,
  rust: RustIcon,
  shellscript: ShellScriptIcon,
  sql: SqlIcon,
  toml: TomlIcon,
  tsx: TsxIcon,
  typescript: TypeScriptIcon,
  xml: XmlIcon,
  yaml: YamlIcon
};

interface TreeNode {
  /** What `expanded`, the row map and React keys go by. The path alone, until the project lists
   *  `folders`: the same file can then sit under two roots, so each root prefixes its own index
   *  ("1:src/a.ts") and the two rows fold and scroll independently. */
  id: string;
  /** The label; a compacted chain's is `a/b/c`. */
  name: string;
  /** Repository-relative, forward-slashed; for a compacted chain, the innermost folder's. */
  path: string;
  /** Present for a folder, absent for a file — what tells the two apart while rendering. */
  children?: TreeNode[];
  /** A `folders` entry's top-level node: open by default, removable, never compacted. */
  root?: true;
}

/* VS Code's explorer geometry (abstractTree.ts / explorerViewer.ts), shrunk 2px across the
 * board, the chevron glyph included (see .explorer-tree .tree-icon in styles.css). */
const INDENT_STEP = 6;
const INDENT_BASE = 6;
/** Wide enough for a folder's chevron or a file's language badge, both centred in the same box. */
const TWISTIE_WIDTH = 16;
const TWISTIE_GAP = 4;

/** Name order: case-insensitive, locale-aware. */
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

/** `explorer.sortOrder`: `default` (and `foldersNestsFiles`) is folders before files then name;
 *  `mixed` name alone; `filesFirst` the reverse grouping; `type` files by extension then name;
 *  `modified` newest first, name on a tie. */
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

/** Every file under `under` ("" for all of them), split on `/` into nested folders, plus any
 *  directory `files` alone wouldn't imply (see `ExplorerListing`). Paths stay
 *  repository-relative; `idOf` is the root prefix (see `TreeNode.id`). */
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

/** `explorer.compactFolders`: a folder whose only child is another folder becomes one row down
 *  the whole chain. The row is the innermost folder, so folding, reveal and the menu act on
 *  that one. Roots are left as they are. */
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

/** The whole tree: every file where the project names no `folders`, otherwise one subtree per
 *  root, a file under two overlapping roots getting a row in each. Sorted by `sortOrder`. */
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

/** Is there a root with an open, collapsible child? Defaults match `toggle`'s. */
function hasExpandedRootChild(roots: TreeNode[], expanded: Record<string, boolean>): boolean {
  return roots.some(
    (root) =>
      (expanded[root.id] ?? root.root === true) &&
      root.children!.some((child) => child.children && (expanded[child.id] ?? false))
  );
}

/** The innermost root containing the path, or undefined when it lies under none. */
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

/** A path's parent folder, "" at the root. */
function parentOf(entryPath: string): string {
  const index = entryPath.lastIndexOf("/");
  return index === -1 ? "" : entryPath.slice(0, index);
}

/** The filtered tree: a folder whose own path matches keeps its whole subtree; otherwise only
 *  descendants that match survive, their ancestors kept to carry them. */
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

/** Every folder on the way down to a path, root first. */
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
        const LangIcon = isFolder ? undefined : LANGUAGE_ICONS[languageForPath(node.path) ?? ""];
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
              <span
                style={{
                  display: "flex",
                  flex: "none",
                  width: TWISTIE_WIDTH,
                  alignSelf: "stretch",
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: TWISTIE_GAP,
                }}
              >
                {isFolder ? (
                  <ChevronIcon expanded={open} className="tree-icon" scale={SMALLER} />
                ) : (
                  LangIcon && <LangIcon className="tree-icon" />
                )}
              </span>
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
  /** Undefined while the listing is still being read — the EXPLORER header's own bar says so. */
  files: ExplorerListing | undefined;
  /** The open file, if any — reveals and highlights it. */
  selected: string | null;
  onOpen: (path: string) => void;
  /** Runs a file-tree action; the owner shows it running on its own bar. */
  act: FileAct;
  /** A create, rename or delete settled: an empty new folder never touches git status, so
   *  nothing else would tell the tree to read the listing again. */
  onExplorerChanged: () => void;
  ref?: React.Ref<ExplorerHandle>;
}

/** What the EXPLORER header's own title-bar buttons reach in. */
export interface ExplorerHandle {
  newFile(): void;
  newFolder(): void;
  collapseAll(): void;
}

/**
 * The diff dialog's file browser: every file in the repository, not just the changed ones under
 * LOCAL CHANGES beside it. No ↑/↓ of its own — that stays with `ChangesList`. How it is shown
 * comes from the project's tet.json, carried in by the listing: `folders` make it a multi-root
 * explorer, overlapping allowed; `exclude`/`excludeGitIgnore` have already thinned it, and
 * `sortOrder`/`compactFolders` are applied on the way to the screen.
 */
export function Explorer({ project, files, selected, onOpen, act, onExplorerChanged, ref }: ExplorerProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const tree = useMemo(() => (files ? buildForest(files) : []), [files]);
  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;
  // Compacted last, on what is shown: a filter pruning a folder to one subfolder folds them.
  const shown = useMemo(() => {
    const filtered = filtering ? filterTree(tree, query) : tree;
    return files?.compactFolders ? compactTree(filtered) : filtered;
  }, [tree, query, filtering, files?.compactFolders]);

  // Reveals the file the rest of the dialog opened, in the innermost root containing it.
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
    // Every ancestor, folded-away ones included: an id no row carries is never read.
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
  // The scroll itself, one effect later: a row inside a still-collapsed folder is not in the DOM
  // on the pass that expands it, so watching `expanded` runs this again once it exists. The
  // pending ref keeps an ordinary fold toggle from yanking the view back to an old selection.
  useEffect(() => {
    if (pendingReveal.current) {
      const row = rows.current.get(pendingReveal.current);
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        pendingReveal.current = null;
      }
    }
  }, [selected, expanded]);

  const toggle = (node: TreeNode): void =>
    setExpanded((current) => ({ ...current, [node.id]: !(current[node.id] ?? node.root === true) }));

  /** "Collapse Folders in Explorer", in two stages: with something expanded below a root, a
   *  press shuts only that; once nothing is (or there are no roots), it folds everything. Walks
   *  the unfiltered, uncompacted `tree`, whose ids a compacted row keeps (see `compactTree`). */
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

  /** `act`, plus telling the EXPLORER header to read the listing again once the action lands. */
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
      const dir = parentOf(node.path);
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

  // The EXPLORER header's buttons act on the repository root.
  useImperativeHandle(ref, () => ({
    newFile: () => void askNewFile(""),
    newFolder: () => void askNewFolder(""),
    collapseAll
  }));

  /** `ChangesList`'s menu minus what only suits a change, plus new/rename/delete and the workspace
   *  entries, which edit the project's tet.json (see CLAUDE.md, "Explorer"). A root is neither
   *  renamed nor deleted here: it is a view onto a folder, not the folder. */
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
          // A row's own handler sets `event.target` to itself, so this is the space below.
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
