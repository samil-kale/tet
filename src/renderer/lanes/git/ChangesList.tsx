import { memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { syncRemote } from "../../../shared/types/git";
import type { ChangeStatus, GitActionResult, RepositoryState } from "../../../shared/types/git";
import type { ProjectRef } from "../../../shared/types/project";
import type { ResolvedRef } from "../../resolved-ref";
import type { OpenEditor } from "../../editor/editor-tab";
import { runWithFollowUp, type FileAct, type FileAsk } from "../../git/run-action";
import { baseName, extensionOf, parentOf } from "../../paths";
import { openEntries, pathEntries } from "../../editor/file-menu";
import {
  buildTree,
  compactTree,
  compareGrouped,
  compareNames,
  filesByNode,
  foldersIn,
  sortTree,
  visibleRows,
  type TreeNode,
} from "../../ui/tree";
import { CHECK_INDENT_STEP, INDENT_BASE, TreeCheckbox, TreeRow, ChevronBox, type CheckState } from "../../ui/tree-row";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { confirmed, confirmedFollowUp, filled, prompt } from "../../ui/Dialog";
import { askLogin } from "../../git/GitLogin";
import { Checkbox, SuggestField } from "../../ui/Field";
import { FilterField } from "../../ui/FilterField";
import type { CollapseExpandAll } from "../../ui/CollapseExpandAllButton";
import { notify } from "../../ui/Notices";

interface ChangesListProps {
  resolved: ResolvedRef;
  /** The changes are the list. */
  state: RepositoryState;
  /** The owner shows it running on its own bar. */
  act: FileAct;
  /** On a double-click; a Markdown file with its preview from the menu. */
  onOpenDiff: (path: string, how?: OpenEditor) => void;
  /** Grouped by folder, or every file under the root with its folder after its name. */
  asTree: boolean;
  /** What the header's Commit and Discard act on, reported as it changes: the checked files the
   *  filter shows — one it hides is never committed or discarded unseen. */
  onChecked: (paths: string[]) => void;
  /** What the header's collapse/expand button does next, reported as it changes: collapse while a
   *  folder under the root is expanded, else expand. */
  onExpanded: (expanded: boolean) => void;
  ref?: React.Ref<ChangesListHandle>;
}

/** For the LOCAL CHANGES header's collapse/expand button. */
export type ChangesListHandle = CollapseExpandAll;

export const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "C",
};

/** The top row, standing for every change the filter shows. Its id is no path's. */
const ROOT_ID = "";

/** What the top row counts, grey after its name as IntelliJ's. */
function fileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

/** Whether git commits these paths now: some of the changes can't be committed while a merge is
 *  being concluded, all of them can (`askCommit` commits them as all). */
export function canCommit(state: RepositoryState, paths: string[]): boolean {
  return paths.length > 0 && (state.operation === undefined || paths.length === state.changes.length);
}

/** The files go to the trash; where the trash fails, a second question offers to delete them.
 *  Asked although the trash can give them back: a discard is GitHub Desktop's one confirmed
 *  action, and a click on a row's × would otherwise empty the list. */
export async function confirmDiscard(ref: ProjectRef, paths: string[], act: FileAct): Promise<void> {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  if (
    await confirmed({
      title: "Discard changes",
      message: `Are you sure you want to discard all changes to ${what}?`,
      detail: "The changed files go to the trash and can be restored from there.",
      confirmLabel: "Discard changes",
    })
  ) {
    runWithFollowUp(
      act,
      () => window.tet.repository.discard(ref, paths, false),
      "trash-failed",
      // Not asked while another question is up (`askLogin`): the trash's refusal is told instead.
      ({ error }) =>
        confirmedFollowUp(
          {
            title: "Discard changes permanently",
            message: "The files could not be moved to the trash. Discard the changes permanently?",
            detail: error,
            confirmLabel: "Discard permanently",
          },
          error ?? "The files could not be moved to the trash",
        ),
      () => window.tet.repository.discard(ref, paths, true),
    );
  }
}

/** One message, then `add` and `commit` of all changes or only `paths`, optionally pushing. No
 *  staging area: the checked files are what one commit takes. Every change given is all of them. */
