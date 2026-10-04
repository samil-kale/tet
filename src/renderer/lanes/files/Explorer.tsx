import { memo, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { refKeyOf } from "../../../shared/types/project";
import type { ExplorerListing } from "../../../shared/types/files";
import type { GitActionResult } from "../../../shared/types/git";
import type { ProjectRef } from "../../../shared/types/project";
import type { ResolvedRef } from "../../resolved-ref";
import type { OpenEditor } from "../../editor/editor-tab";
import type { FileAct, FileAsk } from "../../git/run-action";
import { openEntries, pathEntries } from "../../editor/file-menu";
import { ancestorsOf, buildForest, hasExpandedRootChild, rootIndexFor } from "./explorer-tree";
import { baseName, parentOf } from "../../paths";
import { FileIconView } from "./file-icon";
import { compactTree, filterTree, foldersIn, isExpanded, visibleRows, type TreeNode, type VisibleRow } from "../../ui/tree";
import { INDENT_BASE, INDENT_STEP, TreeRow, ChevronBox } from "../../ui/tree-row";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { askName, confirmed } from "../../ui/Dialog";
import { FilterField } from "../../ui/FilterField";
import type { CollapseExpandAll } from "../../ui/CollapseExpandAllButton";

interface ExplorerRowProps extends VisibleRow {
  selected: boolean;
  toggle: (node: TreeNode) => void;
  onOpen: (path: string, how?: OpenEditor) => void;
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  rows: Map<string, HTMLButtonElement>;
}

/** Memoized with stable handlers: a collapse, a selection or a menu re-renders only the rows it
 *  changes, not the whole expanded tree. */
const ExplorerRow = memo(function ExplorerRow({ node, depth, expanded, selected, toggle, onOpen, onContextMenu, rows }: ExplorerRowProps) {
  const isFolder = node.children !== undefined;
  const register = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        rows.set(node.id, element);
      } else {
        rows.delete(node.id);
      }
    },
    [rows, node.id]
  );
  return (
    <TreeRow
      ref={register}
      className={!isFolder && selected ? "selected" : undefined}
      indent={INDENT_BASE + depth * INDENT_STEP}
      title={node.path || "."}
      onClick={() => (isFolder ? toggle(node) : onOpen(node.path))}
      // VS Code: a single click previews, a double click keeps. The clicks before it
      // already opened the file, so this only keeps.
      onDoubleClick={() => !isFolder && onOpen(node.path, { keep: true })}
      onContextMenu={(event) => onContextMenu(event, node)}
      icon={isFolder ? <ChevronBox expanded={expanded} /> : <FileIconView name={node.name} />}
      label={node.name}
    />
  );
});

interface ExplorerProps {
  resolved: ResolvedRef;
  /** Undefined while the listing is read. */
  files: ExplorerListing | undefined;
  /** False while hidden behind the git lane, where a row can't be scrolled to. */
  shown: boolean;
  /** The active editor tab's file — revealed and highlighted. */
  selected: string | null;
  /** In the preview tab, or kept (`editor-tab.ts`); a Markdown file with its preview if asked.
   *  The repository or worktree is named: the same handler serves every view that opens a file. */
  onOpenFile: (ref: ProjectRef, path: string, how?: OpenEditor) => void;
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
  /** What the header's collapse/expand button does next, reported as it changes: collapse while a
   *  folder at the top is expanded — any expanded folder shows under one — else expand. */
  onExpanded: (expanded: boolean) => void;
  ref?: React.Ref<ExplorerHandle>;
}

/** For the EXPLORER header's title-bar buttons. */
export interface ExplorerHandle extends CollapseExpandAll {
  newFile(): void;
  newFolder(): void;
  clearFilter(): void;
}

/**
 * The files lane's tree of every repository file. No ↑/↓ of its own. Shaped by tet.json via the
 * listing: `folders` make it multi-root (overlap allowed); `exclude`/`excludeGitIgnore` are already
 * applied; `sortOrder`/`compactFolders` are applied here. Its field filters it by name; what a
 * search finds in the files' lines is the section under it (`FileSearch`).
 */
