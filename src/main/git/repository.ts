import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import { EMPTY_REPOSITORY_STATE } from "../../shared/types";
import type {
  CheckoutTarget,
  DiffOptions,
  ExplorerListing,
  ExplorerSettings,
  ExplorerSortOrder,
  FileContent,
  FileDiff,
  FileWriteResult,
  GitActionResult,
  NoticeSeverity,
  Project,
  RepositoryState,
  StashCommand
} from "../../shared/types";
import {
  addExclude,
  addFolder,
  readExplorerView,
  removeFolder,
  setCompactFolders,
  setExcludeGitIgnore,
  setSortOrder
} from "./commands";
import { countActivity, logSlow } from "../event-loop-monitor";
import { git } from "./git-client";
import { watchedDirectoryGone } from "../watch-dir";
import type { DiscardTargets } from "./git";
import { isImage, toDataUrl } from "./git";

/** Filesystem events arrive in bursts (a build, a checkout, an agent editing files). */
const REFRESH_DEBOUNCE_MS = 250;
/** The saved commands' file in the root, reported for the list rather than the repository. */
const COMMANDS_FILE = "tet.json";
/**
 * Least time between two finished refreshes. A working tree under continuous change would
 * otherwise keep one running back to back, and every git process a refresh starts is
 * main-process time that a keystroke on its way to a terminal waits for. Measured on a
 * machine with instrumented process creation: ~350ms per git start, two per refresh.
 */
const REFRESH_MIN_INTERVAL_MS = 2000;
/**
 * How often a repository fetches on its own, GitHub Desktop's interval. Frequent enough that
 * the ahead/behind counts are worth reading, rare enough not to hammer a remote all day.
 */
const AUTO_FETCH_INTERVAL_MS = 10 * 60_000;

/**
 * How long to wait before putting a failed watcher back, and the ceiling the delay doubles up
 * to. A watcher that dies takes every change with it and nothing says so, which is worth
 * retrying for — but a filesystem that cannot watch recursively at all (a network share, some
 * mounts) fails every single time, and retrying that once a second would be a busy loop for
 * as long as the window is open.
 */
const WATCH_RETRY_MS = 1000;
const WATCH_RETRY_MAX_MS = 60_000;
/** Above this, the editor shows "too large" instead of reading the file into the renderer. */
const MAX_EDIT_BYTES = 4 * 1024 * 1024;

/**
 * Paths whose changes never affect what the UI shows, but which change constantly —
 * watching them would mean running `git status` for every object git writes.
 */
function isIgnoredEvent(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    normalized.endsWith(".lock") ||
    normalized.startsWith(".git/objects/") ||
    normalized.startsWith(".git/logs/") ||
    // Bookkeeping git rewrites on nearly every command without any of it showing up in the
    // status or the branch list. `.git/index` is deliberately not here: staging a file
    // changes nothing else, and the status letters would otherwise go stale.
    /^\.git\/(COMMIT_EDITMSG|ORIG_HEAD|FETCH_HEAD|MERGE_MSG|rebase-)/.test(normalized) ||
    normalized.includes("node_modules/")
  );
}

/**
 * One repository's shared state: the single source of truth both the git views and the
 * terminals observe. Refreshed from the git CLI after filesystem changes, so a branch an
 * agent switches in a terminal shows up in the UI on its own.
 */
export class Repository {
  private state: RepositoryState = EMPTY_REPOSITORY_STATE;
  /** `state` serialized, kept so a refresh compares against it rather than serializing both sides. */
  private stateJson = JSON.stringify(EMPTY_REPOSITORY_STATE);
  private watcher: fs.FSWatcher | undefined;
  private watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchRetryDelay = WATCH_RETRY_MS;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Same debounce as the refresh, for the one watched file that is not git state. */
  private commandsTimer: ReturnType<typeof setTimeout> | undefined;
  /** The refresh underway, if one is. */
  private inflight: Promise<RepositoryState> | undefined;
  private refreshPending = false;
  private lastRefreshAt = 0;
  private actionRunning = false;
  private autoFetchTimer: ReturnType<typeof setInterval> | undefined;
  /** The periodic fetch underway, if one is — an action waits for it rather than being refused. */
  private autoFetching: Promise<void> | undefined;
  /**
   * Each remote's url, read when the project opens and again after `.git/config` changed —
   * that is where a remote is added or repointed, here or in a terminal. Not part of every
   * refresh: a url changes about never, and a refresh costs the git processes it starts.
   */
  private remoteUrls: Record<string, string> = {};
  private remoteUrlsStale = false;
  /** Checked once when the project opens; without it there is nothing to read or watch. */
  private isGit = false;
  /** The project was closed; anything still in flight stops short of reporting. */
  private disposed = false;

