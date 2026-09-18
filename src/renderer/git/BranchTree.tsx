import { memo, useMemo, useState } from "react";
import { refName, worktreeBase } from "../../shared/types";
import type { CheckoutTarget, GitActionResult, RepositoryState, StashEntry, WorktreeInfo } from "../../shared/types";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt } from "../ui/Dialog";
import { notify } from "../ui/Notices";
import { useCollapsedSections } from "../ui/Sash";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BranchIcon,
  ChevronIcon,
  RemoteIcon,
  SearchIcon,
  StashIcon,
  TagIcon,
  TREE_CHEVRON,
  WorktreeIcon
} from "../ui/icons";
import { askDeleteWorktree, askNewWorktree, askRenameWorktree } from "./worktree-questions";

/** One git command at a time per project, labelled while it runs. The tree asks its questions
 *  itself, knowing which remote holds a branch and where HEAD is. */
export interface BranchActions {
  /** A command runs in this project; no second one is offered. */
  busy: boolean;
  /** That command was started here, so this pane's bar shows it; one started from the project
   *  list shows in that list's bar instead. */
  startedHere: boolean;
  run: (label: string, action: () => Promise<GitActionResult>) => void;
}

interface BranchTreeProps {
  projectId: string;
  state: RepositoryState;
  branch: BranchActions;
  /** Brings the worktree's project to the front, opening it first when it is not a project yet. */
  onOpenWorktree: (worktreePath: string) => void;
  /** Whether the unsaved editor edits of the worktree's project, if it is one, may go. */
  canCloseWorktree: (worktreePath: string) => Promise<boolean>;
}

/** The row the menu was opened on. */
type MenuTarget =
  | { kind: "branch"; name: string; remote?: string }
  | { kind: "tag"; name: string }
  | { kind: "stash"; stash: StashEntry }
  | { kind: "worktree"; worktree: WorktreeInfo };

type BranchMenu = MenuTarget & { x: number; y: number };

const COMMITS_LOST = "Commits that exist only on this branch are lost.";

/** A worktree by its branch, which is its name; by its folder's while detached. */
function worktreeName(worktree: WorktreeInfo): string {
  return worktree.branch ?? worktree.path.split(/[\\/]/).filter(Boolean).pop() ?? worktree.path;
}

