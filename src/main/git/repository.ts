import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import { errorMessage, failure } from "../../shared/errors";
import { EMPTY_REPOSITORY_STATE, defaultRemote, headRemote } from "../../shared/types";
import type {
  CheckoutTarget,
  ExplorerListing,
  ExplorerSettings,
  FileChange,
  FileContent,
  FileSearchQuery,
  FileSearchResult,
  FileWriteResult,
  GitActionResult,
  GitLogin,
  HeadBlob,
  NoticeSeverity,
  Project,
  RepositoryState,
  StashCommand
} from "../../shared/types";
import { addExclude, addFolder, configRoot, isWorktree, PROJECT_FILE, readExplorerView, removeFolder, setExplorerSetting } from "../tet-json";
import { countActivity, logSlow } from "../event-loop-monitor";
import { listExplorer, MAX_EDIT_BYTES, searchFiles } from "./explorer";
import { git } from "./git-client";
import type { GitLoginStore } from "../git-logins";
import { readLinkedGitDir } from "./linked-git-dir";
import { watchedDirectoryGone } from "../watch-dir";
import { relativeInside } from "../path-inside";
import type { DiscardTargets, NetworkLogin } from "./git";
import { isImage, toDataUrl } from "./image-type";

/** Filesystem events arrive in bursts (a build, a checkout, an agent editing files). */
const REFRESH_DEBOUNCE_MS = 250;
/** Least time between two finished refreshes, or continuous change runs them back to back. Measured
 *  with instrumented process creation: the git start is the cost, three per refresh (git.ts's
 *  `readState`). */
const REFRESH_MIN_INTERVAL_MS = 2000;
/** More often than GitHub Desktop's hourly fetch, which it runs for GitHub repositories only: "Update
 *  from" merges what the last fetch brought, whatever the host. */
const AUTO_FETCH_INTERVAL_MS = 10 * 60_000;
/** How long the periodic fetch may hold back a click (runAction waits for it). Well past the minute
 *  git and ssh give a silent connection (git.ts's NETWORK_ENV): this catches a credential helper
 *  waiting on its own. */
const AUTO_FETCH_TIMEOUT_MS = 2 * 60_000;

/** Delay before a failed watcher is put back, doubling up to the max: a filesystem that can't watch
 *  recursively (a network share) fails every time, and a fixed one-second retry is a busy loop. */
const WATCH_RETRY_MS = 1000;
const WATCH_RETRY_MAX_MS = 60_000;
/** Paths that change constantly without affecting the UI; otherwise every object git writes costs a
 *  `git status`. Not the place for status's own index write: `--no-optional-locks` (readStatus). */
function isIgnoredEvent(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    // git's own locks; a lockfile in the tree (yarn.lock, Cargo.lock) is a change like any other.
    (normalized.startsWith(".git/") && normalized.endsWith(".lock")) ||
    normalized.startsWith(".git/objects/") ||
    normalized.startsWith(".git/logs/") ||
    // Bookkeeping git rewrites on nearly every command, invisible in status and branches. Not
    // `.git/index`: the status letters would go stale.
    /^\.git\/(COMMIT_EDITMSG|ORIG_HEAD|FETCH_HEAD|MERGE_MSG|rebase-)/.test(normalized) ||
    normalized.includes("node_modules/")
  );
}

/** What every path check answers for a path that escapes the repository root. */
const OUTSIDE_REPOSITORY = { ok: false, error: "Path is outside the repository" } as const;

/**
 * A filesystem action as a `GitActionResult`: whatever it threw becomes the failure's message, in
 * the words the OS used. For the Explorer's own edits, which run off `runAction` — they take no
 * index lock (Repository.listExplorer).
 */
function attempt(action: () => Promise<unknown>): Promise<GitActionResult> {
  return action().then(() => ({ ok: true }), failure);
}

/** Whether two paths name one entry, e.g. differing in case on a case-insensitive filesystem. By
 *  file id, as bigints: a win32 file id overflows a number. */
function sameEntry(a: string, b: string): boolean {
  try {
    const [first, second] = [fs.statSync(a, { bigint: true }), fs.statSync(b, { bigint: true })];
    return first.ino === second.ino && first.dev === second.dev;
  } catch {
    return false;
  }
}

/** One repository's state, the single source of truth for the git views and the terminals.
 *  Refreshed after filesystem changes, so a branch switched in a terminal shows up. */
