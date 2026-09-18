import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import { EMPTY_REPOSITORY_STATE } from "../../shared/types";
import type {
  CheckoutTarget,
  ExplorerListing,
  ExplorerSettings,
  FileChange,
  FileContent,
  FileWriteResult,
  GitActionResult,
  HeadBlob,
  NoticeSeverity,
  Project,
  RepositoryState,
  StashCommand
} from "../../shared/types";
import { addExclude, addFolder, PROJECT_FILE, readExplorerView, removeFolder, setExplorerSetting } from "./commands";
import { countActivity, logSlow } from "../event-loop-monitor";
import { git } from "./git-client";
import { readLinkedGitDir } from "./linked-git-dir";
import { watchedDirectoryGone } from "../watch-dir";
import { relativeInside } from "../path-inside";
import type { DiscardTargets } from "./git";
import { isImage, toDataUrl } from "./git";

/** Filesystem events arrive in bursts (a build, a checkout, an agent editing files). */
const REFRESH_DEBOUNCE_MS = 250;
/** Least time between two finished refreshes, or continuous change runs them back to back. Measured
 *  with instrumented process creation: the git start is the cost, three per refresh, and that is
 *  main-process time a keystroke on its way to a terminal waits for. */
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
/** Above this, the editor shows "too large" instead of reading the file into the renderer. */
const MAX_EDIT_BYTES = 4 * 1024 * 1024;

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
  private remoteUrlsStale = false;
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
    private readonly onFileChanged: (filePath: string) => void
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
    const [isGit, urls, defaultBranchName, read] = await Promise.all([
      git.isRepository(this.project.path).catch(() => false),
      git.readRemoteUrls(this.project.path).catch(() => ({})),
      git.readDefaultBranchName(this.project.path).catch(() => "main"),
      this.read()
    ]);
    this.isGit = isGit;
    if (!this.isGit) {
      this.emit({ ...EMPTY_REPOSITORY_STATE, error: "Not a git repository" });
      return;
    }
    this.remoteUrls = urls;
    this.defaultBranchName = defaultBranchName;
    // The first read ran without the remote names; only a name holding a "/" changes it.
    this.emit(Object.keys(urls).some((name) => name.includes("/")) ? await this.read() : read);
    // Closed during the first read: a watcher started now would never be closed.
    if (this.disposed) {
      return;
    }
    this.startWatching();
    this.autoFetchTimer = setInterval(() => void this.autoFetch(), AUTO_FETCH_INTERVAL_MS);
  }

  private async loadRemoteUrls(): Promise<void> {
    this.remoteUrlsStale = false;
    [this.remoteUrls, this.defaultBranchName] = await Promise.all([
      git.readRemoteUrls(this.project.path).catch(() => ({})),
      git.readDefaultBranchName(this.project.path).catch(() => "main")
    ]);
  }

  /** The periodic fetch. Silent on failure, or an offline machine gets a notice every ten minutes.
   *  It doesn't take the action slot — a click during it waits. */
  private async autoFetch(): Promise<void> {
    if (this.actionRunning || this.autoFetching || this.state.remotes.length === 0) {
      return;
    }
    this.autoFetching = git
      .fetch(this.project.path, AUTO_FETCH_TIMEOUT_MS)
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
    return git.readState(this.project.path, Object.keys(this.remoteUrls)).catch((error: Error) => ({
      ...EMPTY_REPOSITORY_STATE,
      error: error.message
    }));
  }

  /** Refreshes now — *after* any refresh underway, which may have read a tree still changing: a
   *  commit's `add --all` wakes the watcher while `commit` runs, reporting the staged state. */
  async refresh(): Promise<RepositoryState> {
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
      if (this.remoteUrlsStale) {
        await this.loadRemoteUrls();
      }
      const next = await this.read();
      this.emit(next);
      return next;
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
    const next: RepositoryState = { ...read, remotes, defaultBranch };
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
      return action().catch((error: Error) => ({ ok: false, error: error.message }));
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
      this.action = action().catch((error: Error) => ({ ok: false, error: error.message }));
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

  fetch(): Promise<GitActionResult> {
    return this.runAction(async () => {
      const fetched = await git.fetch(this.project.path);
      await git.fastForwardBranches(this.project.path);
      return fetched;
    });
  }

  /** Then, as GitHub Desktop does, the remote's HEAD is asked for again and the other branches only
   *  behind their upstreams are moved up. */
  pull(): Promise<GitActionResult> {
    return this.runAction(async () => {
      const pulled = await git.pull(this.project.path);
      const remote = this.state.branchUpstreams[this.state.head]?.remote ?? this.remote;
      if (pulled.ok && remote) {
        await git.updateRemoteHead(this.project.path, remote);
      }
      await git.fastForwardBranches(this.project.path);
      return pulled;
    });
  }

  /** Pushes the current branch to its upstream, or publishes it to `remote` when it has none. */
  push(): Promise<GitActionResult> {
    return this.runAction(() => {
      const upstream = this.state.branchUpstreams[this.state.head];
      const remote = upstream?.remote ?? this.remote;
      if (!remote) {
        return Promise.resolve({ ok: false, error: "This repository has no remote to push to" });
      }
      if (this.state.detached) {
        return Promise.resolve({ ok: false, error: "HEAD is detached — check out a branch to push it" });
      }
      return git.push(this.project.path, remote, this.state.head, upstream?.branch);
    });
  }

  /** The remote every command uses: the first, which `emit` makes "origin" where there is one. */
  private get remote(): string | undefined {
    return this.state.remotes[0]?.name;
  }

  /** Re-reads the urls after, since only this changes them. */
  setRemoteUrl(remote: string, url: string): Promise<GitActionResult> {
    return this.runAction(async () => {
      const result = await git.setRemoteUrl(this.project.path, remote, url);
      await this.loadRemoteUrls();
      return result;
    });
  }

  createBranch(name: string, startPoint: string): Promise<GitActionResult> {
    return this.runAction(() => git.createBranch(this.project.path, name, startPoint));
  }

  /** A new branch at `base`, checked out at `target` (git.ts's worktreeAdd). */
  addWorktree(target: string, branch: string, base: CheckoutTarget): Promise<GitActionResult> {
    return this.runAction(() => git.worktreeAdd(this.project.path, target, branch, base));
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

  renameBranch(from: string, to: string): Promise<GitActionResult> {
    return this.runAction(() => git.renameBranch(this.project.path, from, to));
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
        ? git.deleteRemoteBranch(this.project.path, upstream.remote, upstream.branch)
        : { ok: false, error: `${name} has no upstream to delete on a remote` };
    });
  }

  /** A remote branch alone, from its row under the remote. */
  deleteRemoteBranch(remote: string, name: string): Promise<GitActionResult> {
    return this.runAction(() => git.deleteRemoteBranch(this.project.path, remote, name));
  }

  merge(ref: string): Promise<GitActionResult> {
    return this.runAction(() => git.merge(this.project.path, ref));
  }

  /** Unless `confirmed`, refused with `rewritesPushed` where it would rewrite commits the upstream
   *  has: the caller asks, since pushing them afterwards takes a force push. */
  rebase(ref: string, confirmed: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      if (!confirmed && (await git.rebaseRewritesPushed(this.project.path, ref))) {
        return { ok: false, rewritesPushed: true };
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

  pushTag(name: string): Promise<GitActionResult> {
    return this.runAction(() =>
      this.remote
        ? git.pushTag(this.project.path, this.remote, name)
        : Promise.resolve({ ok: false, error: "This repository has no remote to push the tag to" })
    );
  }

  deleteTag(name: string, onRemote: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      const local = await git.deleteTag(this.project.path, name);
      if (!local.ok || !onRemote) {
        return local;
      }
      return this.remote
        ? git.deleteRemoteTag(this.project.path, this.remote, name)
        : { ok: false, error: "This repository has no remote to delete the tag from" };
    });
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
      const untracked = paths.filter((filePath) =>
        this.state.changes.some((change) => change.path === filePath && change.status === "untracked")
      );
      return git.commitPaths(this.project.path, message, this.pathspec(paths), untracked);
    });
  }

  /** Stashes everything, untracked files included. */
  stashPush(message: string): Promise<GitActionResult> {
    return this.runAction(() => git.stashPush(this.project.path, message));
  }

  /** These paths plus each rename's old one: a commit given only the new path takes half a rename. */
  pathspec(paths: string[]): string[] {
    const expanded = [...paths];
    for (const filePath of paths) {
      const origPath = this.state.changes.find((change) => change.path === filePath)?.origPath;
      if (origPath && !expanded.includes(origPath)) {
        expanded.push(origPath);
      }
    }
    return expanded;
  }

  /** By the stash's commit, which a stash made meanwhile doesn't move. */
  stash(command: StashCommand, sha: string): Promise<GitActionResult> {
    const commands = { apply: git.stashApply, pop: git.stashPop, drop: git.stashDrop };
    return this.runAction(() => commands[command](this.project.path, sha));
  }

  /** Throws away changes to these files, each file on disk going to the trash first, as in GitHub
   *  Desktop, so an edit can be had back. A merge stays in progress: a conflict is only reset to HEAD.
   *  When the trash fails, what went to it before is still reset and the rest is left
   *  (`trashFailed`); `permanently` then deletes instead. */
  discard(paths: string[], permanently: boolean): Promise<GitActionResult> {
    // Through runAction: `git restore` takes the index lock, and failing on it during a fetch or
    // checkout would leave the files already trashed.
    return this.runAction(async () => {
      const targets: DiscardTargets = { restore: [], drop: [] };
      const changes = paths.flatMap((filePath) => this.state.changes.find((change) => change.path === filePath) ?? []);
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
              const message = error instanceof Error ? error.message : String(error);
              return reset.ok ? { ok: false, error: message, trashFailed: true } : reset;
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

  /**
   * Every file, plus empty directories — see `ExplorerListing`. A filesystem walk, not a git
   * process: off the index lock `runAction` serialises, and `fs.promises` so a large `node_modules`
   * doesn't hold the main event loop. Skips `exclude` globs and, if opted in, git's ignore list (one
   * `ls-files` per listing, never on the refresh path); walks only the outermost `folders`. Mtimes
   * cost a `stat` per entry, so only `modified` reads them.
   */
  async listExplorer(): Promise<ExplorerListing> {
    const view = await readExplorerView(this.project.path);
    const ignored = view.excludeGitIgnore ? await git.listIgnored(this.project.path).catch(() => []) : [];
    const ignoredFiles = new Set(ignored.filter((entry) => !entry.endsWith("/")));
    const ignoredDirs = new Set(ignored.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)));
    const skip = (relativePath: string, isDirectory: boolean): boolean =>
      (isDirectory ? ignoredDirs : ignoredFiles).has(relativePath) ||
      view.exclude.some((pattern) => path.matchesGlob(relativePath, pattern));
    const wantMtimes = view.sortOrder === "modified";

    const files: string[] = [];
    const emptyDirs: string[] = [];
    const mtimes: Record<string, number> = {};
    const stat = async (absolutePath: string, relativePath: string): Promise<void> => {
      try {
        mtimes[relativePath] = (await fs.promises.stat(absolutePath)).mtimeMs;
      } catch {
        // Vanished: sorts with the oldest until the next listing.
      }
    };
    const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.length === 0) {
        if (relativeDir) {
          emptyDirs.push(relativeDir);
        }
        return;
      }
      const pending: Promise<void>[] = [];
      for (const entry of entries) {
        // Hidden regardless of `files.exclude`.
        if (entry.name === ".git") {
          continue;
        }
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const absolutePath = path.join(absoluteDir, entry.name);
        const isDirectory = entry.isDirectory();
        if (!isDirectory && !entry.isFile() && !entry.isSymbolicLink()) {
          continue;
        }
        if (skip(relativePath, isDirectory)) {
          continue;
        }
        if (isDirectory) {
          pending.push(walk(absolutePath, relativePath));
        } else {
          // A symlink is a file row, never descended into, so a link cycle is harmless.
          files.push(relativePath);
        }
        if (wantMtimes) {
          pending.push(stat(absolutePath, relativePath));
        }
      }
      // In parallel; the final sorts keep the listing deterministic.
      await Promise.all(pending);
    };
    const roots = view.folders;
    const outermost = roots.filter(
      (root) => !roots.some((other) => other !== root && (other.path === "" || root.path.startsWith(`${other.path}/`)))
    );
    if (outermost.length === 0) {
      await walk(this.project.path, "");
    } else {
      await Promise.all(outermost.map((root) => walk(path.join(this.project.path, root.path), root.path)));
    }
    return {
      files: files.sort(),
      emptyDirs: emptyDirs.sort(),
      roots: roots.length > 0 ? roots : undefined,
      compactFolders: view.compactFolders,
      sortOrder: view.sortOrder,
      mtimes: wantMtimes ? mtimes : undefined
    };
  }

  /** A repository-relative path for a new entry, resolved, or an error if outside or taken.
   *  `renaming` is the source: on a case-insensitive filesystem `Readme.md` → `README.md` finds the
   *  source at the target, which is no conflict. */
  private async resolveNew(filePath: string, renaming?: string): Promise<{ absolute: string } | { error: string }> {
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return { error: "Path is outside the repository" };
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
    try {
      await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
      await fs.promises.writeFile(target.absolute, "", { flag: "wx" });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The Explorer's "New Folder...". */
  async createDirectory(dirPath: string): Promise<GitActionResult> {
    const target = await this.resolveNew(dirPath);
    if ("error" in target) {
      return { ok: false, error: target.error };
    }
    try {
      await fs.promises.mkdir(target.absolute, { recursive: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The Explorer's "Delete...": to the trash, like `discard`. */
  async deletePath(filePath: string): Promise<GitActionResult> {
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return { ok: false, error: "Path is outside the repository" };
    }
    try {
      await shell.trashItem(absolute);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The Explorer's "Rename...", which may also move. */
  async renamePath(fromPath: string, toPath: string): Promise<GitActionResult> {
    const from = this.resolveInside(fromPath);
    if (!from) {
      return { ok: false, error: "Path is outside the repository" };
    }
    const to = await this.resolveNew(toPath, from);
    if ("error" in to) {
      return { ok: false, error: to.error };
    }
    try {
      await fs.promises.mkdir(path.dirname(to.absolute), { recursive: true });
      await fs.promises.rename(from, to.absolute);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The Explorer's tet.json edits ("Add Folder to Workspace", "Remove Folder from Workspace",
   *  "Exclude from Files"); the watcher sees the write and re-lists. */
  addFolder(folderPath: string): Promise<GitActionResult> {
    return this.editExplorer(() => addFolder(this.project.path, folderPath));
  }

  removeFolder(folderPath: string): Promise<GitActionResult> {
    return this.editExplorer(() => removeFolder(this.project.path, folderPath));
  }

  excludePath(relPath: string): Promise<GitActionResult> {
    return this.editExplorer(() => addExclude(this.project.path, relPath));
  }

  /** For the settings dialog's Files tab; folders and exclude globs stay the tree's own. */
  async readExplorerSettings(): Promise<ExplorerSettings> {
    const { excludeGitIgnore, compactFolders, sortOrder } = await readExplorerView(this.project.path);
    return { excludeGitIgnore, compactFolders, sortOrder };
  }

  setExplorerSetting<K extends keyof ExplorerSettings>(key: K, value: ExplorerSettings[K]): Promise<GitActionResult> {
    return this.editExplorer(() => setExplorerSetting(this.project.path, key, value));
  }

  private async editExplorer(edit: () => Promise<void>): Promise<GitActionResult> {
    try {
      await edit();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
      return { ...base, error: "Path is outside the repository" };
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
      return { ...base, error: error instanceof Error ? error.message : String(error) };
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
      return { ok: false, error: "Path is outside the repository" };
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
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
          this.remoteUrlsStale = true;
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
        this.remoteUrlsStale = true;
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
    private readonly onFileChanged: (projectId: string, filePath: string) => void
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
      () => this.onCommandsChanged(project.id),
      () => this.onFilesChanged(project.id),
      (filePath) => this.onFileChanged(project.id, filePath)
    );
    this.repositories.set(project.id, repository);
    void repository.start();
    return repository;
  }

  get(projectId: string): Repository | undefined {
    return this.repositories.get(projectId);
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
