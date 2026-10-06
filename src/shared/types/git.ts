/** A username and password (or token) typed into TET for a git host. */
export interface GitLogin {
  username: string;
  password: string;
}

export interface RemoteInfo {
  name: string;
  /** Branch names without the remote prefix, e.g. "development". */
  branches: string[];
  /** Those merged into the default branch (`RepositoryState.mergedBranches`). */
  mergedBranches: string[];
  /** e.g. "git@github.com:owner/repo.git"; read when the project opens, not on every refresh. */
  url?: string;
}

export type StashCommand = "apply" | "pop" | "drop";

export interface StashEntry {
  /** e.g. "stash@{0}". Not stable: dropping one renumbers the rest. */
  ref: string;
  /** The stash's commit, which the commands take: it stays put while the refs renumber. */
  sha: string;
  /** git's line, e.g. "WIP on main: 1a2b3c the last commit's subject". */
  message: string;
}

/** A merge or rebase stopped half-way, which the UI offers to abort. */
export type GitOperation = "merge" | "rebase";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface FileChange {
  /** Repository-relative path, forward slashes. */
  path: string;
  status: ChangeStatus;
  /** Previous path, set for renames. */
  origPath?: string;
}

/** A ref standing at a commit of the GRAPH. */
export interface GraphRef {
  /** Without `refs/heads/`, `refs/remotes/` or `refs/tags/`. */
  name: string;
  kind: "local" | "remote" | "tag";
}

export interface GraphCommit {
  sha: string;
  /** First parent first; empty for a root commit. */
  parents: string[];
  subject: string;
  author: string;
  /** Unix seconds. */
  date: number;
  refs: GraphRef[];
  /** HEAD itself, detached or not. */
  head?: true;
}

/** What the GRAPH searches for: `text` in one `field`, as a fixed string, case ignored. */
export interface CommitSearch {
  text: string;
  field: "message" | "author" | "path";
}

export interface RepositoryState {
  /** Branch name, or the short commit id while HEAD is detached. */
  head: string;
  detached: boolean;
  /** The branch's commit; absent while detached (`head` is the id then) or unborn. Tells a pull or
   *  reset apart from the branch standing still. */
  headCommit?: string;
  /** e.g. "origin/main"; absent without one. */
  upstream?: string;
  /** Relative to the upstream; both 0 without one. */
  ahead: number;
  behind: number;
  localBranches: string[];
  /** Ahead/behind of non-current branches, only where `%(upstream:trackshort)` says they differ —
   *  each count costs a `rev-list`. The current branch's are `ahead`/`behind`. */
  branchTrack: Record<string, { ahead: number; behind: number }>;
  /** Each local branch's upstream on a remote — what a push goes to and "Also delete on the
   *  remote" deletes. Absent without one. */
  branchUpstreams: Record<string, BranchUpstream>;
  /** The repository's worktrees, main first (git.ts's readWorktrees). A branch checked out in
   *  another one is shown there on a checkout, as in GitHub Desktop: git refuses it here. */
  worktrees: WorktreeInfo[];
  remotes: RemoteInfo[];
  /** What "Update from" merges and a deleted current branch gives way to, found as GitHub Desktop
   *  finds it: the local branch tracking the remote's HEAD branch, else the local branch of that
   *  name, else the remote branch. */
  defaultBranch?: CheckoutTarget;
  /** The local branches whose commit the default branch contains, but the default branch and the
   *  remote branches standing for it; a remote's are its `RemoteInfo.mergedBranches`. */
  mergedBranches: string[];
  /** In `for-each-ref` order. */
  tags: string[];
  stashes: StashEntry[];
  changes: FileChange[];
  operation?: GitOperation;
  /** git could not run or the folder is no repository; the rest is then empty. */
  error?: string;
}

/** One worktree of a repository, read off its git directory. */
export interface WorktreeInfo {
  /** In on-disk spelling, as a project's path. */
  path: string;
  /** Its checked-out branch; absent while detached. */
  branch?: string;
  /** The branch a linked worktree's branch was made from, as TET records it (`branch.<name>.base`
   *  in the repository's config, git.ts's worktreeAdd); absent for one made elsewhere. Laid over
   *  the read by `Repository.emit`, with the remote urls, not read per refresh. */
  base?: string;
  /** The one holding the repository's `.git`, which is never renamed or deleted. */
  isRepository: boolean;
  /** TET's key for a worktree it made (project-dirs.ts's worktreeKeyOf); absent for the repository
   *  and for one made elsewhere. Laid over the read by `Repository.emit`, like `base`. */
  key?: string;
  /** The worktree this state was read in. */
  current: boolean;
}