export async function askCommit(ref: ProjectRef, state: RepositoryState, given: string[] | undefined, ask: FileAsk): Promise<void> {
  const paths = given?.length === state.changes.length ? undefined : given;
  // Told before the question: a message typed for a commit that cannot go is typed for nothing.
  const refusal = await window.tet.repository.commitRefusal(ref, paths);
  if (refusal !== undefined) {
    notify("error", refusal);
    return;
  }
  const { remote, canSync } = syncRemote(state);
  // No checkbox without a remote or on a detached HEAD. Worded as the push button is (GitLane).
  const pushLabel = canSync ? (state.upstream === undefined ? "Also publish branch" : `Also push ${remote}`) : undefined;
  /** What Commit ran, held to tell the push's failure or ask for its login once the commit's
   *  question is gone — only one question is up at a time. */
  const running: { submitted?: Promise<{ committed: GitActionResult; pushed?: GitActionResult }> } = {};
  const commitAndPush = async (message: string, push: boolean) => {
    const committed = await (paths
      ? window.tet.repository.commitPaths(ref, message, paths)
      : window.tet.repository.commitAll(ref, message));
    return { committed, pushed: committed.ok && push ? await window.tet.repository.push(ref) : undefined };
  };
  await prompt({
    title: !paths ? "Commit all changes" : paths.length === 1 ? "Commit changes" : `Commit ${paths.length} changes`,
    detail: !paths
      ? `Stages and commits all ${state.changes.length} changed files, untracked ones included.`
      : paths.length === 1
        ? `Stages and commits ${paths[0]}; the other changes stay as they are.`
        : `Stages and commits these ${paths.length} files; the other changes stay as they are.`,
    value: { message: "", push: pushLabel !== undefined && (await window.tet.settings.get()).git.pushOnCommit },
    confirmLabel: "Commit",
    ready: ({ message }) => filled(message),
    render: ({ value, onChange, error, busy, field, hold }) => (
      <>
        <SuggestField
          label="Message"
          value={value.message}
          onChange={(message) => onChange((current) => ({ ...current, message }))}
          suggestion={{
            title: "Suggest a commit message",
            run: () => window.tet.repository.suggestCommitMessage(ref, paths),
          }}
          disabled={busy}
          ref={field}
          error={error}
          onSuggesting={hold}
        />
        {pushLabel && <Checkbox label={pushLabel} checked={value.push} disabled={busy} onChange={(push) => onChange({ ...value, push })} />}
      </>
    ),
    abort: window.tet.repository.cancelCommitSuggestion,
    // What git refused — an empty commit, a hook's veto — at the message it was typed for. Not the
    // push: the commit stands, so the question is done, and a Commit again would commit twice.
    submit: ({ message, push }) => {
      running.submitted = commitAndPush(message.trim(), push);
      return ask(async () => (await running.submitted!).committed);
    },
  });
  const pushed = (await running.submitted)?.pushed;
  if (pushed?.loginUrl !== undefined) {
    await askLogin(pushed.loginUrl, pushed.error ?? "Push failed", (login) => ask(() => window.tet.repository.push(ref, login)));
  } else if (pushed && !pushed.ok) {
    notify("error", pushed.error ?? "Push failed");
  }
}

/**
 * LOCAL CHANGES: the changed files under one "Changes" row, grouped by folder or flat, each with a
 * checkbox — IntelliJ's commit view. The checked files are what the header's Commit and Discard
 * take, and nothing else does: a row's menu holds what they don't cover. Shaped as the Explorer,
 * so its class carries the styles they share.
 */