export class Repository {
  private state: RepositoryState = EMPTY_REPOSITORY_STATE;
  /** `state` serialized, so a refresh serializes only its own side to compare. */
  private stateJson = JSON.stringify(EMPTY_REPOSITORY_STATE);
  private watcher: fs.FSWatcher | undefined;
  /** A linked worktree's or submodule's git directory — see watchLinkedGitDir. */
  private gitDirWatcher: fs.FSWatcher | undefined;
  private watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchRetryDelay = WATCH_RETRY_MS;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce for tet.json, the one watched file that is not git state. */
  private commandsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce for a path appearing or disappearing. */
  private filesTimer: ReturnType<typeof setTimeout> | undefined;
  /** The files the project's editor tabs show, repository-relative with "/" — see watchFiles. */
  private watchedFiles = new Set<string>();
  /** Debounce for a write, per file: one timer would swallow a second file's write. */
  private readonly watchedFileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight: Promise<RepositoryState> | undefined;
  private refreshPending = false;
  private lastRefreshAt = 0;
  private actionRunning = false;
  /** Set within `exclusive`'s steps, whose own calls to this repository's commands run in its hold. */
  private readonly holding = new AsyncLocalStorage<true>();
  /** The action underway (runAction), for `dispose` to wait on. */
  private action: Promise<GitActionResult> | undefined;
  /** `start`'s reads, for `dispose` to wait on. */
  private starting: Promise<void> | undefined;
  private autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  /** The periodic fetch underway; an action waits for it rather than being refused. */
  private autoFetching: Promise<void> | undefined;
  /** Each remote's url, read on open and after `.git/config` changes — not on every refresh, which
   *  pays per git process for a url that almost never changes. */
  private remoteUrls: Record<string, string> = {};
  /** `init.defaultBranch`, or "main": the default branch where no remote names one (GitHub Desktop's
   *  fallback). Read with the urls, on open and after `.git/config` changes. */
  private defaultBranchName = "main";
  /** Each worktree branch's `branch.<name>.base`, read with the urls and for the same reason: it is
   *  written once, when the worktree is made, and read on every refresh. */
  private worktreeBases: Record<string, string> = {};
  private configStale = false;
  /** Bumped by every `searchFiles`: the readers of one overtaken stop where they are. */
  private searchSeq = 0;
  /** Checked once on open; if false, nothing is read or watched. */
  private isGit = false;
  /** The project was closed; anything still in flight doesn't report. */
  private disposed = false;

  constructor(
    readonly project: Project,
    private readonly onState: (state: RepositoryState) => void,
    private readonly onNotice: (severity: NoticeSeverity, message: string) => void,
    /** tet.json changed — an editor, an agent or a checkout may rewrite it. */
    private readonly onCommandsChanged: () => void,
    /** A path was created, deleted or renamed — for the Explorer, which also lists ignored files no
     *  refresh reports. */
    private readonly onFilesChanged: () => void,
    /** A `watchFiles` file was written — an edit to an already "modified" file changes nothing a
     *  refresh reports, so the editor tab would go stale. */
    private readonly onFileChanged: (filePath: string) => void,
    /** The logins for the remotes, typed or kept (`network`). */
    private readonly logins: GitLoginStore
  ) {}

  /** The files the project's editor tabs show. A pending report for a file just closed is
   *  harmless: nothing shows it any more. */
  watchFiles(paths: string[]): void {
    this.watchedFiles = new Set(paths.map((filePath) => filePath.replace(/\\/g, "/")));
  }

  /** Reports a read error, named by project, only when it changed — not again on every refresh. */
  private reportError(next: RepositoryState): void {
    if (next.error && next.error !== this.state.error) {
      this.onNotice("error", `${this.project.name}: ${next.error}`);
    }
  }

  getState(): RepositoryState {
    return this.state;
  }

  start(): Promise<void> {
    this.starting = this.startReading();
    return this.starting;
  }

  private async startReading(): Promise<void> {
    // All three at once: each is a git start (the measured cost); in sequence they visibly delay
    // the pane.
    const [isGit, , read] = await Promise.all([
      git.isRepository(this.project.path).catch(() => false),
      this.loadConfig(),
      this.read()
    ]);
    this.isGit = isGit;
    if (!this.isGit) {
      this.emit({ ...EMPTY_REPOSITORY_STATE, error: "Not a git repository" });
      return;
    }
    // The first read ran without the remote names; only a name holding a "/" changes it.
    this.emit(Object.keys(this.remoteUrls).some((name) => name.includes("/")) ? await this.read() : read);
    // Closed during the first read: a watcher started now would never be closed.
    if (this.disposed) {
      return;
    }
    this.startWatching();
    this.autoFetchTimer = setInterval(() => void this.autoFetch(), AUTO_FETCH_INTERVAL_MS);
  }

  /** Everything read out of the repository's config rather than per refresh. */
  private async loadConfig(): Promise<void> {
    this.configStale = false;
    const [urls, branchConfig] = await Promise.all([
      git.readRemoteUrls(this.project.path).catch(() => ({})),
      git.readBranchConfig(this.project.path).catch(() => ({ defaultBranchName: "main", worktreeBases: {} }))
    ]);
    this.remoteUrls = urls;
    this.defaultBranchName = branchConfig.defaultBranchName;
    this.worktreeBases = branchConfig.worktreeBases;
  }

