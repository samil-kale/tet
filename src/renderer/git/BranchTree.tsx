import { memo, useState } from "react";
import type { ReactNode } from "react";
import { projectRefKey, projectRef, defaultRemote, refName, upstreamName, worktreeName } from "../../shared/types";
import type { CheckoutTarget, RepositoryState, StashEntry, WorktreeInfo } from "../../shared/types";
import type { ResolvedRef } from "../resolved-ref";
import type { GitRun } from "./run-action";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { askName, confirm, filled, prompt, questionUp } from "../ui/Dialog";
import { TextField } from "../ui/Field";
import { FilterField } from "../ui/FilterField";
import { notify } from "../ui/Notices";
import { useCollapsedSections } from "../ui/layout-storage";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BranchIcon,
  ChevronIcon,
  RemoteIcon,
  StashIcon,
  TagIcon,
  TREE_CHEVRON,
  WorktreeIcon
} from "../ui/icons";
import { askDeleteWorktree, askRenameWorktree, NOT_MADE_BY_TET, worktreeEntry } from "./worktree-questions";

/** One git command at a time per project, labelled while it runs (`GitRun`). The tree asks its
 *  questions itself, knowing which remote holds a branch and where HEAD is. */
export interface BranchActions extends GitRun {
  /** A command runs in this project; no second one is offered. */
  busy: boolean;
  /** That command was started here, so this pane's bar shows it; one started from the project
   *  list shows in that list's bar instead. */
  startedHere: boolean;
}

interface BranchTreeProps {
  resolved: ResolvedRef;
  state: RepositoryState;
  branch: BranchActions;
  /** Brings a repository or worktree of the project to the front, by its key — as a sidebar row
   *  does. */
  onSelect: (key: string) => void;
}

/** The row the menu was opened on. */
type MenuTarget =
  | { kind: "branch"; name: string; remote?: string }
  | { kind: "tag"; name: string }
  | { kind: "stash"; stash: StashEntry }
  | { kind: "worktree"; worktree: WorktreeInfo };

const COMMITS_LOST = "Commits that exist only on this branch are lost.";
const WORKTREE_KEEPS_BRANCH = "A worktree keeps its own branch: check out in the repository, or create a new worktree";

/**
 * One collapsible section of the tree. `rows` is called only while the section is open, so a
 * collapsed one with thousands of tags builds no elements.
 */
function TreeSection({
  label,
  count,
  collapsed,
  onToggle,
  rows
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  rows: () => ReactNode;
}) {
  return (
    <div className="tree-section">
      <button className="tree-header" onClick={onToggle}>
        <ChevronIcon expanded={!collapsed} className="tree-icon" scale={TREE_CHEVRON} />
        <span>{label}</span>
        <span className="count-badge">({count})</span>
      </button>
      {!collapsed && rows()}
    </div>
  );
}