export const Explorer = memo(function Explorer({
  resolved,
  files,
  shown: visible,
  selected,
  onOpenFile,
  ask,
  act,
  onExplorerChanged,
  onFiltering,
  onExpanded,
  ref
}: ExplorerProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menu = useContextMenu<TreeNode | null>();
  const rows = useRef(new Map<string, HTMLButtonElement>());
  /** The repository or worktree is this view's; the rows say only which file and how. */
  const onOpen = useCallback(
    (path: string, how?: OpenEditor) => onOpenFile(resolved.ref, path, how),
    [onOpenFile, resolved.ref]
  );

  const tree = useMemo(() => (files ? buildForest(files) : []), [files]);
  // Deferred: a short query keeps most of the tree, all of it expanded — too much to render on
  // every keystroke.
  const query = useDeferredValue(filter.trim().toLowerCase());
  const filtering = query.length > 0;
  // The clear button is the header's; only the tree knows whether there is a filter to clear.
  useEffect(() => onFiltering(filtering), [filtering, onFiltering]);
  // Compacted after filtering: a folder pruned to one subfolder is compacted with it.
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
  // DOM yet) and `shown` (the listing arrives after the view opens). The pending ref keeps an expand
  // or collapse from yanking back to an old selection; it stays pending while hidden behind git.
  useEffect(() => {
    if (visible && pendingReveal.current) {
      const row = rows.current.get(pendingReveal.current);
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        pendingReveal.current = null;
      }
    }
  }, [selected, expanded, shown, visible]);

  const toggle = useCallback(
    (node: TreeNode): void => setExpanded((current) => ({ ...current, [node.id]: !isExpanded(node, current) })),
    []
  );
  const flat = useMemo(
    () => visibleRows(shown, (node) => filtering || isExpanded(node, expanded)),
    [shown, expanded, filtering]
  );
  const anyExpanded = tree.some((node) => node.children !== undefined && isExpanded(node, expanded));
  useEffect(() => onExpanded(anyExpanded), [anyExpanded, onExpanded]);

  // Expands and collapses by ids of the uncompacted `tree`, which compacted rows keep.
  const setAll = (ids: string[], expand: boolean): void =>
    setExpanded((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, expand])) }));
  /** "Collapse Folders in Explorer" in two stages: what is expanded below the roots, then everything
   *  (at once without roots). */
  const collapseAll = (): void =>
    setAll(
      roots && hasExpandedRootChild(tree, expanded) ? tree.flatMap((root) => foldersIn(root.children!)) : foldersIn(tree),
      false
    );

  /** The action, then a listing re-read on success. */
  const reread = (action: () => Promise<GitActionResult>) => () =>
    action().then((result) => {
      if (result.ok) {
        onExplorerChanged();
      }
      return result;
    });
  /** The lane's `ask`, re-reading: for the questions that stay up to show what refused them. */
  const runAsked: FileAsk = (action) => ask(reread(action));
  /** The lane's `act`, likewise, for a menu entry that asks nothing. */
  const run: FileAct = (action) => act(reread(action));

  const under = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

  const askNew = async (kind: "file" | "folder", dir: string): Promise<void> => {
    const create = kind === "file" ? window.tet.repository.createFile : window.tet.repository.createDirectory;
    await askName({
      title: kind === "file" ? "New File" : "New Folder",
      detail: dir ? `Created inside ${dir}.` : "Created at the repository root.",
      confirmLabel: "Create",
      submit: (name) => runAsked(() => create(resolved.ref, under(dir, name)))
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
        runAsked(() => window.tet.repository.renamePath(resolved.ref, node.path, under(parentOf(node.path), name)))
    });
  };

  // Asked although the trash can give it back: VS Code's Explorer asks too, and a slip on the
  // menu would otherwise take a folder out from under a running agent.
  const askDelete = async (node: TreeNode): Promise<void> => {
    const isFolder = node.children !== undefined;
    const answer = await confirmed({
      title: isFolder ? "Delete folder" : "Delete file",
      message: `Are you sure you want to delete ${node.path}?`,
      detail: "Goes to the trash and can be restored from there.",
      confirmLabel: "Delete"
    });
    if (answer) {
      run(() => window.tet.repository.deletePath(resolved.ref, node.path));
    }
  };

  // The header's buttons act on the repository root.
  useImperativeHandle(ref, () => ({
    newFile: () => void askNew("file", ""),
    newFolder: () => void askNew("folder", ""),
    expandAll: () => setAll(foldersIn(tree), true),
    collapseAll,
    clearFilter: () => setFilter("")
  }));

  /** `ChangesList`'s menu minus the change-only entries, plus new/rename/delete and the Explorer view's
   *  entries writing tet.json. A root is a view onto a folder, so it is never renamed or deleted. */
  const menuEntries = (node: TreeNode | null): ContextMenuEntry[] => {
    const dir = node ? (node.children !== undefined ? node.path : parentOf(node.path)) : "";
    const isFile = node !== null && node.children === undefined;
    const isRoot = node?.root === true;

    const fileEntries: ContextMenuEntry[] = isFile
      ? [
          { label: "Open", run: () => onOpen(node.path) },
          ...openEntries(resolved.ref, node.path, true, false, (how) => onOpen(node.path, how)),
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
    // A worktree shows its project's Explorer view and never changes it (tet-json.ts's configRoot).
    if (node && resolved.ref.worktree === undefined) {
      viewEntries.push(SEPARATOR);
      if (isRoot) {
        viewEntries.push({
          label: "Remove Folder from Explorer",
          run: () => run(() => window.tet.repository.removeFolder(resolved.ref.projectId, node.path))
        });
      } else {
        if (!isFile) {
          viewEntries.push({
            label: "Add Folder to Explorer",
            run: () => run(() => window.tet.repository.addFolder(resolved.ref.projectId, node.path))
          });
        }
        viewEntries.push({
          label: "Exclude from Explorer",
          run: () => run(() => window.tet.repository.excludePath(resolved.ref.projectId, node.path))
        });
      }
    }

    return [
      ...fileEntries,
      { label: "New File...", run: () => void askNew("file", dir) },
      { label: "New Folder...", run: () => void askNew("folder", dir) },
      ...editEntries,
      ...viewEntries,
      ...(node ? pathEntries(resolved, [node.path], isFile ? "file path" : "path") : [])
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
        {flat.map((row) => (
          <ExplorerRow
            key={row.node.id}
            {...row}
            selected={selected === row.node.path}
            toggle={toggle}
            onOpen={onOpen}
            onContextMenu={menu.open}
            rows={rows.current}
          />
        ))}
      </div>
      {menu.render(menuEntries)}
    </div>
  );
});