  constructor(
    readonly project: Project,
    private readonly onState: (state: RepositoryState) => void,
    private readonly onNotice: (severity: NoticeSeverity, message: string) => void,
    /**
     * tet.json in the root changed. The saved commands live in the repository, not in
     * tet, so an editor, an agent in a tab or a checkout rewrites them behind the list's
     * back — and the watcher already sees every such write, so reporting it costs no process.
     */
    private readonly onCommandsChanged: () => void
  ) {}

  /**
   * Reports a repository that could not be read. Named by project, since several are open and
   * "Not a git repository" alone would not say which. Only on a change, so a folder that stays
   * unreadable is not announced again on every refresh.
   */
  private reportError(next: RepositoryState): void {
    if (next.error && next.error !== this.state.error) {
      this.onNotice("error", `${this.project.name}: ${next.error}`);
    }
  }

  getState(): RepositoryState {
    return this.state;
  }

  async start(): Promise<void> {
    // All three at once: each is a git start (~350ms measured), and back to back that was a
    // second before the pane showed anything. readState on a folder that is no repository
    // answers with an error, which is thrown away with everything else read there.
    const [isGit, urls, read] = await Promise.all([
      git.isRepository(this.project.path).catch(() => false),
      git.readRemoteUrls(this.project.path).catch(() => ({})),
      this.read()
    ]);
    this.isGit = isGit;
    if (!this.isGit) {
      this.emit({ ...EMPTY_REPOSITORY_STATE, error: "Not a git repository" });
      return;
    }
    this.remoteUrls = urls;
    this.emit(read);
    // Closed while the first refresh ran (seconds, on a large tree): a watcher and a fetch
    // interval started now would have nothing left to close them.
    if (this.disposed) {
      return;
    }
    this.startWatching();
    this.autoFetchTimer = setInterval(() => void this.autoFetch(), AUTO_FETCH_INTERVAL_MS);
  }

  private async loadRemoteUrls(): Promise<void> {
    this.remoteUrlsStale = false;
    this.remoteUrls = await git.readRemoteUrls(this.project.path).catch(() => ({}));
  }