  /** The periodic fetch. Silent on failure, or an offline machine gets a notice every ten minutes.
   *  It doesn't take the action slot — a click during it waits. */
  private async autoFetch(): Promise<void> {
    if (this.actionRunning || this.autoFetching || this.state.remotes.length === 0) {
      return;
    }
    // With a kept login, never a typed one: nothing is asked in the background.
    const remote = this.headRemote;
    this.autoFetching = this.network(remote, undefined, (login) =>
      git.fetch(this.project.path, remote, login, AUTO_FETCH_TIMEOUT_MS)
    )
      .then(() => git.fastForwardBranches(this.project.path))
      .catch(() => undefined)
      .then(() => this.refresh())
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.autoFetching = undefined;
      });
    await this.autoFetching;
  }

  private read(): Promise<RepositoryState> {
    // readState reports errors in its result; a rejection is the git process gone.
    return git.readState(this.project.path, Object.keys(this.remoteUrls)).catch((error: unknown) => ({
      ...EMPTY_REPOSITORY_STATE,
      error: errorMessage(error)
    }));
  }

  /** Refreshes now — *after* any refresh underway, which may have read a tree still changing: a
   *  commit's `add --all` wakes the watcher while `commit` runs, reporting the staged state. */
  async refresh(): Promise<RepositoryState> {
    // Until the first read is in, `isGit` says nothing yet and a refresh would answer the empty
    // state. A failed start leaves `isGit` as it was, which the refresh below answers by.
    await this.starting?.catch(() => undefined);
    while (this.inflight) {
      await this.inflight;
    }
    // This run covers whatever the watcher was waiting for.
    this.refreshPending = false;
    return this.runRefresh();
  }

  private runRefresh(): Promise<RepositoryState> {
    if (!this.isGit || this.disposed) {
      return Promise.resolve(this.state);
    }
    countActivity("git");
    this.inflight = (async () => {
      if (this.configStale) {
        await this.loadConfig();
      }
      this.emit(await this.read());
      // What the views are given, not the bare read: `emit` lays the config over it (the remotes'
      // urls, the default branch, each worktree's base).
      return this.state;
    })().finally(() => {
      this.inflight = undefined;
      this.lastRefreshAt = Date.now();
      if (this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        // Back through the schedule: a direct rerun bypasses the debounce and chains git processes.
        this.scheduleRefresh();
      }
    });
    return this.inflight;
  }

  /** The read's state with remotes completed: each url, and a remote without remote-tracking refs
   *  (`for-each-ref` can't name it, leaving nothing to push to). `origin` first: commands use the
   *  first remote. */
  private emit(read: RepositoryState): void {
    const names = new Set([...read.remotes.map((remote) => remote.name), ...Object.keys(this.remoteUrls)]);
    const remotes = [...names]
      .sort((a, b) => Number(b === "origin") - Number(a === "origin"))
      .map((name) => ({
        name,
        branches: read.remotes.find((remote) => remote.name === name)?.branches ?? [],
        url: this.remoteUrls[name]
      }));
    const defaultBranch =
      read.defaultBranch ??
      (read.localBranches.includes(this.defaultBranchName) ? { name: this.defaultBranchName } : undefined);
    const worktrees = read.worktrees.map((worktree) => ({
      ...worktree,
      // Only a linked worktree carries a base; the main one was made with the repository.
      base: worktree.main || worktree.branch === undefined ? undefined : this.worktreeBases[worktree.branch]
    }));
    const next: RepositoryState = { ...read, remotes, defaultBranch, worktrees };
    this.reportError(next);
    // Only on an actual change: the watcher fires for edits leaving the state identical, and every
    // emit re-renders the views. Labeled "emit", not "git": this runs after git has finished.
    const stringifyStart = performance.now();
    const nextJson = JSON.stringify(next);
    countActivity("emit");
    logSlow("emit", performance.now() - stringifyStart);
    if (!this.disposed && nextJson !== this.stateJson) {
      this.state = next;
      this.stateJson = nextJson;
      this.onState(next);
    }
  }

  /** For the watcher: refreshes once events settle, at least REFRESH_MIN_INTERVAL_MS after the last
   *  one finished. A refresh underway is not joined — it reschedules when it read too early. */
  private scheduleRefresh(): void {
    clearTimeout(this.debounceTimer);
    const delay = Math.max(REFRESH_DEBOUNCE_MS, this.lastRefreshAt + REFRESH_MIN_INTERVAL_MS - Date.now());
    this.debounceTimer = setTimeout(() => {
      if (this.inflight) {
        this.refreshPending = true;
        return;
      }
      void this.runRefresh();
    }, delay);
  }

  /** One command at a time, refreshing after: two race for the index lock. Another arriving
   *  meanwhile is refused. */
  private async runAction(action: () => Promise<GitActionResult>): Promise<GitActionResult> {
    if (this.holding.getStore()) {
      // Within `exclusive`: its hold is this command's, and it refreshes once all have run.
      return action().catch(failure);
    }
    // The periodic fetch holds the lock too; a click waits for it rather than fails.
    while (this.autoFetching) {
      await this.autoFetching;
    }
    if (this.actionRunning) {
      return { ok: false, error: "A git command is already running for this repository" };
    }
    this.actionRunning = true;
    try {
      // A rejection is the git process gone; reported like any failure.
      this.action = action().catch(failure);
      const result = await this.action;
      await this.refresh();
      return result;
    } finally {
      this.actionRunning = false;
    }
  }

  /**
   * Several commands, and what happens between them, in one hold of the slot: refused up front when
   * another command runs, never halfway. projects.ts's worktree delete and rename close a project
   * midway, which must not be for nothing. This repository's commands called from `steps` run in
   * the hold; a call from anywhere else meanwhile is refused as usual.
   */
  exclusive(steps: () => Promise<GitActionResult>): Promise<GitActionResult> {
    return this.runAction(() => this.holding.run(true, steps));
  }

  checkout(target: CheckoutTarget): Promise<GitActionResult> {
    return this.runAction(() => git.checkout(this.project.path, target, this.state.localBranches));
  }

  fetch(login?: GitLogin): Promise<GitActionResult> {
    return this.runAction(async () => {
      // The remote whose login is looked up, named: git's default could be another host's.
      const remote = this.headRemote;
      const fetched = await this.network(remote, login, (networkLogin) => git.fetch(this.project.path, remote, networkLogin));
      await git.fastForwardBranches(this.project.path);
      return fetched;
    });
  }

  /** Then, as GitHub Desktop does, the remote's HEAD is asked for again and the other branches only
   *  behind their upstreams are moved up. */
  pull(login?: GitLogin): Promise<GitActionResult> {
    return this.runAction(async () => {
      const remote = this.headRemote;
      // The remote's HEAD with the same login: on a host that wants one, without it it always fails.
      const pulled = await this.network(remote, login, async (networkLogin) => {
        const result = await git.pull(this.project.path, networkLogin);
        if (result.ok && remote) {
          await git.updateRemoteHead(this.project.path, remote, networkLogin);
        }
        return result;
      });
      await git.fastForwardBranches(this.project.path);
      return pulled;
    });
  }

  /** Pushes the current branch to its upstream, or publishes it to `remote` when it has none. */
  push(login?: GitLogin): Promise<GitActionResult> {
    return this.runAction(() => {
      const upstream = this.state.branchUpstreams[this.state.head];
      const remote = headRemote(this.state);
      if (!remote) {
        return Promise.resolve({ ok: false, error: "This repository has no remote to push to" });
      }
      if (this.state.detached) {
        return Promise.resolve({ ok: false, error: "HEAD is detached — check out a branch to push it" });
      }
      return this.network(remote, login, (networkLogin) =>
        git.push(this.project.path, remote, this.state.head, upstream?.branch, networkLogin)
      );
    });
  }

  /** shared/types.ts's `defaultRemote`, as the git pane names it. */
  private get remote(): string | undefined {
    return defaultRemote(this.state);
  }

  /** shared/types.ts's `headRemote`, as the git pane names it. */
  private get headRemote(): string | undefined {
    return headRemote(this.state);
  }

  /** A command reaching `remote`, with the login typed for it or the one kept for its url
   *  (GitLoginStore.run); with no remote, or none whose url is known, the command as it is. */
  private network(
    remote: string | undefined,
    login: GitLogin | undefined,
    command: (login?: NetworkLogin) => Promise<GitActionResult>
  ): Promise<GitActionResult> {
    const url = remote === undefined ? undefined : this.remoteUrls[remote];
    return url === undefined ? command() : this.logins.run(this.project.path, url, login, command);
  }

  /** Re-reads the config after, since only this changes a url. */
  setRemoteUrl(remote: string, url: string): Promise<GitActionResult> {
    return this.runAction(async () => {
      const result = await git.setRemoteUrl(this.project.path, remote, url);
      await this.loadConfig();
      return result;
    });
  }

  createBranch(name: string, startPoint: string): Promise<GitActionResult> {
    return this.runAction(() => git.createBranch(this.project.path, name, startPoint));
  }

  /** A new branch at `base`, checked out at `target` (git.ts's worktreeAdd). Re-reads the config
   *  after: this is what records `branch.<name>.base`, and the new row shows it at once. */
  addWorktree(target: string, branch: string, base: CheckoutTarget): Promise<GitActionResult> {
    return this.runAction(async () => {
      const result = await git.worktreeAdd(this.project.path, target, branch, base);
      await this.loadConfig();
      return result;
    });
  }

  removeWorktree(target: string, force: boolean): Promise<GitActionResult> {
    return this.runAction(() => git.worktreeRemove(this.project.path, target, force));
  }

  moveWorktree(from: string, to: string): Promise<GitActionResult> {
    return this.runAction(() => git.worktreeMove(this.project.path, from, to));
  }

  pruneWorktrees(): Promise<GitActionResult> {
    return this.runAction(() => git.worktreePrune(this.project.path));
  }

  /** git moves the branch's whole config section with it, `branch.<name>.base` included, so the
   *  config is read again. */
  renameBranch(from: string, to: string): Promise<GitActionResult> {
    return this.runAction(async () => {
      const result = await git.renameBranch(this.project.path, from, to);
      await this.loadConfig();
      return result;
    });
  }

  /** Locally and, if asked, its upstream on the remote. Local first: it can't fail for reasons off the
   *  machine. The checked-out branch gives way to the default branch first, as in GitHub Desktop. */
  deleteBranch(name: string, onRemote: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      const upstream = this.state.branchUpstreams[name];
      if (!this.state.detached && name === this.state.head) {
        const fallback = this.state.defaultBranch;
        if (!fallback || (fallback.remote === undefined && fallback.name === name)) {
          return { ok: false, error: `There is no default branch to switch to before deleting ${name}` };
        }
        const switched = await git.checkout(this.project.path, fallback, this.state.localBranches);
        if (!switched.ok) {
          return switched;
        }
      }
      const local = await git.deleteBranch(this.project.path, name);
      if (!local.ok || !onRemote) {
        return local;
      }
      return upstream
        ? this.network(upstream.remote, undefined, (login) =>
            git.deleteRemoteBranch(this.project.path, upstream.remote, upstream.branch, login)
          )
        : { ok: false, error: `${name} has no upstream to delete on a remote` };
    });
  }

  /** A remote branch alone: from its row under the remote, and the second try of a `deleteBranch`
   *  whose remote half wanted a login. */
  deleteRemoteBranch(remote: string, name: string, login?: GitLogin): Promise<GitActionResult> {
    return this.runAction(() =>
      this.network(remote, login, (networkLogin) => git.deleteRemoteBranch(this.project.path, remote, name, networkLogin))
    );
  }

  merge(ref: string): Promise<GitActionResult> {
    return this.runAction(() => git.merge(this.project.path, ref));
  }

  /** Unless `confirmed`, refused with `rewrites-pushed` where it would rewrite commits the upstream
   *  has: the caller asks, since pushing them afterwards takes a force push. */
  rebase(ref: string, confirmed: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      if (!confirmed && (await git.rebaseRewritesPushed(this.project.path, ref))) {
        return { ok: false, needsConfirmation: "rewrites-pushed" };
      }
      return git.rebase(this.project.path, ref);
    });
  }

  abort(): Promise<GitActionResult> {
    return this.runAction(() => {
      const operation = this.state.operation;
      return operation
        ? git.abortOperation(this.project.path, operation)
        : Promise.resolve({ ok: false, error: "Nothing is in progress here" });
    });
  }

  createTag(name: string, target: string, message: string): Promise<GitActionResult> {
    return this.runAction(() => git.createTag(this.project.path, name, target, message));
  }

  pushTag(name: string, login?: GitLogin): Promise<GitActionResult> {
    return this.runAction(() => {
      const remote = this.remote;
      return remote
        ? this.network(remote, login, (networkLogin) => git.pushTag(this.project.path, remote, name, networkLogin))
        : Promise.resolve({ ok: false, error: "This repository has no remote to push the tag to" });
    });
  }

  deleteTag(name: string, onRemote: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      const local = await git.deleteTag(this.project.path, name);
      return !local.ok || !onRemote ? local : this.deleteTagOnRemote(name, undefined);
    });
  }

  /** The remote half alone: the second try of a `deleteTag` that wanted a login. */
  deleteRemoteTag(name: string, login?: GitLogin): Promise<GitActionResult> {
    return this.runAction(() => this.deleteTagOnRemote(name, login));
  }

  private deleteTagOnRemote(name: string, login: GitLogin | undefined): Promise<GitActionResult> {
    const remote = this.remote;
    return remote
      ? this.network(remote, login, (networkLogin) => git.deleteRemoteTag(this.project.path, remote, name, networkLogin))
      : Promise.resolve({ ok: false, error: "This repository has no remote to delete the tag from" });
  }

  checkoutTag(name: string): Promise<GitActionResult> {
    return this.runAction(() => git.checkoutTag(this.project.path, name));
  }

  /** Commits everything, untracked files included. */
  commitAll(message: string): Promise<GitActionResult> {
    return this.runAction(() => git.commitAll(this.project.path, message));
  }

  /** Commits only these files, untracked ones included. */
  commitPaths(message: string, paths: string[]): Promise<GitActionResult> {
    return this.runAction(() => {
      const changes = this.changesByPath();
      const untracked = paths.filter((filePath) => changes.get(filePath)?.status === "untracked");
      return git.commitPaths(this.project.path, message, this.pathspec(paths), untracked);
    });
  }

  /** Stashes everything, untracked files included. */
  stashPush(message: string): Promise<GitActionResult> {
    return this.runAction(() => git.stashPush(this.project.path, message));
  }

  /** These paths plus each rename's old one: a commit given only the new path takes half a rename. */
  pathspec(paths: string[]): string[] {
    const changes = this.changesByPath();
    const expanded = [...paths];
    const listed = new Set(paths);
    for (const filePath of paths) {
      const origPath = changes.get(filePath)?.origPath;
      if (origPath && !listed.has(origPath)) {
        expanded.push(origPath);
        listed.add(origPath);
      }
    }
    return expanded;
  }

  /** Each change by its path, the first where one is listed twice. */
  private changesByPath(): Map<string, FileChange> {
    const changes = new Map<string, FileChange>();
    for (const change of this.state.changes) {
      if (!changes.has(change.path)) {
        changes.set(change.path, change);
      }
    }
    return changes;
  }

  /** By the stash's commit, which a stash made meanwhile doesn't move. */
  stash(command: StashCommand, sha: string): Promise<GitActionResult> {
    return this.runAction(() => git.stash(this.project.path, command, sha));
  }

  /** Throws away changes to these files, each file on disk going to the trash first, as in GitHub
   *  Desktop, so an edit can be had back. A merge stays in progress: a conflict is only reset to HEAD.
   *  When the trash fails, what went to it before is still reset and the rest is left
   *  (`trash-failed`); `permanently` then deletes instead. */
  discard(paths: string[], permanently: boolean): Promise<GitActionResult> {
    // Through runAction: `git restore` takes the index lock, and failing on it during a fetch or
    // checkout would leave the files already trashed.
    return this.runAction(async () => {
      const targets: DiscardTargets = { restore: [], drop: [] };
      const byPath = this.changesByPath();
      const changes = paths.flatMap((filePath) => byPath.get(filePath) ?? []);
      const unsure = changes.filter((change) => change.status === "untracked" || change.status === "conflicted");
      const inHead = new Set(
        unsure.length > 0 ? await git.readHeadPaths(this.project.path, unsure.map((change) => change.path)) : []
      );
      for (const change of changes) {
        const filePath = change.path;
        // An untracked file HEAD has was untracked by `git rm --cached`: HEAD's version comes back.
        const notInHead =
          ["untracked", "added", "renamed", "conflicted"].includes(change.status) && !inHead.has(filePath);
        // Staged, then deleted on disk, still reads "added": nothing to trash. A tracked directory is
        // a submodule, which git restores and the trash must not take; an untracked one (a
        // repository inside this one) goes whole.
        const absolute = path.join(this.project.path, filePath);
        const stat = change.status === "deleted" ? undefined : await fs.promises.lstat(absolute).catch(() => undefined);
        if (stat && (change.status === "untracked" || !stat.isDirectory())) {
          try {
            await shell.trashItem(absolute);
          } catch (error) {
            if (!permanently) {
              // Reset what the trash already took, or it would be missing until asked again.
              const reset = await git.discard(this.project.path, targets);
              const message = errorMessage(error);
              return reset.ok ? { ok: false, error: message, needsConfirmation: "trash-failed" } : reset;
            }
            // What HEAD has is written over by the restore; the rest would stay behind untracked.
            if (notInHead) {
              await fs.promises.rm(absolute, { recursive: true, force: true });
            }
          }
        }
        // Only a rename's old path is in HEAD; the new one goes like an untracked file.
        if (change.status === "renamed" && change.origPath) {
          targets.restore.push(change.origPath);
        }
        (notInHead ? targets.drop : targets.restore).push(filePath);
      }

      return git.discard(this.project.path, targets);
    });
  }

  ignore(filePath: string, scope: "file" | "extension"): Promise<GitActionResult> {
    return this.runAction(() => git.ignorePath(this.project.path, filePath, scope));
  }

  /** The Explorer's listing (explorer.ts): a filesystem walk off the index lock `runAction` holds. */
  listExplorer(): Promise<ExplorerListing> {
    return listExplorer(this.project.path);
  }

  /** The SEARCH pane's matches (explorer.ts); a search is given up once the next one is asked for. */
  searchFiles(query: FileSearchQuery): Promise<FileSearchResult> {
    const seq = ++this.searchSeq;
    return searchFiles(this.project.path, query, () => seq !== this.searchSeq);
  }

  /** A repository-relative path for a new entry, resolved, or an error if outside or taken.
   *  `renaming` is the source: on a case-insensitive filesystem `Readme.md` → `README.md` finds the
   *  source at the target, which is no conflict. */
  private async resolveNew(filePath: string, renaming?: string): Promise<{ absolute: string } | { error: string }> {
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return { error: OUTSIDE_REPOSITORY.error };
    }
    if (fs.existsSync(absolute) && !(renaming && sameEntry(absolute, renaming))) {
      return { error: `A file or folder "${filePath}" already exists at this location` };
    }
    return { absolute };
  }

  /** The Explorer's "New File...", creating parent directories. */
  async createFile(filePath: string): Promise<GitActionResult> {
    const target = await this.resolveNew(filePath);
    if ("error" in target) {
      return { ok: false, error: target.error };
    }
    return attempt(async () => {
      await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
      await fs.promises.writeFile(target.absolute, "", { flag: "wx" });
    });
  }

  /** The Explorer's "New Folder...". */
  async createDirectory(dirPath: string): Promise<GitActionResult> {
    const target = await this.resolveNew(dirPath);
    if ("error" in target) {
      return { ok: false, error: target.error };
    }
    return attempt(() => fs.promises.mkdir(target.absolute, { recursive: true }));
  }

  /** The Explorer's "Delete...": to the trash, like `discard`. */
  async deletePath(filePath: string): Promise<GitActionResult> {
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return OUTSIDE_REPOSITORY;
    }
    return attempt(() => shell.trashItem(absolute));
  }

  /** The Explorer's "Rename...", which may also move. */
  async renamePath(fromPath: string, toPath: string): Promise<GitActionResult> {
    const from = this.resolveInside(fromPath);
    if (!from) {
      return OUTSIDE_REPOSITORY;
    }
    const to = await this.resolveNew(toPath, from);
    if ("error" in to) {
      return { ok: false, error: to.error };
    }
    return attempt(async () => {
      await fs.promises.mkdir(path.dirname(to.absolute), { recursive: true });
      await fs.promises.rename(from, to.absolute);
    });
  }

  /** The Explorer's tet.json edits ("Add Folder to Workspace", "Remove Folder from Workspace",
   *  "Exclude from Files"); the watcher sees the write and re-lists. */
  addFolder(folderPath: string): Promise<GitActionResult> {
    return attempt(() => addFolder(this.project.path, folderPath));
  }

  removeFolder(folderPath: string): Promise<GitActionResult> {
    return attempt(() => removeFolder(this.project.path, folderPath));
  }

  excludePath(relPath: string): Promise<GitActionResult> {
    return attempt(() => addExclude(this.project.path, relPath));
  }

  /** For the settings dialog's Files tab; folders and exclude globs stay the tree's own. */
  async readExplorerSettings(): Promise<ExplorerSettings> {
    const { excludeGitIgnore, compactFolders, sortOrder } = await readExplorerView(this.project.path);
    return { excludeGitIgnore, compactFolders, sortOrder };
  }

  setExplorerSetting<K extends keyof ExplorerSettings>(key: K, value: ExplorerSettings[K]): Promise<GitActionResult> {
    return attempt(() => setExplorerSetting(this.project.path, key, value));
  }

  /** The absolute path, or undefined if it escapes the root. */
  private resolveInside(filePath: string): string | undefined {
    const absolute = path.resolve(this.project.path, filePath);
    return relativeInside(this.project.path, absolute) === undefined ? undefined : absolute;
  }

  /** A file for the editor tab: the working tree's text, plus HEAD's (the diff's original side)
   *  only where git reports a change — an unchanged file is its own original, a plain editor. A
   *  deleted, binary or too-large file is read-only (`isReadOnly` in editor-views.ts). */
  async readFile(filePath: string): Promise<FileContent> {
    const base = { path: filePath, content: "", mtimeMs: 0, binary: false, tooLarge: false };
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return { ...base, error: OUTSIDE_REPOSITORY.error };
    }
    const change = this.state.changes.find((candidate) => candidate.path === filePath);
    try {
      const stat = await fs.promises.stat(absolute).catch(() => null);
      if (!stat) {
        // Missing: a file git reports deleted shows as all removed, anything else is an error.
        return change?.status === "deleted"
          ? { ...base, deleted: true, head: await this.headBlob(filePath, change) }
          : { ...base, error: "Not a file" };
      }
      if (!stat.isFile()) {
        return { ...base, error: "Not a file" };
      }
      if (stat.size > MAX_EDIT_BYTES) {
        return { ...base, mtimeMs: stat.mtimeMs, tooLarge: true };
      }
      const buffer = await fs.promises.readFile(absolute);
      const binary = buffer.includes(0);
      const image = isImage(filePath) ? toDataUrl(filePath, buffer) : undefined;
      return {
        ...base,
        mtimeMs: stat.mtimeMs,
        binary,
        image,
        content: binary ? "" : buffer.toString("utf8"),
        // A non-image binary has nothing to compare; don't spend a git process on it.
        head: binary && !image ? undefined : await this.headBlob(filePath, change)
      };
    } catch (error) {
      return { ...base, error: errorMessage(error) };
    }
  }

  /** The diff editor's original side for a changed file. Untracked costs no git process. A dead git
   *  process leaves the side out rather than failing the open — the file just carries no marks. */
  private headBlob(filePath: string, change: FileChange | undefined): Promise<HeadBlob | undefined> {
    if (!change) {
      return Promise.resolve(undefined);
    }
    if (change.status === "untracked") {
      return Promise.resolve({ content: "", binary: false, missing: true });
    }
    return git
      .readHeadBlob(this.project.path, filePath, { origPath: change.origPath, maxBytes: MAX_EDIT_BYTES })
      .catch(() => undefined);
  }

  /** Refuses when the mtime changed since the read, so a save never silently overwrites another
   *  edit. Written in place: the user's source file, not one other processes read, and in place
   *  keeps mode and links. */
  async writeFile(filePath: string, content: string, expectedMtimeMs: number): Promise<FileWriteResult> {
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return OUTSIDE_REPOSITORY;
    }
    try {
      const before = await fs.promises.stat(absolute);
      if (before.mtimeMs !== expectedMtimeMs) {
        return { ok: false, error: "The file changed on disk since it was opened" };
      }
      await fs.promises.writeFile(absolute, content, "utf8");
      const after = await fs.promises.stat(absolute);
      return { ok: true, mtimeMs: after.mtimeMs };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.project.path, { recursive: true }, (event, filename) => {
        const name = filename?.toString();
        if (name && isIgnoredEvent(name)) {
          return;
        }
        // The retry loop picks the directory back up when it reappears.
        if (watchedDirectoryGone(this.project.path, name)) {
          this.closeWatchers();
          this.retryWatching();
          return;
        }
        // Events arrive, so the next failure backs off from the start.
        this.watchRetryDelay = WATCH_RETRY_MS;
        if (name && /^\.git[\\/]config$/.test(name)) {
          this.configStale = true;
        }
        if (name === PROJECT_FILE) {
          // Debounced: the file is written in place, and a read mid-write finds half of it.
          clearTimeout(this.commandsTimer);
          this.commandsTimer = setTimeout(this.onCommandsChanged, REFRESH_DEBOUNCE_MS);
        }
        // A path appearing or going is "rename", a write only "change" (measured on win32), so an
        // edit never re-lists the tree. Nothing under .git is in it.
        if (event === "rename" && name && !/^\.git(?:[\\/]|$)/.test(name)) {
          clearTimeout(this.filesTimer);
          this.filesTimer = setTimeout(this.onFilesChanged, REFRESH_DEBOUNCE_MS);
        }
        // Any event: writing beside and renaming into place reports "rename", not "change". The
        // size check first: this runs for every event under the root, mostly with no file open.
        const watchedFile = this.watchedFiles.size > 0 ? name?.replace(/\\/g, "/") : undefined;
        if (watchedFile !== undefined && this.watchedFiles.has(watchedFile)) {
          clearTimeout(this.watchedFileTimers.get(watchedFile));
          this.watchedFileTimers.set(
            watchedFile,
            setTimeout(() => {
              this.watchedFileTimers.delete(watchedFile);
              this.onFileChanged(watchedFile);
            }, REFRESH_DEBOUNCE_MS)
          );
        }
        this.scheduleRefresh();
      });
      this.watcher.on("error", (error) => {
        console.error(`[tet] watcher failed for ${this.project.path}:`, error);
        this.closeWatchers();
        this.retryWatching();
      });
      this.watchLinkedGitDir();
    } catch (error) {
      // A filesystem that can't watch recursively throws here instead of emitting an error. The
      // root's watcher may already stand when the git directory's threw.
      console.error(`[tet] could not watch ${this.project.path}:`, error);
      this.closeWatchers();
      this.retryWatching();
    }
  }

  /**
   * A linked worktree's or a submodule's `.git` is a file naming the git directory elsewhere, where
   * a commit or checkout in a terminal writes HEAD, index and refs without an event under the root
   * (measured). `gitdir`, and for a worktree the `commondir` holding it, whose events are named as
   * the root's `.git/` ones.
   */
  private watchLinkedGitDir(): void {
    const linked = readLinkedGitDir(this.project.path);
    if (!linked) {
      return;
    }
    const dir = linked.commonDir ?? linked.gitDir;
    this.gitDirWatcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      const name = filename === null ? undefined : `.git/${filename.toString().replace(/\\/g, "/")}`;
      if (name && isIgnoredEvent(name)) {
        return;
      }
      if (name === ".git/config") {
        this.configStale = true;
      }
      this.scheduleRefresh();
    });
    this.gitDirWatcher.on("error", (error) => {
      console.error(`[tet] watcher failed for ${dir}:`, error);
      this.closeWatchers();
      this.retryWatching();
    });
  }

  private closeWatchers(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.gitDirWatcher?.close();
    this.gitDirWatcher = undefined;
  }

  /** Puts a failed watcher back, then refreshes to catch what changed unwatched. */
  private retryWatching(): void {
    clearTimeout(this.watchRetryTimer);
    const delay = this.watchRetryDelay;
    this.watchRetryDelay = Math.min(delay * 2, WATCH_RETRY_MAX_MS);
    this.watchRetryTimer = setTimeout(() => {
      if (this.disposed) {
        return;
      }
      this.startWatching();
      if (this.watcher) {
        void this.refresh();
      }
    }, delay);
  }

  /**
   * Resolves once the git commands this repository started have ended: a running one's working
   * directory is the folder, which Windows then keeps from being moved or removed ("Permission
   * denied", measured) — and a worktree's is, right after its project closes (projects.ts).
   */
  dispose(): Promise<void> {
    // Read by a refresh whose git call may outlive this.
    this.disposed = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.commandsTimer);
    clearTimeout(this.filesTimer);
    this.watchedFileTimers.forEach(clearTimeout);
    clearTimeout(this.watchRetryTimer);
    clearInterval(this.autoFetchTimer);
    this.closeWatchers();
    // The git process caches per-directory answers; on quit it is stopped right after this.
    void git.forget(this.project.path).catch(() => undefined);
    return Promise.allSettled([this.starting, this.inflight, this.action, this.autoFetching]).then(() => undefined);
  }
}