/**
 * The Explorer's listing, carrying the view settings. Re-read, as VS Code's, on what the
 * filesystem reports and never on git status: on `onFilesChanged` (a path came or went, an
 * ignore file changed, or a setting of the listing was saved), on tet.json writes, on window focus for what the watcher missed (a network
 * share watches nothing), and via `refreshExplorer` after the tree's own edits.
 *
 * Held with its repository or worktree: one files lane serves all, and a switch must not show the
 * previous tree.
 */
export function useExplorerListing(
  resolved: ResolvedRef,
  shown: boolean
): { explorerListing: ExplorerListing | undefined; listing: boolean; refreshExplorer: () => void } {
  const [held, setHeld] = useState<{ refKey: string; listing: ExplorerListing } | undefined>(undefined);
  const [listing, setListing] = useState(false);
  const [explorerVersion, setExplorerVersion] = useState(0);
  const refreshExplorer = useCallback(() => setExplorerVersion((count) => count + 1), []);
  useEffect(() => {
    const bump = (): void => setExplorerVersion((count) => count + 1);
    // tet.json is the project's, wherever it shows; the files are this repository's or worktree's
    // own.
    const unsubscribeCommands = window.tet.commands.onChanged(({ projectId }) => {
      if (projectId === resolved.ref.projectId) {
        bump();
      }
    });
    const unsubscribeFiles = window.tet.repository.onFilesChanged((payload) => {
      if (refKeyOf(payload.ref) === resolved.refKey) {
        bump();
      }
    });
    window.addEventListener("focus", bump);
    return () => {
      unsubscribeCommands();
      unsubscribeFiles();
      window.removeEventListener("focus", bump);
    };
  }, [resolved]);
  // Read only while shown, and again on return: changes meanwhile went unread.
  useEffect(() => {
    if (!shown) {
      return;
    }
    let cancelled = false;
    setListing(true);
    void window.tet.repository.listExplorer(resolved.ref).then((result) => {
      if (!cancelled) {
        setHeld((previous) => ({
          refKey: resolved.refKey,
          listing: keepRoots(previous?.refKey === resolved.refKey ? previous.listing : undefined, result)
        }));
        setListing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolved, explorerVersion, shown]);
  return { explorerListing: held?.refKey === resolved.refKey ? held.listing : undefined, listing, refreshExplorer };
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
