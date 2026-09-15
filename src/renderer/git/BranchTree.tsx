import { memo, useMemo, useState } from "react";
import type { CheckoutTarget, GitActionResult, RepositoryState, StashEntry } from "../../shared/types";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt } from "../ui/Dialog";
import { useCollapsedSections } from "../ui/Sash";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, ChevronIcon, RemoteIcon, SearchIcon, StashIcon, TagIcon } from "../ui/icons";

/** One git command at a time per project, labelled while it runs. The tree asks its questions
 *  itself, knowing which remote holds a branch and where HEAD is. */
export interface BranchActions {
  /** A command runs in this project; no second one is offered. */
  busy: boolean;
  run: (label: string, action: () => Promise<GitActionResult>) => void;
}

interface BranchTreeProps {
  projectId: string;
  state: RepositoryState;
  branch: BranchActions;
}

/** The row the menu was opened on. */
type MenuTarget =
  | { kind: "branch"; name: string; remote?: string }
  | { kind: "tag"; name: string }
  | { kind: "stash"; stash: StashEntry };

type BranchMenu = MenuTarget & { x: number; y: number };

export const BranchTree = memo(function BranchTree({ projectId, state, branch }: BranchTreeProps) {
  const [filter, setFilter] = useState("");
  // Only local branches start open, as in GitHub Desktop; folds persist.
  const [isCollapsed, toggle] = useCollapsedSections("branch-tree.sections", ["remotes", "tags", "stashes"]);
  const [menu, setMenu] = useState<BranchMenu | null>(null);

  const query = filter.trim().toLowerCase();
  const matches = (name: string): boolean => name.toLowerCase().includes(query);

  const localBranches = useMemo(() => state.localBranches.filter(matches), [state.localBranches, query]);
  const remotes = useMemo(
    () => state.remotes.map((remote) => ({ ...remote, branches: remote.branches.filter(matches) })),
    [state.remotes, query]
  );
  // The filter reads as "find a ref", so it covers tags too.
  const tags = useMemo(() => state.tags.filter(matches), [state.tags, query]);

  const isCurrent = (name: string): boolean => !state.detached && name === state.head;

  /** The current branch's from the status header; others' from `state.branchTrack`, which holds
   *  only branches differing from their upstream. */
  const track = (name: string): { ahead: number; behind: number } | undefined =>
    isCurrent(name) ? { ahead: state.ahead, behind: state.behind } : state.branchTrack[name];

  const repository = window.tet.repository;
  /** The remote commands use, picked as the main process does. */
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

  /** `git branch -D`: unmerged work goes too, as the question says. The remote copy is a checkbox
   *  where one exists. */
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

  /** Aborting a merge or rebase, first on every row: it is repository-wide and blocks all else. */
  const abortEntries = (): ContextMenuEntry[] => {
    if (!state.operation) {
      return [];
    }
    const label = state.operation === "merge" ? "Abort merge" : "Abort rebase";
    return [{ label, run: () => branch.run(`${label}...`, () => repository.abort(projectId)) }, SEPARATOR];
  };

  const branchEntries = (menu: Extract<BranchMenu, { kind: "branch" }>): ContextMenuEntry[] => {
    const { name, remote: from } = menu;
    // Prefixed by its remote everywhere but the checkout, which creates the tracking branch.
    const ref = from ? `${from}/${name}` : name;
    const current = from === undefined && isCurrent(name);
    const onHead = current || state.detached;
    // The remote's default branch: auto-fetch keeps it current, a local copy may silently lag.
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
      // On HEAD's row: bring the default branch in instead.
      ...(onHead
        ? [
            {
              label: `Update from ${updateRef ?? "the default branch"}`,
              // Nothing to bring in while standing on the default branch.
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

  /** Checking out a tag leaves HEAD detached, as in git. */
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

  /** A stash ref is a position that a drop renumbers: these act on the last refresh's report, and
   *  each refreshes after. */
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
