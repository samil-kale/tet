import { memo, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ExplorerListing, FileChange, GitActionResult, Project } from "../../shared/types";
import type { OpenEditor } from "../terminal/editor-tab";
import type { FileAct, FileAsk } from "../git/run-action";
import { openEntries, pathEntries } from "./file-menu";
import {
  ancestorsOf,
  baseName,
  buildForest,
  compactTree,
  filterTree,
  hasExpandedRootChild,
  isOpen,
  parentOf,
  rootIndexFor,
  type TreeNode
} from "./explorer-tree";
import { FileMarkIcon, INDENT_BASE, INDENT_STEP, Twistie } from "./tree-rows";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { askName, confirm } from "../ui/Dialog";
import { FilterField } from "../ui/FilterField";

interface RowsProps {
  nodes: TreeNode[];
  depth: number;
  expanded: Record<string, boolean>;
  toggle: (node: TreeNode) => void;
  forceExpanded: boolean;
  selected: string | null;
  onOpen: (path: string, how?: OpenEditor) => void;
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  rows: Map<string, HTMLButtonElement>;
}

function Rows({ nodes, depth, expanded, toggle, forceExpanded, selected, onOpen, onContextMenu, rows }: RowsProps) {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.children !== undefined;
        const open = forceExpanded || isOpen(node, expanded);
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
              // VS Code: a single click previews, a double click keeps. The clicks before it
              // already opened the file, so this only keeps.
              onDoubleClick={() => !isFolder && onOpen(node.path, { keep: true })}
              onContextMenu={(event) => onContextMenu(event, node)}
            >
              {isFolder ? <Twistie open={open} /> : <FileMarkIcon name={node.name} />}
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
  /** The active editor tab's file — revealed and highlighted. */
  selected: string | null;
  /** In the preview tab, or kept (`editor-tab.ts`); a Markdown file with its preview if asked.
   *  The project is named: the same handler serves every view that opens a file. */
  onOpenFile: (projectId: string, path: string, how?: OpenEditor) => void;
  /** What a question runs, shown on the question's own bar and refused at its field. */
  ask: FileAsk;
  /** What a menu entry that asks nothing runs: the owner's bar shows it, a notice tells its
   *  failure. */
  act: FileAct;
  /** A create, rename or delete settled: an empty new folder never touches git status, so nothing
   *  else triggers a re-read. */
  onExplorerChanged: () => void;
  /** What the header's clear button stands for, reported as it changes: the tree holds the filter. */
  onFiltering: (filtering: boolean) => void;
  ref?: React.Ref<ExplorerHandle>;
}

/** For the EXPLORER header's title-bar buttons. */
export interface ExplorerHandle {
  newFile(): void;
  newFolder(): void;
  collapseAll(): void;
  clearFilter(): void;
}

/**
 * The files pane's tree of every repository file. No ↑/↓ of its own. Shaped by tet.json via the
 * listing: `folders` make it multi-root (overlap allowed); `exclude`/`excludeGitIgnore` are already
 * applied; `sortOrder`/`compactFolders` are applied here. Its field filters it by name; what a
 * search finds in the files' lines is the pane under it (`FileSearch`).
 */
