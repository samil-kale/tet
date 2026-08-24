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

/**
 * A file's language, marked in its twistie slot — one entry per grammar `diff-highlight.ts`
 * bundles, so a mark only ever names a language the diff view itself can colour. Anything else
 * (an unlisted extension, no extension at all) shows no mark, same as a file always has until now.
 */
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
  /**
   * What `expanded`, the row map and React keys go by. The path alone, until the project lists
   * `folders`: then the same file can sit under two roots, so each root prefixes its own
   * index — "1:src/a.ts" — and the two rows fold and scroll independently.
   */
  id: string;
  /** The label; a compacted chain's is `a/b/c`. */
  name: string;
  /** Repository-relative, forward-slashed — the same shape `changes` paths already have. For a
   *  compacted chain, the innermost folder's, which is the one every action acts on. */
  path: string;
  /** Present for a folder, absent for a file — what tells the two apart while rendering. */
  children?: TreeNode[];
  /** A `folders` entry's top-level node: open by default, removable, never compacted. */
  root?: true;
}

/* VS Code's explorer geometry (abstractTree.ts / explorerViewer.ts), shrunk 2px across the board
 * — indent, twistie slot, its gap to the label, and the chevron glyph itself (see .explorer-tree
 * .tree-icon in styles.css) — so the whole tree reads smaller as one piece, not just some of it. */
const INDENT_STEP = 6;
const INDENT_BASE = 6;
/** Wide enough for a folder's chevron or a file's two-letter language badge, whichever a row
 *  has — both centred in the same box, so either way the label after it starts at the same x. */
const TWISTIE_WIDTH = 16;
const TWISTIE_GAP = 4;

/** Name order as VS Code's explorer compares: case-insensitive, locale-aware. */
function compareNames(a: TreeNode, b: TreeNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Folders before files (or the other way round), then by name. */
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

/**
 * VS Code's `explorer.sortOrder` values, one comparator each: `default` (and
 * `foldersNestsFiles`, the same without file nesting) is folders before files then name;
 * `mixed` name alone; `filesFirst` the reverse grouping; `type` folders first, files by
 * extension then name; `modified` newest first, folders and files alike, name on a tie.
 */
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

/**
 * Every file under `under` ("" for all of them), split on `/` into nested folders, plus any
 * directory `files` alone wouldn't imply (see `ExplorerListing`) — inserted the same way, except
 * its own leaf is a folder node too. Paths stay repository-relative whatever `under` is; `idOf`
 * is what a root prefixes them with (see `TreeNode.id`).
 */
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

/**
 * VS Code's `explorer.compactFolders`: a folder whose only child is another folder becomes one
 * row with that child — `src/main/java` — down the whole chain. The row *is* the innermost
 * folder (its id, its path, its children), so folding, reveal and the context menu all act on
 * that one; VS Code's per-segment click is not reproduced. Roots are left as they are, as there.
 */
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

/**
 * The whole tree: one of every file where the project names no `folders`, otherwise one subtree
 * per root under a top-level node carrying its name — the same file under two overlapping roots
 * twice, each row its own. Sorted by the project's `sortOrder` either way.
 */
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

/** VS Code's `hasExpandedRootChild`: is there a root with an open, collapsible child — a
 *  subfolder open one level under a workspace folder? Defaults match `toggle`'s (a root open, a
 *  plain folder shut) since a node left out of `expanded` is exactly that default. */
function hasExpandedRootChild(roots: TreeNode[], expanded: Record<string, boolean>): boolean {
  return roots.some(
    (root) =>
      (expanded[root.id] ?? root.root === true) &&
      root.children!.some((child) => child.children && (expanded[child.id] ?? false))
  );
}

/** The root whose subtree a path is revealed in: the innermost one containing it — VS Code's
 *  `getWorkspaceFolder` — or undefined when it lies under none. */
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

/** Everything up to but not including a path's own last segment — its parent folder, "" at the
 *  root. */
function parentOf(entryPath: string): string {
  const index = entryPath.lastIndexOf("/");
  return index === -1 ? "" : entryPath.slice(0, index);
}

/**
 * The filtered tree, VS Code's own quick-filter rule: a folder whose own path matches keeps its
 * whole subtree as it was; otherwise only descendants that themselves match survive, and their
 * ancestors are kept just to carry them.
 */
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
        // A root starts open, the way VS Code's workspace folders do; everything else closed.
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
  /** The open file, if any — reveals and highlights it; not itself an ↑/↓ target (see CLAUDE.md). */
  selected: string | null;
  onOpen: (path: string) => void;
  /** Runs a file-tree action, the way `ChangesList`'s own list runs a git one — the owner shows
   *  it running on its own bar. */
  act: FileAct;
  /** A create, rename or delete settled — nothing else would tell the tree to read the listing
   *  again: an empty new folder, unlike a new file, never touches git status. */
  onExplorerChanged: () => void;
  ref?: React.Ref<ExplorerHandle>;
}