/** Nothing read yet. Never mutated, only spread from. */
export const EMPTY_REPOSITORY_STATE: RepositoryState = {
  head: "",
  detached: false,
  ahead: 0,
  behind: 0,
  localBranches: [],
  mergedBranches: [],
  branchTrack: {},
  branchUpstreams: {},
  worktrees: [],
  remotes: [],
  tags: [],
  stashes: [],
  changes: [],
};

export interface GitActionResult {
  ok: boolean;
  error?: string;
  /** git wanted credentials; set only by network commands (git.ts's runNetwork). */
  authRequired?: boolean;
  /** The http(s) remote that wants a login, set by main from `authRequired`: the view that
   *  offered the action asks for one and runs it again with it. Never for an ssh remote or a local
   *  path, where there is nothing to type. */
  loginUrl?: string;
  /**
   * Nothing was done: the command waits on a question. Which one is the reason named here, and
   * the view that offered the action puts it in its own words and runs the action again
   * confirmed (AGENTS.md: main asks nothing). One field, so a new question is a new reason and
   * not another flag every other caller has to ignore.
   *
   * - `trash-failed`: a discard could not move a file to the trash; nothing was reset. Confirmed,
   *   it deletes.
   * - `rewrites-pushed`: a rebase would rewrite commits already on the upstream.
   * - `uncommitted`: a worktree has changes, so neither it nor its terminals were touched.
   */
  needsConfirmation?: "trash-failed" | "rewrites-pushed" | "uncommitted";
}

/** A local branch, or a remote-tracking one like "origin/development". */
export interface CheckoutTarget {
  name: string;
  remote?: string;
}

/** Why a worktree cannot be created with an older git (worktreesSupported). */
export const WORKTREES_NEED_GIT = "needs git 2.48 or newer";

/**
 * Whether `git --version`'s answer has `worktree add --relative-paths`, which TET's worktrees are
 * made with (git.ts's worktreeAdd). Renaming (the branch alone) and deleting need nothing new.
 */
export function worktreesSupported(version: string | undefined): boolean {
  const [major = 0, minor = 0] = (version ?? "").split(".").map((part) => parseInt(part, 10) || 0);
  return major > 2 || (major === 2 && minor >= 48);
}

/**
 * Where a new worktree's branch starts: the default branch, else — a repository with no remote HEAD
 * and no local branch named as `init.defaultBranch` has none — what the repository has checked
 * out. Undefined only while that is detached or unborn.
 */
export function worktreeBase(state: RepositoryState): CheckoutTarget | undefined {
  if (state.defaultBranch) {
    return state.defaultBranch;
  }
  const head = state.worktrees.find((worktree) => worktree.isRepository)?.branch;
  return head === undefined ? undefined : { name: head };
}

/** The remote a command uses where no branch names one (tags, publishing a branch): the first,
 *  which `Repository.emit` makes "origin" where there is one. */
export function defaultRemote(state: RepositoryState): string | undefined {
  return state.remotes[0]?.name;
}

/** The remote a fetch, pull or push of the checked-out branch reaches: its upstream's, else
 *  `defaultRemote`. */
export function headRemote(state: RepositoryState): string | undefined {
  return state.branchUpstreams[state.head]?.remote ?? defaultRemote(state);
}

/** `headRemote`, and whether fetch, pull and push can go: not without a remote, nor from a
 *  detached HEAD. */
export function syncRemote(state: RepositoryState): { remote: string | undefined; canSync: boolean } {
  const remote = headRemote(state);
  return { remote, canSync: remote !== undefined && !state.detached };
}

/** The ref git and the UI name a target by: `remote/name` for a remote branch. */
export function refName(target: CheckoutTarget): string {
  return target.remote ? `${target.remote}/${target.name}` : target.name;
}

/** A local branch's upstream on a remote, e.g. `{ remote: "origin", branch: "main" }`. */
export interface BranchUpstream {
  remote: string;
  branch: string;
}

/** The upstream as git names it and a message shows it: "origin/main". */
export function upstreamName(upstream: BranchUpstream): string {
  return refName({ name: upstream.branch, remote: upstream.remote });
}