  /**
   * The periodic fetch. Silent when it fails: a remote whose credentials nobody entered, or a
   * machine that is offline, would otherwise put the same notice up every ten minutes for
   * something the user never asked for. A fetch they *did* ask for reports like anything else.
   *
   * It does not take the action slot: an action clicked while it runs waits for it instead of
   * being refused with a message about a command nobody started.
   */
  private async autoFetch(): Promise<void> {
    if (this.actionRunning || this.autoFetching || this.state.remotes.length === 0) {
      return;
    }
    this.autoFetching = git
      .fetch(this.project.path)
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

  /** What git says the repository is right now; a dead git process is an error like any other. */
  private read(): Promise<RepositoryState> {
    // readState answers with an error rather than throwing; what can still reject is the
    // git process having gone away underneath it, and that is worth saying out loud.
    return git.readState(this.project.path).catch((error: Error) => ({
      ...EMPTY_REPOSITORY_STATE,
      error: error.message
    }));
  }

  /**
   * Refreshes now — *after* the one already underway, if any, since that one may have read a
   * tree the caller was still changing: a commit's `add --all` wakes the watcher while the
   * `commit` still runs, and the state that refresh reports is the staged, uncommitted one.
   * Coming back only through the schedule left the pane showing it for two more seconds
   * after the progress bar had stopped.
   */
  async refresh(): Promise<RepositoryState> {
    while (this.inflight) {
      await this.inflight;
    }
    // Whatever the watcher was waiting to see, this run sees.
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
        // Back through the schedule rather than straight into another run: under continuous
        // change this was an unbroken chain of git processes, with the debounce bypassed.
        this.scheduleRefresh();
      }
    });
    return this.inflight;
  }

  /**
   * Takes what a read reported as the state, remotes completed from this side: every configured
   * remote's url, and the remote itself where it has no remote-tracking refs yet — an empty
   * repository just cloned, or `git remote add` in a terminal — since `for-each-ref` cannot
   * name it, and without it there would be nothing to push to. `origin` goes first, since the
   * first remote is the one every command that names one uses.
   */
  private emit(read: RepositoryState): void {
    const names = new Set([...read.remotes.map((remote) => remote.name), ...Object.keys(this.remoteUrls)]);
    const remotes = [...names]
      .sort((a, b) => Number(b === "origin") - Number(a === "origin"))
      .map((name) => ({
        name,
        branches: read.remotes.find((remote) => remote.name === name)?.branches ?? [],
        url: this.remoteUrls[name]
      }));
    const next: RepositoryState = { ...read, remotes };
    this.reportError(next);
    // Only emit on an actual change: the watcher fires for plenty of edits that leave the
    // state identical, and every emit re-renders the views. And not at all once the project
    // is closed — this call was already in flight when it went.
    // Labeled on its own rather than left as "git": this runs after the git process the
    // refresh started has already finished, well past whatever countActivity("git") caught.
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

  /**
   * Refreshes once the events have settled, and never sooner than REFRESH_MIN_INTERVAL_MS
   * after the last one finished. Only the watcher goes through here — a refresh the user
   * asked for runs at once. One already underway is not joined: it will have read what the
   * watcher saw, or it schedules this again when it has not.
   */
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

  /**
   * Runs one command at a time and refreshes after it. Two of them in one repository race for
   * the index lock, and which branch you end up on comes down to timing. The UI does not offer
   * a second one while the first runs; anything that gets here anyway is refused.
   */
  private async runAction(action: () => Promise<GitActionResult>): Promise<GitActionResult> {
    // The periodic fetch holds the lock too, for as long as an unreachable host takes to time
    // out; a click during that waits rather than fails.
    while (this.autoFetching) {
      await this.autoFetching;
    }
    if (this.actionRunning) {
      return { ok: false, error: "A git command is already running for this repository" };
    }
    this.actionRunning = true;
    try {
      // A git command reports failure in its result; a rejection here is the git process
      // itself having stopped, which the caller shows the same way.
      const result = await action().catch((error: Error) => ({ ok: false, error: error.message }));
      await this.refresh();
      return result;
    } finally {
      this.actionRunning = false;
    }
  }

  checkout(target: CheckoutTarget): Promise<GitActionResult> {
    return this.runAction(() => git.checkout(this.project.path, target, this.state.localBranches));
  }

  fetch(): Promise<GitActionResult> {
    return this.runAction(() => git.fetch(this.project.path));
  }

  pull(): Promise<GitActionResult> {
    return this.runAction(() => git.pull(this.project.path));
  }

  /**
   * Pushes the current branch, publishing it when it has no upstream yet — to `remote` below.
   */
  push(): Promise<GitActionResult> {
    return this.runAction(() => {
      const remote = this.remote;
      if (!remote) {
        return Promise.resolve({ ok: false, error: "This repository has no remote to push to" });
      }
      if (this.state.detached) {
        return Promise.resolve({ ok: false, error: "HEAD is detached — check out a branch to push it" });
      }
      return git.push(this.project.path, remote, this.state.head, this.state.upstream === undefined);
    });
  }

  /**
   * The remote every command that names one uses: the first, which `emit` makes "origin"
   * wherever there is one — what GitHub Desktop picks too.
   */
  private get remote(): string | undefined {
    return this.state.remotes[0]?.name;
  }

  /** Points the remote somewhere else and re-reads the urls, since only this changes them. */
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

  renameBranch(from: string, to: string): Promise<GitActionResult> {
    return this.runAction(() => git.renameBranch(this.project.path, from, to));
  }

  /**
   * Deletes the branch locally and, when asked, on the remote too. The local one goes first: it
   * cannot fail for reasons outside the machine, and a remote that refuses the deletion leaves
   * a state the user can still see and act on.
   */
  deleteBranch(name: string, onRemote: boolean): Promise<GitActionResult> {
    return this.runAction(async () => {
      const local = await git.deleteBranch(this.project.path, name);
      if (!local.ok || !onRemote) {
        return local;
      }
      return this.remote
        ? git.deleteRemoteBranch(this.project.path, this.remote, name)
        : { ok: false, error: "This repository has no remote to delete the branch from" };
    });
  }

  merge(ref: string): Promise<GitActionResult> {
    return this.runAction(() => git.merge(this.project.path, ref));
  }

  rebase(ref: string): Promise<GitActionResult> {
    return this.runAction(() => git.rebase(this.project.path, ref));
  }

  /** Takes back the merge or rebase git is half-way through, whichever one that is. */
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

  /** Commits the working tree, untracked files and all, and leaves it clean. */
  commitAll(message: string): Promise<GitActionResult> {
    return this.runAction(() => git.commitAll(this.project.path, message));
  }

  /** Puts the working tree away, untracked files and all, and leaves it clean. */
  stashPush(message: string): Promise<GitActionResult> {
    return this.runAction(() => git.stashPush(this.project.path, message));
  }

  /**
   * One of the three commands that take a stash. The ref is a *position* — dropping one
   * renumbers the rest — so it is only ever the one the last refresh reported, and the
   * refresh this runs afterwards is what the next click reads from.
   */
  stash(command: StashCommand, ref: string): Promise<GitActionResult> {
    const commands = { apply: git.stashApply, pop: git.stashPop, drop: git.stashDrop };
    return this.runAction(() => commands[command](this.project.path, ref));
  }

  /**
   * Throws away the local changes to these files. What HEAD does not hold goes to the trash
   * instead of being deleted, so "discard" stays recoverable the way GitHub Desktop's is.
   */
  discard(paths: string[]): Promise<GitActionResult> {
    // Through runAction like every other command: `git restore` takes the index lock, so a
    // discard started from the changes' context menu during a fetch or checkout would fail on
    // it — with the untracked files already in the trash by then.
    return this.runAction(async () => {
      const targets: DiscardTargets = { restore: [], drop: [] };
      for (const filePath of paths) {
        const change = this.state.changes.find((candidate) => candidate.path === filePath);
        if (!change) {
          continue;
        }
        if (change.status === "untracked" || change.status === "added") {
          targets.drop.push(filePath);
          // Staged and then deleted again on disk still reads as "added" — there is nothing
          // left to move, and asking the trash to take it would only fail.
          const absolute = path.join(this.project.path, filePath);
          if (fs.existsSync(absolute)) {
            try {
              await shell.trashItem(absolute);
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          }
          continue;
        }
        targets.restore.push(filePath);
        // A rename is one entry over two paths, and only the old one is in HEAD.
        if (change.origPath) {
          targets.restore.push(change.origPath);
        }
      }

      return git.discard(this.project.path, targets);
    });
  }

  /** Adds the file, or everything with its extension, to the repository's .gitignore. */
  ignore(filePath: string, scope: "file" | "extension"): Promise<GitActionResult> {
    return this.runAction(() => git.ignorePath(this.project.path, filePath, scope));
  }

  async diff(filePath: string, options: DiffOptions): Promise<FileDiff> {
    const change = this.state.changes.find((candidate) => candidate.path === filePath);
    return git
      .readDiff(this.project.path, filePath, {
        ...options,
        untracked: change?.status === "untracked",
        origPath: change?.origPath
      })
      .catch((error: Error) => ({ path: filePath, lines: [], binary: false, truncated: false, error: error.message }));
  }

  /** The file's own lines, for a gap the diff view was asked to open. */
  fileLines(filePath: string, from: number, to: number): Promise<string[]> {
    // Same as when the file cannot be read: no lines, so the gap simply stays closed.
    return git.readFileLines(this.project.path, filePath, from, to).catch(() => []);
  }

  /**
   * Every file in the repository, plus any directory nothing else in the listing would imply —
   * see `ExplorerListing`. A real scan rather than a git process: not on the index lock
   * `runAction` serialises, and `fs.promises` so a large `node_modules` doesn't hold the main
   * process's event loop — the same typing-lag reason git itself never runs there directly.
   *
   * What the project's tet.json says about its Explorer tree is applied here: `exclude` globs
   * and git's own ignore list (one `ls-files` process per listing, only when opted into — never
   * on the refresh path) are skipped during the walk, a walk that covers only the configured
   * `folders` where there are any — the outermost ones, since a root inside another root holds
   * nothing the outer walk doesn't already pass. Modification times are read only for the one
   * sort order that needs them: a `stat` per entry is not free on a large tree.
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
        // A vanished entry sorts with the oldest; the tree still lists it until the next read.
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
          // A symlink is listed as the file row it mostly is: a dirent reports a link as
          // neither file nor directory, so without this branch links vanish from the tree —
          // never descended into either way, which is also what keeps a link cycle harmless.
          files.push(relativePath);
        }
        if (wantMtimes) {
          pending.push(stat(absolutePath, relativePath));
        }
      }
      // Sibling directories in parallel — the walk is readdir-bound, and the final sorts make
      // the listing deterministic regardless of which branch answers first.
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

  /** A repository-relative path, checked to exist (or not) and resolved, or an error either way. */
  private async resolveNew(filePath: string): Promise<{ absolute: string } | { error: string }> {
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return { error: "Path is outside the repository" };
    }
    if (fs.existsSync(absolute)) {
      return { error: "Something already exists at this path" };
    }
    return { absolute };
  }

  /** An empty file, for the Explorer tree's "New File..." — parent directories are created with it. */
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

  /** An empty directory, for the Explorer tree's "New Folder...". */
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

  /**
   * A file or directory, moved to the trash — the Explorer tree's own "Delete...", same
   * recoverability as `discard` gives an untracked file, since this one may not be tracked at
   * all either.
   */
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

  /** Renames or moves a file or directory — the Explorer tree's own "Rename...". */
  async renamePath(fromPath: string, toPath: string): Promise<GitActionResult> {
    const from = this.resolveInside(fromPath);
    if (!from) {
      return { ok: false, error: "Path is outside the repository" };
    }
    const to = await this.resolveNew(toPath);
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

  /**
   * The Explorer tree's three edits of the project's own tet.json — "Add Folder to Workspace",
   * "Remove Folder from Workspace", "Exclude from Files". Reported like the file actions above
   * (the tree runs all of them the same way); the watcher sees the write and re-lists.
   */
  addFolder(folderPath: string): Promise<GitActionResult> {
    return this.editExplorer(() => addFolder(this.project.path, folderPath));
  }

  removeFolder(folderPath: string): Promise<GitActionResult> {
    return this.editExplorer(() => removeFolder(this.project.path, folderPath));
  }

  excludePath(relPath: string): Promise<GitActionResult> {
    return this.editExplorer(() => addExclude(this.project.path, relPath));
  }

  /** The settings dialog's Files tab reads and writes these three the same way. */
  readExplorerSettings(): Promise<ExplorerSettings> {
    return readExplorerView(this.project.path);
  }

  setExcludeGitIgnore(value: boolean): Promise<GitActionResult> {
    return this.editExplorer(() => setExcludeGitIgnore(this.project.path, value));
  }

  setCompactFolders(value: boolean): Promise<GitActionResult> {
    return this.editExplorer(() => setCompactFolders(this.project.path, value));
  }

  setSortOrder(value: ExplorerSortOrder): Promise<GitActionResult> {
    return this.editExplorer(() => setSortOrder(this.project.path, value));
  }

  private async editExplorer(edit: () => Promise<void>): Promise<GitActionResult> {
    try {
      await edit();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** A repository-relative path resolved to an absolute one, or undefined if it escapes the root. */
  private resolveInside(filePath: string): string | undefined {
    const absolute = path.resolve(this.project.path, filePath);
    const relative = path.relative(this.project.path, absolute);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? absolute : undefined;
  }

  /** A file's content for the diff dialog's editor. */
  async readFile(filePath: string): Promise<FileContent> {
    const base = { path: filePath, content: "", mtimeMs: 0, binary: false, tooLarge: false };
    const absolute = this.resolveInside(filePath);
    if (!absolute) {
      return { ...base, error: "Path is outside the repository" };
    }
    try {
      const stat = await fs.promises.stat(absolute);
      if (!stat.isFile()) {
        return { ...base, error: "Not a file" };
      }
      if (stat.size > MAX_EDIT_BYTES) {
        return { ...base, mtimeMs: stat.mtimeMs, tooLarge: true };
      }
      const buffer = await fs.promises.readFile(absolute);
      const binary = buffer.includes(0);
      const image = isImage(filePath) ? toDataUrl(filePath, buffer) : undefined;
      return { ...base, mtimeMs: stat.mtimeMs, binary, image, content: binary ? "" : buffer.toString("utf8") };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Writes a file's content, refusing when it changed on disk since it was read — the mtime the
   * editor opened is the only thing standing between a save and silently overwriting someone
   * else's edit. Written in place: this is the user's own source file, not one of the files
   * other processes read that `rename`-into-place protects (see CLAUDE.md), and in-place keeps
   * its mode and any hard links.
   */
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
      this.watcher = fs.watch(this.project.path, { recursive: true }, (_event, filename) => {
        const name = filename?.toString();
        if (name && isIgnoredEvent(name)) {
          return;
        }
        // The retry loop takes it from here and picks the directory back up when it reappears.
        if (watchedDirectoryGone(this.project.path, name)) {
          this.watcher?.close();
          this.watcher = undefined;
          this.retryWatching();
          return;
        }
        // Events are arriving, so whatever went wrong before is over — the next failure backs
        // off from the bottom again rather than from where the last one left the delay.
        this.watchRetryDelay = WATCH_RETRY_MS;
        if (name && /^\.git[\\/]config$/.test(name)) {
          this.remoteUrlsStale = true;
        }
        if (name === COMMANDS_FILE) {
          // Debounced like the refresh: the file is written in place, and a read landing
          // between the events of one write would find half a file.
          clearTimeout(this.commandsTimer);
          this.commandsTimer = setTimeout(this.onCommandsChanged, REFRESH_DEBOUNCE_MS);
        }
        this.scheduleRefresh();
      });
      this.watcher.on("error", (error) => {
        console.error(`[tet] watcher failed for ${this.project.path}:`, error);
        this.watcher?.close();
        this.watcher = undefined;
        this.retryWatching();
      });
    } catch (error) {
      // A filesystem that cannot watch recursively throws here rather than emitting an error.
      console.error(`[tet] could not watch ${this.project.path}:`, error);
      this.retryWatching();
    }
  }

  /**
   * Puts a failed watcher back, and refreshes once one is up: whatever changed while nothing
   * was watching has to come in from somewhere. Without this a single error left the repository
   * frozen for the life of the window, with nothing on screen saying so.
   */
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

  dispose(): void {
    // Read by refresh, which may be half-way through a git call that outlives this: what comes
    // back then belongs to a project the window has already forgotten.
    this.disposed = true;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.commandsTimer);
    clearTimeout(this.watchRetryTimer);
    clearInterval(this.autoFetchTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

export class RepositoryManager {
  private readonly repositories = new Map<string, Repository>();

  constructor(
    private readonly onState: (projectId: string, state: RepositoryState) => void,
    private readonly onNotice: (severity: NoticeSeverity, message: string) => void,
    private readonly onCommandsChanged: (projectId: string) => void
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
      () => this.onCommandsChanged(project.id)
    );
    this.repositories.set(project.id, repository);
    void repository.start();
    return repository;
  }

  get(projectId: string): Repository | undefined {
    return this.repositories.get(projectId);
  }

  close(projectId: string): void {
    this.repositories.get(projectId)?.dispose();
    this.repositories.delete(projectId);
  }

  disposeAll(): void {
    for (const repository of this.repositories.values()) {
      repository.dispose();
    }
    this.repositories.clear();
  }
}