export class RepositoryManager {
  private readonly repositories = new Map<string, Repository>();

  constructor(
    private readonly onState: (projectId: string, state: RepositoryState) => void,
    private readonly onNotice: (severity: NoticeSeverity, message: string) => void,
    private readonly onCommandsChanged: (projectId: string) => void,
    private readonly onFilesChanged: (projectId: string) => void,
    private readonly onFileChanged: (projectId: string, filePath: string) => void,
    private readonly logins: GitLoginStore
  ) {}

  open(project: Project): Repository {
    const existing = this.repositories.get(project.id);
    if (existing) {
      return existing;
    }
    const repository = new Repository(
      project,
      (state) => this.onState(project.id, state),
      this.onNotice,
      () => this.configChanged(project),
      () => this.onFilesChanged(project.id),
      (filePath) => this.onFileChanged(project.id, filePath),
      this.logins
    );
    this.repositories.set(project.id, repository);
    void repository.start();
    return repository;
  }

  get(projectId: string): Repository | undefined {
    return this.repositories.get(projectId);
  }

  /** tet.json changed in the project's folder: a worktree's own copy counts for nothing, its main
   *  worktree's for every open project of the repository (tet-json.ts's configRoot). */
  private configChanged(project: Project): void {
    if (isWorktree(project.path)) {
      return;
    }
    for (const [projectId, repository] of this.repositories) {
      if (configRoot(repository.project.path) === project.path) {
        this.onCommandsChanged(projectId);
      }
    }
  }

  /** Resolves once its git commands have ended (Repository.dispose); it is gone at once. */
  close(projectId: string): Promise<void> {
    const closing = this.repositories.get(projectId)?.dispose();
    this.repositories.delete(projectId);
    return closing ?? Promise.resolve();
  }

  disposeAll(): void {
    for (const repository of this.repositories.values()) {
      repository.dispose();
    }
    this.repositories.clear();
  }
}