export const BranchTree = memo(function BranchTree({
  projectId,
  state,
  branch,
  onOpenWorktree,
  canCloseWorktree
}: BranchTreeProps) {
  const [filter, setFilter] = useState("");
  // Only local branches start open, as in GitHub Desktop; folds persist.
  const [isCollapsed, toggle] = useCollapsedSections("branch-tree.sections", ["remotes", "tags", "stashes"]);
  const [menu, setMenu] = useState<BranchMenu | null>(null);

  const query = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(query);

  // The linked ones alone: the main worktree is the repository itself, not one made from it. A
  // linked worktree and its branch are one (projects.ts), listed under WORKTREES only.
  const linkedWorktrees = useMemo(() => state.worktrees.filter((worktree) => !worktree.main), [state.worktrees]);
  const ownBranches = useMemo(
    () => state.localBranches.filter((name) => !linkedWorktrees.some((worktree) => worktree.branch === name)),
    [state.localBranches, linkedWorktrees]
  );
  const localBranches = useMemo(() => ownBranches.filter(matches), [ownBranches, query]);
  const remotes = useMemo(
    () => state.remotes.map((remote) => ({ ...remote, branches: remote.branches.filter(matches) })),
    [state.remotes, query]
  );
  // The filter reads as "find a ref", so it covers tags and worktrees too.
  const tags = useMemo(() => state.tags.filter(matches), [state.tags, query]);
  const worktrees = useMemo(
    () => linkedWorktrees.filter((worktree) => matches(worktreeName(worktree))),
    [linkedWorktrees, query]
  );
  /** A linked worktree keeps its branch: nothing here switches it (projects.ts couples the two). */
  const inWorktree = linkedWorktrees.some((worktree) => worktree.current);

  const isCurrent = (name: string): boolean => !state.detached && name === state.head;

  /** The current branch's from the status header; others' from `state.branchTrack`, which holds
   *  only branches differing from their upstream. */
  const track = (name: string): { ahead: number; behind: number } | undefined =>
    isCurrent(name) ? { ahead: state.ahead, behind: state.behind } : state.branchTrack[name];

  const repository = window.tet.repository;
  /** The remote commands use, picked as the main process does. */
  const remote = state.remotes[0]?.name;
  /** What "Update from" merges, prefixed by its remote where it is a remote branch. */
  const defaultRef = state.defaultBranch && refName(state.defaultBranch);
  /** Where a new worktree starts (worktreeBase), prefixed as `defaultRef`. */
  const worktreeStart = worktreeBase(state);
  const newWorktreeBase = worktreeStart && refName(worktreeStart);

  /** Where the local branch a checkout would switch to is checked out in another worktree. */
  const worktreeOf = (target: CheckoutTarget): string | undefined =>
    target.remote === undefined || state.localBranches.includes(target.name)
      ? state.worktrees.find((worktree) => !worktree.current && worktree.branch === target.name)?.path
      : undefined;

  /** A branch checked out in another worktree is shown there, as in GitHub Desktop; git would
   *  refuse the switch. */
  const checkout = (target: CheckoutTarget): void => {
    const worktree = worktreeOf(target);
    if (worktree !== undefined) {
      onOpenWorktree(worktree);
      return;
    }
    if (inWorktree) {
      notify("info", "A worktree keeps its own branch: check out in the main project, or create a new worktree");
      return;
    }
    branch.run(`Switching to ${target.name}...`, () => repository.checkout(projectId, target));
  };

  const askCreateBranch = async (startPoint: string): Promise<void> => {
    const answer = await prompt({
      title: "Create branch",
      label: "Name",
      detail: `The new branch starts at ${startPoint} and is checked out.`,
      value: "",
      confirmLabel: "Create branch"
    });
    if (answer) {
      branch.run(`Creating ${answer.value}...`, () => repository.createBranch(projectId, answer.value, startPoint));
    }
  };

  const askRenameBranch = async (name: string): Promise<void> => {
    const answer = await prompt({ title: "Rename branch", label: "Name", value: name, confirmLabel: "Rename" });
    if (answer && answer.value !== name) {
      branch.run(`Renaming ${name}...`, () => repository.renameBranch(projectId, name, answer.value));
    }
  };

  /** `git branch -D`: unmerged work goes too, as the question says. The checked-out branch gives way
   *  to the default branch first. Its upstream is a checkbox where it has one. */
  const askDeleteBranch = async (name: string): Promise<void> => {
    const upstream = state.branchUpstreams[name];
    const answer = await confirm({
      title: "Delete branch",
      message: `Are you sure you want to delete ${name}?`,
      detail: isCurrent(name) && defaultRef ? `Switches to ${defaultRef} first. ${COMMITS_LOST}` : COMMITS_LOST,
      confirmLabel: "Delete branch",
      checkboxLabel: upstream ? `Also delete ${upstream.remote}/${upstream.branch} on the remote` : undefined
    });
    if (answer.confirmed) {
      branch.run(`Deleting ${name}...`, () => repository.deleteBranch(projectId, name, answer.checked));
    }
  };

  const askDeleteRemoteBranch = async (from: string, name: string): Promise<void> => {
    const answer = await confirm({
      title: "Delete remote branch",
      message: `Are you sure you want to delete ${name} on ${from}?`,
      detail: COMMITS_LOST,
      confirmLabel: "Delete branch"
    });
    if (answer.confirmed) {
      branch.run(`Deleting ${from}/${name}...`, () => repository.deleteRemoteBranch(projectId, from, name));
    }
  };

  /** Asks first only when the main process answers `rewritesPushed`, as GitHub Desktop warns. */
  const rebaseOnto = (ref: string, confirmed = false): void =>
    branch.run(`Rebasing onto ${ref}...`, async () => {
      const result = await repository.rebase(projectId, ref, confirmed);
      if (!result.rewritesPushed) {
        return result;
      }
      void askRebasePushed(ref);
      return { ok: true };
    });

  const askRebasePushed = async (ref: string): Promise<void> => {
    const answer = await confirm({
      title: "Rebase",
      message: `Rebasing ${state.head} onto ${ref} rewrites commits already on ${state.upstream}.`,
      detail: "Pushing the branch afterwards takes a force push, which is for a terminal.",
      confirmLabel: "Rebase"
    });
    if (answer.confirmed) {
      rebaseOnto(ref, true);
    }
  };

  const askCreateTag = async (target: string): Promise<void> => {
    const answer = await prompt({
      title: "Create tag",
      label: "Name",
      detail: `The tag points at ${target}.`,
      value: "",
      confirmLabel: "Create tag",
      extras: [{ label: "Message", placeholder: "Optional" }]
    });
    if (answer) {
      branch.run(`Creating tag ${answer.value}...`, () =>
        repository.createTag(projectId, answer.value, target, answer.extras[0])
      );
    }
  };

  const askDeleteTag = async (name: string): Promise<void> => {
    const answer = await confirm({
      title: "Delete tag",
      message: `Are you sure you want to delete the tag ${name}?`,
      confirmLabel: "Delete tag",
      checkboxLabel: remote ? `Also delete it on ${remote}` : undefined
    });
    if (answer.confirmed) {
      branch.run(`Deleting tag ${name}...`, () => repository.deleteTag(projectId, name, answer.checked));
    }
  };

  const askDropStash = async (stash: StashEntry): Promise<void> => {
    const answer = await confirm({
      title: "Drop stash",
      message: `Are you sure you want to drop ${stash.ref}?`,
      detail: stash.message,
      confirmLabel: "Drop stash"
    });
    if (answer.confirmed) {
      branch.run(`Dropping ${stash.ref}...`, () => repository.stash(projectId, "drop", stash.sha));
    }
  };

  /** Aborting a merge or rebase, first on every row: it is repository-wide and blocks all else. */
  const abortEntries = (): ContextMenuEntry[] => {
    if (!state.operation) {
      return [];
    }
    const label = state.operation === "merge" ? "Abort merge" : "Abort rebase";
    return [{ label, run: () => branch.run(`${label}...`, () => repository.abort(projectId)) }, SEPARATOR];
  };

  /** Brings the default branch into HEAD; every fetch moves a local default branch up to its
   *  upstream. Nothing to bring in while standing on the default branch. */
  const updateFromDefault = (): ContextMenuEntry => ({
    label: `Update from ${defaultRef ?? "the default branch"}`,
    run:
      defaultRef && !state.detached && state.head !== defaultRef
        ? () => branch.run(`Merging ${defaultRef}...`, () => repository.merge(projectId, defaultRef))
        : undefined
  });

  const branchEntries = (menu: Extract<BranchMenu, { kind: "branch" }>): ContextMenuEntry[] => {
    const { name, remote: from } = menu;
    // Prefixed by its remote everywhere but the checkout, which creates the tracking branch.
    const ref = from ? `${from}/${name}` : name;
    const current = from === undefined && isCurrent(name);
    const onHead = current || state.detached;
    // The checked-out branch gives way to the default branch, unless it is that branch.
    const deletable = !current || (defaultRef !== undefined && defaultRef !== name);

    return [
      ...abortEntries(),
      { label: "Check out", run: current || inWorktree ? undefined : () => checkout({ name, remote: from }) },
      // It checks the new branch out, which a worktree's own branch never gives way to.
      { label: `Create branch from ${ref}...`, run: inWorktree ? undefined : () => void askCreateBranch(ref) },
      ...(from
        ? [{ label: "Delete...", run: () => void askDeleteRemoteBranch(from, name) }]
        : [
            { label: "Rename...", run: () => void askRenameBranch(name) },
            { label: "Delete...", run: deletable ? () => void askDeleteBranch(name) : undefined }
          ]),
      SEPARATOR,
      // On HEAD's row: bring the default branch in instead.
      ...(onHead
        ? [updateFromDefault()]
        : [
            {
              label: `Merge ${ref} into ${state.head}`,
              run: () => branch.run(`Merging ${ref}...`, () => repository.merge(projectId, ref))
            },
            {
              label: `Rebase ${state.head} onto ${ref}`,
              run: () => rebaseOnto(ref)
            }
          ]),
      SEPARATOR,
      { label: "Create tag...", run: () => void askCreateTag(ref) },
      { label: "Copy branch name", run: () => void navigator.clipboard.writeText(ref) }
    ];
  };

  /** Checking out a tag leaves HEAD detached, as in git. */
  const tagEntries = (name: string): ContextMenuEntry[] => [
    ...abortEntries(),
    {
      label: "Check out",
      run: inWorktree ? undefined : () => branch.run(`Switching to ${name}...`, () => repository.checkoutTag(projectId, name))
    },
    {
      label: remote ? `Push to ${remote}` : "Push",
      run: remote ? () => branch.run(`Pushing ${name}...`, () => repository.pushTag(projectId, name)) : undefined
    },
    { label: "Delete...", run: () => void askDeleteTag(name) },
    SEPARATOR,
    { label: "Copy tag name", run: () => void navigator.clipboard.writeText(name) }
  ];

  /** Each acts on the stash's commit, not its ref, which a drop renumbers. */
  const stashEntries = (stash: StashEntry): ContextMenuEntry[] => [
    ...abortEntries(),
    {
      label: "Apply",
      run: () => branch.run(`Applying ${stash.ref}...`, () => repository.stash(projectId, "apply", stash.sha))
    },
    {
      label: "Pop",
      run: () => branch.run(`Popping ${stash.ref}...`, () => repository.stash(projectId, "pop", stash.sha))
    },
    { label: "Drop...", run: () => void askDropStash(stash) }
  ];

  /**
   * A linked worktree's — its branch's too, which is listed nowhere else: merged into this one's
   * HEAD, or, on the worktree this pane shows, updated from the default branch as HEAD's row does.
   */
  const worktreeEntries = (worktree: WorktreeInfo): ContextMenuEntry[] => {
    const name = worktreeName(worktree);
    const merged = worktree.branch;
    const mainPath = state.worktrees.find((entry) => entry.main)?.path;
    const linked = mainPath !== undefined ? { path: worktree.path, mainPath } : undefined;
    const upstream = merged ? state.branchUpstreams[merged] : undefined;
    const upstreamName = upstream ? `${upstream.remote}/${upstream.branch}` : undefined;
    const canClose = (): Promise<boolean> => canCloseWorktree(worktree.path);
    return [
      ...abortEntries(),
      { label: "Open", run: worktree.current ? undefined : () => onOpenWorktree(worktree.path) },
      worktree.current
        ? updateFromDefault()
        : {
            label: merged ? `Merge ${merged} into ${state.head}` : "Merge (no branch checked out)",
            run:
              merged && !state.detached
                ? () => branch.run(`Merging ${merged}...`, () => repository.merge(projectId, merged))
                : undefined
          },
      SEPARATOR,
      {
        label: "New worktree...",
        run: newWorktreeBase ? () => void askNewWorktree(projectId, branch.run, newWorktreeBase) : undefined
      },
      {
        label: "Rename worktree...",
        run: linked ? () => void askRenameWorktree(linked, name, branch.run, canClose) : undefined
      },
      {
        label: "Delete worktree...",
        run: linked ? () => void askDeleteWorktree(linked, name, upstreamName, branch.run, canClose) : undefined
      },
      SEPARATOR,
      { label: "Copy path", run: () => void navigator.clipboard.writeText(worktree.path) }
    ];
  };

  const menuEntries = (open: BranchMenu): ContextMenuEntry[] => {
    switch (open.kind) {
      case "branch":
        return branchEntries(open);
      case "tag":
        return tagEntries(open.name);
      case "stash":
        return stashEntries(open.stash);
      case "worktree":
        return worktreeEntries(open.worktree);
    }
  };

  const openMenu = (event: React.MouseEvent, target: MenuTarget): void => {
    event.preventDefault();
    setMenu({ ...target, x: event.clientX, y: event.clientY });
  };

  return (
    <div className={`branch-tree${branch.busy ? " busy" : ""}`}>
      <div className="filter-field">
        <SearchIcon className="filter-icon" />
        <input
          type="text"
          placeholder="Search branches..."
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="tree">
        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("local")}>
            <ChevronIcon expanded={!isCollapsed("local")} scale={TREE_CHEVRON} />
            <span>LOCAL BRANCHES</span>
            <span className="count-badge">({ownBranches.length})</span>
          </button>
          {!isCollapsed("local") &&
            localBranches.map((localBranch) => {
              const status = track(localBranch);
              return (
                <button
                  key={localBranch}
                  className={`tree-item${isCurrent(localBranch) ? " current" : ""}`}
                  title="Double-click to check out"
                  onDoubleClick={() => checkout({ name: localBranch })}
                  onContextMenu={(event) => openMenu(event, { kind: "branch", name: localBranch })}
                >
                  <BranchIcon className="tree-icon" />
                  <span className="tree-label">{localBranch}</span>
                  {status && (status.ahead > 0 || status.behind > 0) && (
                    <span className="tree-track">
                      {status.ahead > 0 && (
                        <span className="tree-track-count" title={`${status.ahead} to push`}>
                          <ArrowUpIcon />
                          <span className="tree-track-number">{status.ahead}</span>
                        </span>
                      )}
                      {status.behind > 0 && (
                        <span className="tree-track-count" title={`${status.behind} to pull`}>
                          <ArrowDownIcon />
                          <span className="tree-track-number">{status.behind}</span>
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
        </div>

        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("worktrees")}>
            <ChevronIcon expanded={!isCollapsed("worktrees")} scale={TREE_CHEVRON} />
            <span>WORKTREES</span>
            <span className="count-badge">({linkedWorktrees.length})</span>
          </button>
          {!isCollapsed("worktrees") &&
            worktrees.map((worktree) => (
              <button
                key={worktree.path}
                className={`tree-item${worktree.current ? " current" : ""}`}
                title={`${worktree.path}${worktree.current ? "" : "\nDouble-click to open"}`}
                onDoubleClick={() => !worktree.current && onOpenWorktree(worktree.path)}
                onContextMenu={(event) => openMenu(event, { kind: "worktree", worktree })}
              >
                <WorktreeIcon className="tree-icon" />
                <span className="tree-label">{worktreeName(worktree)}</span>
                {(worktree.branch === undefined || worktree.base) && (
                  <span className="tree-extra">{worktree.branch === undefined ? "detached" : worktree.base}</span>
                )}
              </button>
            ))}
        </div>

        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("remotes")}>
            <ChevronIcon expanded={!isCollapsed("remotes")} scale={TREE_CHEVRON} />
            <span>REMOTES</span>
            <span className="count-badge">({state.remotes.length})</span>
          </button>
          {!isCollapsed("remotes") &&
            remotes.map((entry) => (
              <div key={entry.name}>
                <button className="tree-item remote" onClick={() => toggle(`remote:${entry.name}`)}>
                  <ChevronIcon expanded={!isCollapsed(`remote:${entry.name}`)} scale={TREE_CHEVRON} />
                  <RemoteIcon className="tree-icon" />
                  <span className="tree-label">{entry.name}</span>
                  <span className="count-badge">({entry.branches.length})</span>
                </button>
                {!isCollapsed(`remote:${entry.name}`) &&
                  entry.branches.map((remoteBranch) => (
                    <button
                      key={remoteBranch}
                      className="tree-item nested"
                      title="Double-click to check out"
                      onDoubleClick={() => checkout({ name: remoteBranch, remote: entry.name })}
                      onContextMenu={(event) =>
                        openMenu(event, { kind: "branch", name: remoteBranch, remote: entry.name })
                      }
                    >
                      <BranchIcon className="tree-icon" />
                      <span className="tree-label">{remoteBranch}</span>
                    </button>
                  ))}
              </div>
            ))}
        </div>

        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("tags")}>
            <ChevronIcon expanded={!isCollapsed("tags")} scale={TREE_CHEVRON} />
            <span>TAGS</span>
            <span className="count-badge">({state.tags.length})</span>
          </button>
          {!isCollapsed("tags") &&
            tags.map((tag) => (
              <button
                key={tag}
                className="tree-item"
                title="Double-click to check out"
                onDoubleClick={() => branch.run(`Switching to ${tag}...`, () => repository.checkoutTag(projectId, tag))}
                onContextMenu={(event) => openMenu(event, { kind: "tag", name: tag })}
              >
                <TagIcon className="tree-icon" />
                <span className="tree-label">{tag}</span>
              </button>
            ))}
        </div>

        <div className="tree-section">
          <button className="tree-header" onClick={() => toggle("stashes")}>
            <ChevronIcon expanded={!isCollapsed("stashes")} scale={TREE_CHEVRON} />
            <span>STASHES</span>
            <span className="count-badge">({state.stashes.length})</span>
          </button>
          {!isCollapsed("stashes") &&
            state.stashes.map((stash) => (
              <button
                key={stash.ref}
                className="tree-item"
                // No double-click: apply and drop sit one right-click apart, and a drop is final.
                title={`${stash.ref}: ${stash.message}\nRight-click to apply, pop or drop it`}
                onContextMenu={(event) => openMenu(event, { kind: "stash", stash })}
              >
                <StashIcon className="tree-icon" />
                <span className="tree-label">{stash.message}</span>
              </button>
            ))}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
});