export const ChangesList = memo(function ChangesList({
  resolved,
  state,
  act,
  onOpenDiff,
  asTree,
  onChecked,
  onExpanded,
  ref,
}: ChangesListProps) {
  const { changes } = state;
  const [filter, setFilter] = useState("");
  /** A file not listed before comes in checked or not by the setting (`GitSettings.checkNewChanges`). */
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  /** The files listed last, so a later one is told from those already there. */
  const listed = useRef<ReadonlySet<string>>(new Set());
  /** Folders start expanded; only what was collapsed is kept. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menu = useContextMenu<TreeNode>();

  // Drop files no longer changed, or a later change reappears checked. In render, so the stale
  // checks never paint.
  const [prunedFor, setPrunedFor] = useState(changes);
  if (prunedFor !== changes) {
    setPrunedFor(changes);
    setChecked((current) => {
      const changed = new Set(changes.map((change) => change.path));
      const kept = [...current].filter((path) => changed.has(path));
      return kept.length === current.size ? current : new Set(kept);
    });
  }

  // Read per new file rather than once: a Save in the settings reaches a list already open.
  useEffect(() => {
    const paths = changes.map((change) => change.path);
    const fresh = paths.filter((path) => !listed.current.has(path));
    listed.current = new Set(paths);
    if (fresh.length === 0) {
      return;
    }
    void window.tet.settings.get().then(({ git }) => {
      // Only what is still listed: a refresh may have dropped a file meanwhile.
      const stillListed = fresh.filter((path) => listed.current.has(path));
      if (git.checkNewChanges && stillListed.length > 0) {
        setChecked((current) => new Set([...current, ...stillListed]));
      }
    });
  }, [changes]);

  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;
  const byPath = useMemo(() => new Map(changes.map((change) => [change.path, change])), [changes]);
  /** Filtered before it is grouped: a file's path holds its folders' names. */
  const root = useMemo((): TreeNode => {
    const paths = changes.map((change) => change.path).filter((path) => path.toLowerCase().includes(query));
    let children: TreeNode[];
    if (asTree) {
      children = buildTree(paths);
      sortTree(children, (a, b) => compareGrouped(a, b, true));
    } else {
      children = paths.map((path) => ({ id: path, name: baseName(path), path }));
      children.sort((a, b) => compareNames(a, b) || a.path.localeCompare(b.path));
    }
    const top: TreeNode = { id: ROOT_ID, name: "Changes", path: "", children, root: true };
    return asTree ? compactTree([top])[0] : top;
  }, [changes, query, asTree]);

  const rows = useMemo(() => visibleRows([root], (node) => filtering || (expanded[node.id] ?? true)), [root, expanded, filtering]);
  /** What each row's checkbox stands for, read once per tree rather than per row and render. */
  const filesOf = useMemo(() => filesByNode([root]), [root]);
  const shownFiles = filesOf.get(ROOT_ID)!;

  const shownChecked = useMemo(() => shownFiles.filter((path) => checked.has(path)), [shownFiles, checked]);
  useEffect(() => onChecked(shownChecked), [shownChecked, onChecked]);
  const anyExpanded = root.children!.some((node) => node.children !== undefined && (expanded[node.id] ?? true));
  useEffect(() => onExpanded(anyExpanded), [anyExpanded, onExpanded]);

  useImperativeHandle(ref, () => ({
    // Folders start expanded, so nothing collapsed is everything expanded.
    expandAll: () => setExpanded({}),
    // The root stays expanded: what is collapsed is every folder under it.
    collapseAll: () => setExpanded(Object.fromEntries(foldersIn(root.children!).map((id) => [id, false]))),
  }));

  const checkState = (node: TreeNode): CheckState => {
    const files = filesOf.get(node.id)!;
    const count = files.filter((path) => checked.has(path)).length;
    return count === 0 ? false : count === files.length ? true : "mixed";
  };
  /** A file flips; a folder all checked is unchecked, any other is checked whole (IntelliJ). */
  const toggleChecked = (node: TreeNode): void => {
    const files = filesOf.get(node.id)!;
    setChecked((current) => {
      const next = new Set(current);
      const all = files.every((path) => current.has(path));
      for (const path of files) {
        if (all) {
          next.delete(path);
        } else {
          next.add(path);
        }
      }
      return next;
    });
  };

  /** What the checkboxes don't cover: commit and discard go by them alone, from the header. */
  const menuEntries = (node: TreeNode): ContextMenuEntry[] => {
    const change = node.children ? undefined : byPath.get(node.path);
    if (!change) {
      // Without its leading separator: nothing stands above it.
      return pathEntries(resolved, [node.path], "path").slice(1);
    }
    const extension = extensionOf(baseName(change.path));
    const ignore = (scope: "file" | "extension") => () => act(() => window.tet.repository.ignore(resolved.ref, change.path, scope));
    const entries: ContextMenuEntry[] = [
      { label: "Open Changes", run: () => onOpenDiff(change.path) },
      ...openEntries(resolved.ref, change.path, true, true, (how) => onOpenDiff(change.path, how)),
      ...pathEntries(resolved, [change.path], "file path"),
    ];
    if (change.status === "untracked") {
      entries.push(SEPARATOR, { label: "Ignore file (add to .gitignore)", run: ignore("file") });
      if (extension) {
        entries.push({ label: `Ignore all ${extension} files (add to .gitignore)`, run: ignore("extension") });
      }
    }
    return entries;
  };

  return (
    <div className="explorer-tree">
      <FilterField placeholder="Filter changes..." value={filter} onChange={setFilter} />
      <div className="tree">
        {changes.length > 0 &&
          rows.map(({ node, depth, expanded: isExpanded }) => {
            const change = node.children ? undefined : byPath.get(node.path);
            const box = <TreeCheckbox checked={checkState(node)} onToggle={() => toggleChecked(node)} />;
            return (
              <TreeRow
                key={node.id}
                indent={INDENT_BASE + depth * CHECK_INDENT_STEP}
                title={change ? (change.origPath ? `${change.origPath} → ${change.path}` : change.path) : node.path || undefined}
                onClick={change ? () => onOpenDiff(change.path) : () => setExpanded((current) => ({ ...current, [node.id]: !isExpanded }))}
                // As the Explorer: a single click previews, a double click keeps.
                onDoubleClick={change ? () => onOpenDiff(change.path, { keep: true }) : undefined}
                onContextMenu={(event) => menu.open(event, node)}
                icon={
                  change ? (
                    <>
                      <ChevronBox />
                      {box}
                      <span className={`tree-icon change-status ${change.status}`}>{STATUS_LETTER[change.status]}</span>
                    </>
                  ) : (
                    <>
                      <ChevronBox expanded={isExpanded} />
                      {box}
                    </>
                  )
                }
                label={node.name}
              >
                {node.id === ROOT_ID && <span className="tree-dir">{fileCount(shownFiles.length)}</span>}
                {change && !asTree && parentOf(change.path) && <span className="tree-dir">{parentOf(change.path)}</span>}
              </TreeRow>
            );
          })}
      </div>
      {menu.render(menuEntries)}
    </div>
  );
});