/** What the EXPLORER header's own title-bar buttons reach in — VS Code's "New File...", "New
 *  Folder..." and "Collapse Folders in Explorer", the same trio its explorer carries. */
export interface ExplorerHandle {
  newFile(): void;
  newFolder(): void;
  collapseAll(): void;
}

/**
 * The diff dialog's file browser: every file in the repository, not just the changed ones under
 * LOCAL CHANGES beside it — a way in for the occasional file that has no diff. No ↑/↓ (stays with
 * `ChangesList`), but otherwise GitHub Desktop's own file actions plus the handful VS Code's
 * explorer adds for a tree rather than a flat list: new file, new folder, rename, delete.
 *
 * How it is shown is the project's own say, from its tet.json and carried in by the listing
 * (see `ExplorerListing`): `folders` make it VS Code's multi-root explorer — one top-level node
 * per entry, overlapping allowed, the file revealed in the innermost root containing it — while
 * `exclude`/`excludeGitIgnore` have already thinned the listing before it gets here, and
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
  // Compacted last, on what is actually shown: a filter that prunes a folder down to one
  // subfolder folds the two together, as VS Code's does.
  const shown = useMemo(() => {
    const filtered = filtering ? filterTree(tree, query) : tree;
    return files?.compactFolders ? compactTree(filtered) : filtered;
  }, [tree, query, filtering, files?.compactFolders]);

  // Reveals the file the rest of the dialog opened (a ChangesList click, a ctrl-clicked path):
  // its folders expand and it scrolls into view, the same way VS Code's explorer follows the
  // active editor. Under `folders`, in the innermost root containing it — or nowhere, when no
  // root does.
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
    // Every ancestor, the ones a compacted chain folded away included — an id no row carries
    // is simply never read.
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
  // The scroll itself, one effect later: a row inside a still-collapsed folder is not in the
  // DOM on the pass that expands it, so scrolling right after `setExpanded` above found nothing
  // to scroll to — exactly the case a reveal exists for. Watching `expanded` too runs this
  // again on the render where the row finally exists; the pending ref keeps an ordinary fold
  // toggle from yanking the view back to a long-since-revealed selection.
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

  /** VS Code's "Collapse Folders in Explorer": with `folders` open (a multi-root workspace) and
   *  something expanded below one of them, a press only shuts what's open under each root,
   *  leaving the roots themselves in place — a plain `collapseAll()` would close the very
   *  folders the button is meant to declutter, not empty them out. Only once nothing is left
   *  open below the roots (or there are none — a single tree, same as VS Code's single-folder
   *  window) does a press fold everything, roots included. Walks the unfiltered, uncompacted
   *  `tree`: a compacted chain's row keeps its innermost folder's id (see `compactTree`), which
   *  this still collects either way. */
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

  // The EXPLORER header's own title-bar buttons — same target as right-clicking the empty space
  // below the tree (`menuEntries` with `node: null`): the repository root.
  useImperativeHandle(ref, () => ({
    newFile: () => void askNewFile(""),
    newFolder: () => void askNewFolder(""),
    collapseAll
  }));

  /**
   * GitHub Desktop's changed-file menu (`ChangesList`'s own), minus what only makes sense for a
   * change, plus VS Code's new/rename/delete for a tree of every file, and its explorer's
   * workspace entries — "Add Folder to Workspace" on a folder, "Remove Folder from Workspace" on
   * a root — with one VS Code keeps in its settings editor, "Exclude from Files". All three edit
   * the project's tet.json (see CLAUDE.md, "Explorer"). A root is neither renamed nor deleted
   * from here: it is a view onto a folder, not the folder.
   */
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
          // A row's own handler already fired and set `event.target` to itself; reaching here
          // means the empty space below the last one was clicked instead.
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
