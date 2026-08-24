import { memo, useMemo, useState } from "react";
import type { CheckoutTarget, GitActionResult, RepositoryState, StashEntry } from "../../shared/types";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt } from "../ui/Dialog";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, ChevronIcon, RemoteIcon, SearchIcon, StashIcon, TagIcon } from "../ui/icons";

/**
 * How the tree starts a git command: one at a time per project, named while it runs. The
 * questions a command needs answering first are put here rather than by the caller — this is
 * what knows which remote holds a branch and whether it is the one HEAD is on.
 */
export interface BranchActions {
  /** A git command is running in this project; the tree offers no second one meanwhile. */
  busy: boolean;
  run: (label: string, action: () => Promise<GitActionResult>) => void;
}

interface BranchTreeProps {
  projectId: string;
  state: RepositoryState;
  branch: BranchActions;
}

/** Which row the menu was opened on; the pointer's position is added when it opens. */
type MenuTarget =
  | { kind: "branch"; name: string; remote?: string }
  | { kind: "tag"; name: string }
  | { kind: "stash"; stash: StashEntry };

type BranchMenu = MenuTarget & { x: number; y: number };

export const BranchTree = memo(function BranchTree({ projectId, state, branch }: BranchTreeProps) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<BranchMenu | null>(null);

  const query = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(query);

  const localBranches = useMemo(() => state.localBranches.filter(matches), [state.localBranches, query]);
  const remotes = useMemo(
    () => state.remotes.map((remote) => ({ ...remote, branches: remote.branches.filter(matches) })),
    [state.remotes, query]
  );
  // The filter is named for branches but reads as "find a ref", so tags go through it too.
  const tags = useMemo(() => state.tags.filter(matches), [state.tags, query]);

  const isCollapsed = (key: string): boolean => collapsed[key] ?? false;
  const toggle = (key: string): void => setCollapsed((current) => ({ ...current, [key]: !isCollapsed(key) }));

  const isCurrent = (name: string): boolean => !state.detached && name === state.head;

  /**
   * The checked-out branch's numbers come from `state.ahead`/`state.behind`, already read for
   * free off the status header; every other local branch's come from `state.branchTrack`, which
   * only holds one once `for-each-ref` reported it differing from its upstream at all.
   */
  const track = (name: string): { ahead: number; behind: number } | undefined =>
    isCurrent(name) ? { ahead: state.ahead, behind: state.behind } : state.branchTrack[name];

  const repository = window.tet.repository;
  /** The remote every command that names one uses, the way the main process picks it. */
  const remote = state.remotes[0]?.name;

  const checkout = (target: CheckoutTarget): void =>
    branch.run(`Switching to ${target.name}...`, () => repository.checkout(projectId, target));

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

  /**
   * Deleting is `git branch -D`, like GitHub Desktop's, so a branch whose work is not merged
   * anywhere goes too — which is what the question says. The remote copy is that question's
   * checkbox, and only where there is one to delete.
   */
  const askDeleteBranch = async (name: string): Promise<void> => {
    const onRemote = remote !== undefined && state.remotes[0].branches.includes(name);
    const answer = await confirm({
      title: "Delete branch",
      message: `Are you sure you want to delete ${name}?`,
      detail: "Commits that exist only on this branch are lost.",
      confirmLabel: "Delete branch",
      checkboxLabel: onRemote ? `Also delete ${remote}/${name} on the remote` : undefined
    });
    if (answer.confirmed) {
      branch.run(`Deleting ${name}...`, () => repository.deleteBranch(projectId, name, answer.checked));
    }
  };

  const askCreateTag = async (target: string): Promise<void> => {
    const answer = await prompt({
      title: "Create tag",
      label: "Name",
      detail: `The tag points at ${target}. A message makes it an annotated tag.`,
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
      branch.run(`Dropping ${stash.ref}...`, () => repository.stash(projectId, "drop", stash.ref));
    }
  };

  /**
   * The half-finished merge or rebase, offered from every row because it belongs to the
   * repository rather than to any one branch. Nothing else in the tree is worth doing while
   * one is open, so it goes first.
   */
  const abortEntries = (): ContextMenuEntry[] => {
    if (!state.operation) {
      return [];
    }
    const label = state.operation === "merge" ? "Abort merge" : "Abort rebase";
    return [{ label, run: () => branch.run(`${label}...`, () => repository.abort(projectId)) }, SEPARATOR];
  };

  /**
   * What can be done with a branch, following GitHub Desktop: check it out, base something new
   * on it, bring it into the branch you are on. Rewriting history in more than these two ways
   * stays a job for a terminal.
   */
  const branchEntries = (menu: Extract<BranchMenu, { kind: "branch" }>): ContextMenuEntry[] => {
    const { name, remote: from } = menu;
    // A remote branch is named by its remote everywhere but in the checkout, which creates the
    // local branch that tracks it.
    const ref = from ? `${from}/${name}` : name;
    const current = from === undefined && isCurrent(name);
    const onHead = current || state.detached;
    // The default branch as the remote has it: an auto-fetch keeps that one current, while a
    // local copy of it may be many commits behind without anything saying so.
    const updateRef = state.defaultBranch
      ? `${remote ? `${remote}/` : ""}${state.defaultBranch}`
      : undefined;

    return [
      ...abortEntries(),
      { label: "Check out", run: current ? undefined : () => checkout({ name, remote: from }) },
      { label: `Create branch from ${ref}...`, run: () => void askCreateBranch(ref) },
      ...(from
        ? []
        : [
            { label: "Rename...", run: () => void askRenameBranch(name) },
            { label: "Delete...", run: current ? undefined : () => void askDeleteBranch(name) }
          ]),
      SEPARATOR,
      // On the branch you are on, merging it into itself is meaningless — what that row
      // offers instead is bringing the default branch in, GitHub Desktop's "Update from main".
      ...(onHead
        ? [
            {
              label: `Update from ${updateRef ?? "the default branch"}`,
              // Nothing to bring in when the default branch is the one you are standing on.
              run:
                updateRef && !state.detached && state.head !== state.defaultBranch
                  ? () => branch.run(`Merging ${updateRef}...`, () => repository.merge(projectId, updateRef))
                  : undefined
            }
          ]
        : [
            {
              label: `Merge ${ref} into ${state.head}`,
              run: () => branch.run(`Merging ${ref}...`, () => repository.merge(projectId, ref))
            },
            {
              label: `Rebase ${state.head} onto ${ref}`,
              run: () => branch.run(`Rebasing onto ${ref}...`, () => repository.rebase(projectId, ref))
            }
          ]),
      SEPARATOR,
      { label: "Create tag...", run: () => void askCreateTag(ref) },
      { label: "Copy branch name", run: () => void navigator.clipboard.writeText(ref) }
    ];
  };

  /** A tag names a commit, so checking one out leaves HEAD detached — as it does in git. */
  const tagEntries = (name: string): ContextMenuEntry[] => [
    ...abortEntries(),
    { label: "Check out", run: () => branch.run(`Switching to ${name}...`, () => repository.checkoutTag(projectId, name)) },
    {
      label: remote ? `Push to ${remote}` : "Push",
      run: remote ? () => branch.run(`Pushing ${name}...`, () => repository.pushTag(projectId, name)) : undefined
    },
    { label: "Delete...", run: () => void askDeleteTag(name) },
    SEPARATOR,
    { label: "Copy tag name", run: () => void navigator.clipboard.writeText(name) }
  ];

  /**
   * A stash's ref is its position in the list, and dropping one renumbers the rest — so these
   * only ever act on what the last refresh reported, and every one of them refreshes after.
   */
  const stashEntries = (stash: StashEntry): ContextMenuEntry[] => [
    ...abortEntries(),
    {
      label: "Apply",
      run: () => branch.run(`Applying ${stash.ref}...`, () => repository.stash(projectId, "apply", stash.ref))
    },
    {
      label: "Pop",
      run: () => branch.run(`Popping ${stash.ref}...`, () => repository.stash(projectId, "pop", stash.ref))
    },
    { label: "Drop...", run: () => void askDropStash(stash) }
  ];

  const menuEntries = (open: BranchMenu): ContextMenuEntry[] => {
    if (open.kind === "branch") {
      return branchEntries(open);
    }
    return open.kind === "tag" ? tagEntries(open.name) : stashEntries(open.stash);
  };

  /** Every row opens its menu the same way; what differs is which one it describes. */
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
            <ChevronIcon expanded={!isCollapsed("local")} />
            <span>LOCAL BRANCHES</span>
            <span className="count-badge">({state.localBranches.length})</span>
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
          <button className="tree-header" onClick={() => toggle("remotes")}>
            <ChevronIcon expanded={!isCollapsed("remotes")} />
            <span>REMOTES</span>
            <span className="count-badge">({state.remotes.length})</span>
          </button>
          {!isCollapsed("remotes") &&
            remotes.map((entry) => (
              <div key={entry.name}>
                <button className="tree-item remote" onClick={() => toggle(`remote:${entry.name}`)}>
                  <ChevronIcon expanded={!isCollapsed(`remote:${entry.name}`)} />
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
            <ChevronIcon expanded={!isCollapsed("tags")} />
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
            <ChevronIcon expanded={!isCollapsed("stashes")} />
            <span>STASHES</span>
            <span className="count-badge">({state.stashes.length})</span>
          </button>
          {!isCollapsed("stashes") &&
            state.stashes.map((stash) => (
              <button
                key={stash.ref}
                className="tree-item"
                // Nothing a stash does is worth a click of its own: applying it and dropping
                // it are one right-click apart and one of them cannot be taken back.
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