export const Explorer = memo(function Explorer({
  project,
  files,
  shown: visible,
  selected,
  onOpenFile,
  ask,
  act,
  onExplorerChanged,
  onFiltering,
  ref
}: ExplorerProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menu = useContextMenu<TreeNode | null>();
  const rows = useRef(new Map<string, HTMLButtonElement>());
  /** The project is this view's; the rows say only which file and how. */
  const onOpen = useCallback(
    (path: string, how?: OpenEditor) => onOpenFile(project.id, path, how),
    [onOpenFile, project.id]
  );

  const tree = useMemo(() => (files ? buildForest(files) : []), [files]);
  // Deferred: a short query keeps most of the tree, all of it expanded, and rendering that on every
  // keystroke held up the field.
  const query = useDeferredValue(filter.trim().toLowerCase());
  const filtering = query.length > 0;
  // The clear button is the header's; only the tree knows whether there is a filter to clear.
  useEffect(() => onFiltering(filtering), [filtering, onFiltering]);
  // Compacted after filtering: a folder pruned to one subfolder folds with it.
  const shown = useMemo(() => {
    const filtered = query ? filterTree(tree, query) : tree;
    return files?.compactFolders ? compactTree(filtered) : filtered;
  }, [tree, query, files?.compactFolders]);

  // Reveals the active editor tab's file in the innermost root containing it.
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
    setExpanded((current) => ({ ...current, [node.id]: !isOpen(node, current) }));

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

  /** The action, then a listing re-read on success. */
  const reread = (action: () => Promise<GitActionResult>) => () =>
    action().then((result) => {
      if (result.ok) {
        onExplorerChanged();
      }
      return result;
    });
  /** The pane's `ask`, re-reading: for the questions that stay up to show what refused them. */
  const runAsked: FileAsk = (action) => ask(reread(action));
  /** The pane's `act`, likewise, for a menu entry that asks nothing. */
  const run: FileAct = (action) => act(reread(action));

  const under = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

  const askNew = async (kind: "file" | "folder", dir: string): Promise<void> => {
    const create = kind === "file" ? window.tet.repository.createFile : window.tet.repository.createDirectory;
    await askName({
      title: kind === "file" ? "New File" : "New Folder",
      detail: dir ? `Created inside ${dir}.` : "Created at the repository root.",
      confirmLabel: "Create",
      submit: (name) => runAsked(() => create(project.id, under(dir, name)))
    });
  };

  const askRename = async (node: TreeNode): Promise<void> => {
    // A compacted row (`a/b/c`) renames its innermost folder, as F2 does in VS Code: renaming the
    // chain would move only that folder and leave the outer ones behind, empty.
    await askName({
      title: "Rename",
      current: baseName(node.path),
      confirmLabel: "Rename",
      submit: (name) =>
        runAsked(() => window.tet.repository.renamePath(project.id, node.path, under(parentOf(node.path), name)))
    });
  };

  // Asked although the trash can give it back: VS Code's Explorer asks too, and a slip on the
  // menu would otherwise take a folder out from under a running agent.
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
    newFile: () => void askNew("file", ""),
    newFolder: () => void askNew("folder", ""),
    collapseAll,
    clearFilter: () => setFilter("")
  }));

  /** `ChangesList`'s menu minus the change-only entries, plus new/rename/delete and the workspace
   *  entries writing tet.json. A root is a view onto a folder, so it is never renamed or deleted. */
  const menuEntries = (node: TreeNode | null): ContextMenuEntry[] => {
    const dir = node ? (node.children !== undefined ? node.path : parentOf(node.path)) : "";
    const isFile = node !== null && node.children === undefined;
    const isRoot = node?.root === true;

    const fileEntries: ContextMenuEntry[] = isFile
      ? [
          { label: "Open", run: () => onOpen(node.path) },
          ...openEntries(project.id, node.path, true, (how) => onOpen(node.path, how)),
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
    // A worktree shows its main worktree's view and never changes it (tet-json.ts's configRoot).
    if (node && !project.mainPath) {
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

    return [
      ...fileEntries,
      { label: "New File...", run: () => void askNew("file", dir) },
      { label: "New Folder...", run: () => void askNew("folder", dir) },
      ...editEntries,
      ...viewEntries,
      ...(node ? pathEntries(project, [node.path], isFile ? "file path" : "path") : [])
    ];
  };

  return (
    <div className="explorer-tree">
      <FilterField placeholder="Filter files..." value={filter} onChange={setFilter} />
      <div
        className="tree"
        onContextMenu={(event) => {
          // Only the empty space below the rows.
          if (event.target === event.currentTarget) {
            menu.open(event, null);
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
          onContextMenu={menu.open}
          rows={rows.current}
        />
      </div>
      {menu.render(menuEntries)}
    </div>
  );
});

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
        setHeld((previous) => ({
          projectId,
          listing: keepRoots(previous?.projectId === projectId ? previous.listing : undefined, result)
        }));
        setListing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, changesKey, explorerVersion, shown]);
  return { explorerListing: held?.projectId === projectId ? held.listing : undefined, listing, refreshExplorer };
}

/** The listing with the previous `roots` where unchanged: the reveal effect depends on it, and a
 *  new array per re-read would scroll back to the selection on every change of the tree. */
function keepRoots(previous: ExplorerListing | undefined, next: ExplorerListing): ExplorerListing {
  const before = previous?.roots;
  const after = next.roots;
  const same =
    before !== undefined &&
    after !== undefined &&
    before.length === after.length &&
    before.every((root, index) => root.name === after[index].name && root.path === after[index].path);
  return same ? { ...next, roots: before } : next;
}