export const BranchTree = memo(function BranchTree({
  resolved: shown,
  state,
  branch,
  onSelect
}: BranchTreeProps) {
  const at = shown.ref;
  const projectId = shown.ref.projectId;
  const [filter, setFilter] = useState("");
  // Only local branches start open, as in GitHub Desktop; folds persist.
  const [isCollapsed, toggle] = useCollapsedSections("branch-tree.sections", ["remotes", "tags", "stashes"]);
  const menu = useContextMenu<MenuTarget>();

  const query = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(query);

  // Plain computations, not memos: `state` is a new object on every push and `query` changes per
  // keystroke, so a memo would miss whenever it matters, to filter a few hundred strings.
  // The linked ones alone: the main one is the repository itself, not a worktree made from it. A
  // linked worktree and its branch are one (projects.ts), listed under WORKTREES only.
  const linkedWorktrees = state.worktrees.filter((worktree) => !worktree.main);
  const ownBranches = state.localBranches.filter((name) => !linkedWorktrees.some((worktree) => worktree.branch === name));
  const localBranches = ownBranches.filter(matches);
  const remotes = state.remotes.map((remote) => ({ ...remote, branches: remote.branches.filter(matches) }));
  // The filter reads as "find a ref", so it covers tags and worktrees too.
  const tags = state.tags.filter(matches);
  const worktrees = linkedWorktrees.filter((worktree) => matches(worktreeName(worktree)));
  /** A linked worktree keeps its branch: nothing here switches it (projects.ts couples the two). */
  const inWorktree = linkedWorktrees.some((worktree) => worktree.current);

  const isCurrent = (name: string): boolean => !state.detached && name === state.head;

  /** The current branch's from the status header; others' from `state.branchTrack`, which holds
   *  only branches differing from their upstream. */
  const track = (name: string): { ahead: number; behind: number } | undefined =>
    isCurrent(name) ? { ahead: state.ahead, behind: state.behind } : state.branchTrack[name];

  const repository = window.tet.repository;
  /** The remote tags go to (`defaultRemote`). */
  const remote = defaultRemote(state);
  /** What "Update from" merges, prefixed by its remote where it is a remote branch. */
  const defaultRef = state.defaultBranch && refName(state.defaultBranch);

  /** Where the local branch a checkout would switch to is checked out in another worktree. */
  const worktreeOf = (target: CheckoutTarget): WorktreeInfo | undefined =>
    target.remote === undefined || state.localBranches.includes(target.name)
      ? state.worktrees.find((worktree) => !worktree.current && worktree.branch === target.name)
      : undefined;

  /** Brings a worktree of the repository to the front: the main one, or one TET made; one made
   *  elsewhere is never opened, so it is only told. */
  const openWorktree = (worktree: WorktreeInfo): void => {
    if (worktree.main) {
      onSelect(projectRefKey(projectRef(projectId)));
    } else if (worktree.key !== undefined) {
      onSelect(projectRefKey(projectRef(projectId, worktree.key)));
    } else {
      notify("info", `${worktreeName(worktree)} is checked out in ${worktree.path}, a worktree ${NOT_MADE_BY_TET}`);
    }
  };

  /** A branch checked out in another worktree is shown there, as in GitHub Desktop; git would
   *  refuse the switch. */
  const checkout = (target: CheckoutTarget): void => {
    const worktree = worktreeOf(target);
    if (worktree !== undefined) {
      openWorktree(worktree);
      return;
    }
    if (inWorktree) {
      notify("info", WORKTREE_KEEPS_BRANCH);
      return;
    }
    branch.run(`Switching to ${target.name}...`, () => repository.checkout(at, target));
  };

  /** Checking out a tag leaves HEAD detached, as in git; never in a worktree, as `checkout`. */
  const checkoutTag = (name: string): void => {
    if (inWorktree) {
      notify("info", WORKTREE_KEEPS_BRANCH);
      return;
    }
    branch.run(`Switching to ${name}...`, () => repository.checkoutTag(at, name));
  };

  const askCreateBranch = async (startPoint: string): Promise<void> => {
    await askName({
      title: "Create branch",
      detail: `The new branch starts at ${startPoint} and is checked out.`,
      confirmLabel: "Create branch",
      // git's own words for a name it will not take, at the field (`prompt`'s `submit`).
      submit: (name) => branch.ask(`Creating ${name}...`, () => repository.createBranch(at, name, startPoint))
    });
  };

  const askRenameBranch = async (name: string): Promise<void> => {
    await askName({
      title: "Rename branch",
      current: name,
      confirmLabel: "Rename",
      submit: (typed) => branch.ask(`Renaming ${name}...`, () => repository.renameBranch(at, name, typed))
    });
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
      checkboxLabel: upstream ? `Also delete ${upstreamName(upstream)} on the remote` : undefined
    });
    if (answer.confirmed) {
      // With a login, the local branch is gone already: only its upstream is tried again.
      branch.run(`Deleting ${name}...`, (login) =>
        login && upstream
          ? repository.deleteRemoteBranch(at, upstream.remote, upstream.branch, login)
          : repository.deleteBranch(at, name, answer.checked)
      );
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
      branch.run(`Deleting ${from}/${name}...`, (login) => repository.deleteRemoteBranch(at, from, name, login));
    }
  };

  /** Asks first only when the main process answers `rewrites-pushed`, as GitHub Desktop warns. */
  const rebaseOnto = (ref: string, confirmed = false): void =>
    branch.run(`Rebasing onto ${ref}...`, async () => {
      const result = await repository.rebase(at, ref, confirmed);
      if (result.needsConfirmation !== "rewrites-pushed") {
        return result;
      }
      void askRebasePushed(ref);
      return { ok: true };
    });

  const askRebasePushed = async (ref: string): Promise<void> => {
    const message = `Rebasing ${state.head} onto ${ref} rewrites commits already on ${state.upstream}.`;
    // Not asked while another question is up (`askLogin`): the rebase's refusal is told instead.
    if (questionUp()) {
      notify("error", message);
      return;
    }
    const answer = await confirm({
      title: "Rebase",
      message,
      detail: "Pushing the branch afterwards takes a force push, which is for a terminal.",
      confirmLabel: "Rebase"
    });
    if (answer.confirmed) {
      rebaseOnto(ref, true);
    }
  };

  const askCreateTag = async (target: string): Promise<void> => {
    await prompt({
      title: "Create tag",
      detail: `The tag points at ${target}.`,
      value: { name: "", message: "" },
      confirmLabel: "Create tag",
      ready: ({ name }) => filled(name),
      render: ({ value, onChange, error, busy, field }) => (
        <>
          <TextField
            label="Name"
            value={value.name}
            onChange={(name) => onChange({ ...value, name })}
            disabled={busy}
            ref={field}
            error={error}
          />
          <TextField
            label="Message"
            value={value.message}
            placeholder="Optional"
            onChange={(message) => onChange({ ...value, message })}
            disabled={busy}
          />
        </>
      ),
      submit: ({ name, message }) =>
        branch.ask(`Creating tag ${name.trim()}...`, () =>
          repository.createTag(at, name.trim(), target, message.trim())
        )
    });
  };

  const askDeleteTag = async (name: string): Promise<void> => {
    const answer = await confirm({
      title: "Delete tag",
      message: `Are you sure you want to delete the tag ${name}?`,
      confirmLabel: "Delete tag",
      checkboxLabel: remote ? `Also delete it on ${remote}` : undefined
    });
    if (answer.confirmed) {
      // With a login, the local tag is gone already: only the remote one is tried again.
      branch.run(`Deleting tag ${name}...`, (login) =>
        login ? repository.deleteRemoteTag(at, name, login) : repository.deleteTag(at, name, answer.checked)
      );
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
      branch.run(`Dropping ${stash.ref}...`, () => repository.stash(at, "drop", stash.sha));
    }
  };

  /** Aborting a merge or rebase, first on every row: it is repository-wide and blocks all else. */
  const abortEntries = (): ContextMenuEntry[] => {
    if (!state.operation) {
      return [];
    }
    const label = state.operation === "merge" ? "Abort merge" : "Abort rebase";
    return [{ label, run: () => branch.run(`${label}...`, () => repository.abort(at)) }, SEPARATOR];
  };

  /** Brings the default branch into HEAD; every fetch moves a local default branch up to its
   *  upstream. Nothing to bring in while standing on the default branch. */
  const updateFromDefault = (): ContextMenuEntry => ({
    label: `Update from ${defaultRef ?? "the default branch"}`,
    run:
      defaultRef && !state.detached && state.head !== defaultRef
        ? () => branch.run(`Merging ${defaultRef}...`, () => repository.merge(at, defaultRef))
        : undefined
  });

  const branchEntries = (target: Extract<MenuTarget, { kind: "branch" }>): ContextMenuEntry[] => {
    const { name, remote: from } = target;
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
              run: () => branch.run(`Merging ${ref}...`, () => repository.merge(at, ref))
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

  const tagEntries = (name: string): ContextMenuEntry[] => [
    ...abortEntries(),
    { label: "Check out", run: inWorktree ? undefined : () => checkoutTag(name) },
    {
      label: remote ? `Push to ${remote}` : "Push",
      run: remote
        ? () => branch.run(`Pushing ${name}...`, (login) => repository.pushTag(at, name, login))
        : undefined
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
      run: () => branch.run(`Applying ${stash.ref}...`, () => repository.stash(at, "apply", stash.sha))
    },
    {
      label: "Pop",
      run: () => branch.run(`Popping ${stash.ref}...`, () => repository.stash(at, "pop", stash.sha))
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
    // Only one TET made is renamed or deleted here; one made elsewhere is git's to change.
    const own = worktree.key === undefined ? undefined : projectRef(projectId, worktree.key);
    const upstream = merged ? state.branchUpstreams[merged] : undefined;
    const mergedUpstream = upstream ? upstreamName(upstream) : undefined;
    return [
      ...abortEntries(),
      worktree.key === undefined
        ? { label: `Open (${NOT_MADE_BY_TET})` }
        : { label: "Open", run: worktree.current ? undefined : () => openWorktree(worktree) },
      worktree.current
        ? updateFromDefault()
        : {
            label: merged ? `Merge ${merged} into ${state.head}` : "Merge (no branch checked out)",
            run:
              merged && !state.detached
                ? () => branch.run(`Merging ${merged}...`, () => repository.merge(at, merged))
                : undefined
          },
      SEPARATOR,
      worktreeEntry(
        "Rename worktree",
        own ? undefined : NOT_MADE_BY_TET,
        own && merged ? () => void askRenameWorktree(projectId, merged, branch) : undefined
      ),
      worktreeEntry(
        "Delete worktree",
        own ? undefined : NOT_MADE_BY_TET,
        own ? () => void askDeleteWorktree(own, name, mergedUpstream, branch) : undefined
      ),
      SEPARATOR,
      { label: "Copy path", run: () => void navigator.clipboard.writeText(worktree.path) }
    ];
  };

  const menuEntries = (open: MenuTarget): ContextMenuEntry[] => {
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

  return (
    <div className={`branch-tree${branch.busy ? " busy" : ""}`}>
      <FilterField placeholder="Search branches..." value={filter} onChange={setFilter} />

      <div className="tree">
        <TreeSection
          label="LOCAL BRANCHES"
          count={ownBranches.length}
          collapsed={isCollapsed("local")}
          onToggle={() => toggle("local")}
          rows={() =>
            localBranches.map((localBranch) => {
              const status = track(localBranch);
              return (
                <button
                  key={localBranch}
                  className={`tree-item${isCurrent(localBranch) ? " current" : ""}`}
                  title="Double-click to check out"
                  onDoubleClick={() => checkout({ name: localBranch })}
                  onContextMenu={(event) => menu.open(event, { kind: "branch", name: localBranch })}
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
        />

        <TreeSection
          label="WORKTREES"
          count={linkedWorktrees.length}
          collapsed={isCollapsed("worktrees")}
          onToggle={() => toggle("worktrees")}
          rows={() =>
            worktrees.map((worktree) => (
              <button
                key={worktree.path}
                className={`tree-item${worktree.current ? " current" : ""}`}
                title={`${worktree.path}${worktree.key === undefined ? `\nA worktree ${NOT_MADE_BY_TET}` : worktree.current ? "" : "\nDouble-click to open"}`}
                onDoubleClick={() => !worktree.current && worktree.key !== undefined && openWorktree(worktree)}
                onContextMenu={(event) => menu.open(event, { kind: "worktree", worktree })}
              >
                <WorktreeIcon className="tree-icon" />
                <span className="tree-label">{worktreeName(worktree)}</span>
                {(worktree.branch === undefined || worktree.base) && (
                  <span className="tree-extra">{worktree.branch === undefined ? "detached" : worktree.base}</span>
                )}
              </button>
            ))}
        />

        <TreeSection
          label="REMOTES"
          count={state.remotes.length}
          collapsed={isCollapsed("remotes")}
          onToggle={() => toggle("remotes")}
          rows={() =>
            remotes.map((entry) => (
              <div key={entry.name}>
                <button className="tree-item remote" onClick={() => toggle(`remote:${entry.name}`)}>
                  <ChevronIcon expanded={!isCollapsed(`remote:${entry.name}`)} className="tree-icon" scale={TREE_CHEVRON} />
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
                        menu.open(event, { kind: "branch", name: remoteBranch, remote: entry.name })
                      }
                    >
                      <BranchIcon className="tree-icon" />
                      <span className="tree-label">{remoteBranch}</span>
                    </button>
                  ))}
              </div>
            ))}
        />

        <TreeSection
          label="TAGS"
          count={state.tags.length}
          collapsed={isCollapsed("tags")}
          onToggle={() => toggle("tags")}
          rows={() =>
            tags.map((tag) => (
              <button
                key={tag}
                className="tree-item"
                title="Double-click to check out"
                onDoubleClick={() => checkoutTag(tag)}
                onContextMenu={(event) => menu.open(event, { kind: "tag", name: tag })}
              >
                <TagIcon className="tree-icon" />
                <span className="tree-label">{tag}</span>
              </button>
            ))}
        />

        <TreeSection
          label="STASHES"
          count={state.stashes.length}
          collapsed={isCollapsed("stashes")}
          onToggle={() => toggle("stashes")}
          rows={() =>
            state.stashes.map((stash) => (
              <button
                key={stash.ref}
                className="tree-item"
                // No double-click: apply and drop sit one right-click apart, and a drop is final.
                title={`${stash.ref}: ${stash.message}\nRight-click to apply, pop or drop it`}
                onContextMenu={(event) => menu.open(event, { kind: "stash", stash })}
              >
                <StashIcon className="tree-icon" />
                <span className="tree-label">{stash.message}</span>
              </button>
            ))}
        />
      </div>

      {menu.render(menuEntries)}
    </div>
  );
});
