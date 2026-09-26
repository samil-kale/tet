import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { errorMessage, failure } from "../../shared/errors";
import { urlOrigin } from "../../shared/git-url";
import { EMPTY_REPOSITORY_STATE, refName } from "../../shared/types";
import { isImage, toDataUrl } from "./image-type";
import { readLinkedGitDir } from "./linked-git-dir";
import type {
  BranchUpstream,
  CheckoutTarget,
  ChangeStatus,
  FileChange,
  GitActionResult,
  GitLogin,
  GitOperation,
  HeadBlob,
  RemoteInfo,
  RepositoryState,
  StashCommand,
  StashEntry,
  WorktreeInfo
} from "../../shared/types";

const MAX_BUFFER = 64 * 1024 * 1024;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs the local git CLI. Resolves for any exit code; rejects only when git could not be started.
 * Past `timeoutMs` git is killed and this resolves at once as a failure — not on the callback,
 * which waits for every pipe, and a credential helper or ssh started by git holds them past git's end.
 */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8", env: env && { ...process.env, ...env } },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        // Git ran but exceeded MAX_BUFFER: a failed command, not one that never started.
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ stdout: "", stderr: `git's output exceeded ${MAX_BUFFER / (1024 * 1024)} MB`, code: 1 });
          return;
        }
        if (error && typeof error.code !== "number") {
          reject(new Error(`git could not be started (${error.code ?? error.message})`));
          return;
        }
        resolve({ stdout, stderr, code: error ? Number(error.code) : 0 });
      }
    );
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill();
        resolve({ stdout: "", stderr: `git took longer than ${timeoutMs / 1000} s and was stopped`, code: 1 });
      }, timeoutMs);
    }
  });
}

/** git's version as it prints it ("2.55.0.windows.3"); undefined when the CLI cannot be started.
 *  Runs in the temp directory, which exists everywhere. Asked once: git does not change under a
 *  running app, and the worktree actions would otherwise spawn a process each to ask again. */
let gitVersion: Promise<string | undefined> | undefined;
export function version(): Promise<string | undefined> {
  gitVersion ??= (async () => {
    try {
      const result = await git(os.tmpdir(), ["--version"]);
      return result.code === 0 ? result.stdout.trim().replace(/^git version /, "") : undefined;
    } catch {
      return undefined;
    }
  })();
  return gitVersion;
}

export async function isRepository(cwd: string): Promise<boolean> {
  try {
    const result = await git(cwd, ["rev-parse", "--git-dir"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/** The repository root of `cwd`, or undefined outside one; git reports paths relative to it. */
export async function resolveRoot(cwd: string): Promise<string | undefined> {
  try {
    const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    return result.code === 0 && root ? path.normalize(root) : undefined;
  } catch {
    return undefined;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The repository's project id, `tet.id` in its own config (`--local`: a linked worktree reads its
 * main one's, which is the point); undefined where it has none, or none valid. Rejects where git
 * cannot say (the folder gone, git not started): no answer is not "none", which would replace it.
 */
export async function readProjectId(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ["config", "--local", "--get", "tet.id"]);
  // Exit 1 is git's "no such key".
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr.trim() || `git config failed (exit code ${result.code})`);
  }
  const id = result.code === 0 ? result.stdout.trim() : "";
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

export function writeProjectId(cwd: string, id: string): Promise<GitActionResult> {
  return run(cwd, ["config", "--local", "tet.id", id]);
}

/** Exit 5 is git's "no such key": already gone is gone. */
export async function unsetProjectId(cwd: string): Promise<GitActionResult> {
  const result = await git(cwd, ["config", "--local", "--unset-all", "tet.id"]).catch(failure);
  if ("ok" in result) {
    return result;
  }
  return result.code === 0 || result.code === 5 ? { ok: true } : { ok: false, error: result.stderr.trim() || "git config failed" };
}

/** What the status header says about HEAD. */
type HeadState = Pick<RepositoryState, "head" | "detached" | "upstream" | "ahead" | "behind">;

/**
 * The `--branch` status header: branch, upstream and drift — one process instead of a `rev-parse`
 * plus a `rev-list`. Only a detached HEAD needs a second call.
 */
async function readHead(cwd: string, header: string): Promise<HeadState> {
  const base = { upstream: undefined, ahead: 0, behind: 0 };
  if (header === "HEAD (no branch)") {
    const short = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    return { ...base, head: short.stdout.trim() || "HEAD", detached: true };
  }
  // Unborn branch: a prefix, then a normal header ("No commits yet on master...origin/master [gone]"
  // for a clone of an empty repository). Git before 2.16 says "Initial commit on".
  const branch = header.replace(/^(?:No commits yet on|Initial commit on) /, "");
  // "<branch>...<upstream> [ahead 1, behind 2]", or plain "<branch>". A branch name holds neither
  // "..." nor a space.
  const [name, rest] = branch.split("...");
  const tracking = /^(\S+)(?: \[(.*)\])?$/.exec(rest ?? "");
  const divergence = tracking?.[2] ?? "";
  return {
    head: name.split(" ")[0] || "HEAD",
    detached: false,
    // "[gone]": the remote no longer has the upstream; counts as none.
    upstream: tracking && divergence !== "gone" ? tracking[1] : undefined,
    ahead: Number(/ahead (\d+)/.exec(divergence)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(divergence)?.[1] ?? 0)
  };
}

/**
 * Ahead/behind per commit pair, cached: two hashes fix the count, and readRefs would otherwise spend
 * a process per diverged branch every refresh.
 */
const trackCounts = new Map<string, { ahead: number; behind: number }>();

async function readTrackCount(
  cwd: string,
  head: string,
  upstreamHead: string
): Promise<{ ahead: number; behind: number } | undefined> {
  const key = `${cwd}\0${head}...${upstreamHead}`;
  const cached = trackCounts.get(key);
  if (cached) {
    return cached;
  }
  const result = await git(cwd, ["rev-list", "--left-right", "--count", `${head}...${upstreamHead}`]);
  if (result.code !== 0) {
    return undefined;
  }
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
  const track = { ahead: ahead || 0, behind: behind || 0 };
  trackCounts.set(key, track);
  return track;
}

/**
 * Every ref the tree shows, from one `for-each-ref`. A local branch `%(upstream:trackshort)` reports
 * as diverged gets its own `rev-list --left-right --count` — except the checked-out one (`readHead`
 * has its numbers) and one whose upstream is not among these refs.
 */
async function readRefs(
  cwd: string,
  remoteNames: string[]
): Promise<{
  localBranches: string[];
  remotes: RemoteInfo[];
  tags: string[];
  defaultBranch?: CheckoutTarget;
  branchTrack: Record<string, { ahead: number; behind: number }>;
  branchUpstreams: Record<string, BranchUpstream>;
  headCommit?: string;
}> {
  // Full ref names, not %(refname:short): that shortens "refs/remotes/origin/HEAD" to "origin", like
  // a branch of that name. %(symref) is set only on "<remote>/HEAD", naming the default branch.
  // %(upstream:remotename) and %(upstream:remoteref) name an upstream unambiguously, where
  // "team/fork/x" could be split at either slash.
  const result = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(symref)%00%(objectname)%00%(HEAD)%00%(upstream)%00%(upstream:trackshort)%00%(upstream:remotename)%00%(upstream:remoteref)",
    "refs/heads",
    "refs/remotes",
    "refs/tags"
  ]);

  const localBranches: string[] = [];
  const tags: string[] = [];
  const remotes = new Map<string, string[]>();
  // Each remote-tracking ref's commit, so a diverged branch is counted by hash, not name.
  const remoteHeads = new Map<string, string>();
  // Per remote: refs come sorted, and "backup/HEAD" would otherwise beat "origin/HEAD".
  const defaultBranches = new Map<string, string>();
  const diverged: { name: string; head: string; upstream: string }[] = [];
  const branchUpstreams: Record<string, BranchUpstream> = {};
  /** The local branches tracking each full upstream ref, for the default branch. */
  const trackers = new Map<string, string[]>();
  let headCommit: string | undefined;

  for (const line of result.stdout.split("\n")) {
    const [
      refname,
      symref = "",
      objectname = "",
      isHead = "",
      upstream = "",
      trackshort = "",
      upstreamRemote = "",
      upstreamRef = ""
    ] = line.trim().split("\0");
    if (!refname) {
      continue;
    }
    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      localBranches.push(name);
      // "." is a local upstream: nothing on a remote to push to or delete.
      if (upstreamRemote && upstreamRemote !== "." && upstreamRef.startsWith("refs/heads/")) {
        branchUpstreams[name] = { remote: upstreamRemote, branch: upstreamRef.slice("refs/heads/".length) };
      }
      if (upstream) {
        trackers.set(upstream, [...(trackers.get(upstream) ?? []), name]);
      }
      if (isHead === "*") {
        headCommit = objectname;
      }
      if (isHead !== "*" && upstream && trackshort && trackshort !== "=") {
        diverged.push({ name, head: objectname, upstream });
      }
      continue;
    }
    if (refname.startsWith("refs/tags/")) {
      tags.push(refname.slice("refs/tags/".length));
      continue;
    }
    remoteHeads.set(refname, objectname);
    const remoteRef = refname.slice("refs/remotes/".length);
    // A remote name may hold a "/" ("team/fork"): the longest known prefix wins; an unknown remote's
    // ref is cut at its first "/".
    const known = remoteNames.filter((name) => remoteRef.startsWith(`${name}/`));
    const separator = known.length > 0 ? Math.max(...known.map((name) => name.length)) : remoteRef.indexOf("/");
    // "origin/HEAD" only points at the default branch — not listed, but what it points at is what
    // "Update from ..." merges in.
    if (separator < 0 || remoteRef.endsWith("/HEAD")) {
      const remote = remoteRef.slice(0, separator);
      const prefix = `refs/remotes/${remote}/`;
      if (separator > 0 && symref.startsWith(prefix)) {
        defaultBranches.set(remote, symref.slice(prefix.length));
      }
      continue;
    }
    const remote = remoteRef.slice(0, separator);
    const branch = remoteRef.slice(separator + 1);
    const branches = remotes.get(remote);
    if (branches) {
      branches.push(branch);
    } else {
      remotes.set(remote, [branch]);
    }
  }

  const branchTrack: Record<string, { ahead: number; behind: number }> = {};
  await Promise.all(
    diverged
      .filter((entry) => remoteHeads.has(entry.upstream))
      .map(async (entry) => {
        const track = await readTrackCount(cwd, entry.head, remoteHeads.get(entry.upstream)!);
        if (track) {
          branchTrack[entry.name] = track;
        }
      })
  );

  return {
    localBranches,
    tags,
    defaultBranch: findDefaultBranch(defaultBranches, localBranches, trackers, remotes),
    branchTrack,
    branchUpstreams,
    headCommit,
    remotes: [...remotes].map(([name, branches]) => ({ name, branches }))
  };
}

/**
 * GitHub Desktop's `findDefaultBranch`, for the remote's HEAD branch: the local branch tracking it
 * (the one of the same name if several do), else the local branch of that name, else the remote
 * branch itself. `origin`'s HEAD first, else any remote's. Without a remote HEAD `Repository` falls
 * back to `init.defaultBranch`.
 */
function findDefaultBranch(
  defaultBranches: Map<string, string>,
  localBranches: string[],
  trackers: Map<string, string[]>,
  remotes: Map<string, string[]>
): CheckoutTarget | undefined {
  const remote = defaultBranches.has("origin") ? "origin" : defaultBranches.keys().next().value;
  if (remote === undefined) {
    return undefined;
  }
  const name = defaultBranches.get(remote)!;
  const tracking = trackers.get(`refs/remotes/${remote}/${name}`) ?? [];
  const local = tracking.includes(name) ? name : (tracking[0] ?? (localBranches.includes(name) ? name : undefined));
  if (local !== undefined) {
    return { name: local };
  }
  return remotes.get(remote)?.includes(name) ? { name, remote } : undefined;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function toChangeStatus(code: string): ChangeStatus {
  if (code === "??") {
    return "untracked";
  }
  if (CONFLICT_CODES.has(code)) {
    return "conflicted";
  }
  // Index status, then worktree status; the first non-space one describes the change.
  const letter = code[0] !== " " ? code[0] : code[1];
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "added";
    default:
      return "modified";
  }
}

/** The changed files and, from the `--branch` header, HEAD — in one git process. */
async function readStatus(cwd: string): Promise<HeadState & { changes: FileChange[] }> {
  // --no-optional-locks: otherwise `git status` writes its stat cache, the watcher reports it, and
  // the refresh runs this again — forever. Measured: a burst of events per run without the flag,
  // none with it, same runtime. core.quotePath=false: non-ASCII paths unescaped.
  const result = await git(cwd, [
    "--no-optional-locks",
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--branch"
  ]);

  // Thrown: an empty status would look like a clean repository.
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `git status exited with ${result.code}`);
  }

  const records = result.stdout.split("\0");
  // The header is always the first record.
  const header = records[0]?.startsWith("## ") ? records[0].slice(3) : "";
  return {
    ...(await readHead(cwd, header)),
    changes: readChanges(header ? records.slice(1) : records)
  };
}

function readChanges(entries: string[]): FileChange[] {
  const changes: FileChange[] = [];
  /** Each tracked entry's index in `changes`, the first where a path is listed twice. */
  const tracked = new Map<string, number>();
  const dropped = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    const status = toChangeStatus(code);
    if (status === "renamed" || code[0] === "C" || code[1] === "C") {
      // Renames and copies are two records: the new path, then the old one.
      const origPath = entries[++i];
      if (!tracked.has(filePath)) {
        tracked.set(filePath, changes.length);
      }
      changes.push({ path: filePath, status, origPath });
      continue;
    }
    if (status === "untracked") {
      // After `git rm --cached` a path is deleted in the index and untracked too; one row, the
      // untracked one, as in GitHub Desktop. Untracked entries come last, so the deleted one is in.
      const index = tracked.get(filePath);
      if (index !== undefined) {
        dropped.add(index);
        tracked.delete(filePath);
      }
    } else if (!tracked.has(filePath)) {
      tracked.set(filePath, changes.length);
    }
    changes.push({ path: filePath, status });
  }
  return dropped.size > 0 ? changes.filter((_change, index) => !dropped.has(index)) : changes;
}

interface GitDirs {
  gitDir: string;
  /** Where the worktrees are kept: a linked worktree's main `.git`, else `gitDir`. */
  commonDir: string;
}

/** Where this tree's git data lives: `.git`, or the directory a linked worktree's `.git` file names. */
function resolveGitDirs(cwd: string): GitDirs {
  const linked = readLinkedGitDir(cwd);
  const gitDir = linked?.gitDir ?? path.join(cwd, ".git");
  return { gitDir, commonDir: linked?.commonDir ?? gitDir };
}

/**
 * A merge or rebase stopped midway, for the "Abort" entry — three stats instead of a git process,
 * as GitHub Desktop reads it. */
async function readOperation(gitDir: string): Promise<GitOperation | undefined> {
  const exists = (name: string): Promise<boolean> =>
    fs.stat(path.join(gitDir, name)).then(
      () => true,
      () => false
    );
  // A rebase stopped at a conflict has both; the rebase is what must be aborted.
  if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) {
    return "rebase";
  }
  return (await exists("MERGE_HEAD")) ? "merge" : undefined;
}

/**
 * The worktrees, read off the common git directory as git keeps them — no `git worktree list` per
 * refresh: its `HEAD` for the main one, and per linked one under `worktrees/<id>` a `gitdir`
 * naming the worktree's `.git` (relative since `--relative-paths`) and its own `HEAD`.
 */
async function readWorktrees(cwd: string, { gitDir, commonDir }: GitDirs = resolveGitDirs(cwd)): Promise<WorktreeInfo[]> {
  const linkedRoot = path.join(commonDir, "worktrees");
  const ids = await fs.readdir(linkedRoot).catch(() => [] as string[]);
  const worktree = async (worktreePath: string, adminDir: string, main: boolean): Promise<WorktreeInfo> => {
    const head = await fs.readFile(path.join(adminDir, "HEAD"), "utf8").catch(() => "");
    const branch = /^ref: refs\/heads\/(.+?)\s*$/m.exec(head)?.[1];
    return {
      // On-disk spelling, which a project's path has (git's --show-toplevel); as named while it is gone.
      path: await fs.realpath(worktreePath).catch(() => worktreePath),
      branch,
      main,
      current: adminDir === gitDir
    };
  };
  const linked = await Promise.all(
    ids.map(async (id) => {
      const adminDir = path.join(linkedRoot, id);
      const pointer = await fs.readFile(path.join(adminDir, "gitdir"), "utf8").catch(() => undefined);
      return pointer === undefined ? undefined : worktree(path.dirname(path.resolve(adminDir, pointer.trim())), adminDir, false);
    })
  );
  // The main worktree holds the common directory — unless `cwd` is not a linked worktree: a
  // submodule's or a `--separate-git-dir` repository's lives elsewhere (`<super>/.git/modules/…`,
  // which `git worktree list` itself names, measured on 2.55), and its folder is `cwd`.
  const mainPath = gitDir === commonDir ? cwd : path.dirname(commonDir);
  return [
    await worktree(mainPath, commonDir, true),
    ...linked
      .filter((entry): entry is WorktreeInfo => entry !== undefined)
      // By branch: every worktree TET made is a folder named "files" (project-dirs.ts).
      .sort((a, b) => (a.branch ?? "").localeCompare(b.branch ?? "") || a.path.localeCompare(b.path))
  ];
}

/**
 * `init.defaultBranch`, else "main": GitHub Desktop's default branch where no remote names one. And
 * every `branch.<name>.base` tet recorded (worktreeAdd), by branch. One process for both, asked of
 * git, not parsed out of the config file: git owns that format. Off the refresh path — Repository
 * reads this on open, after a `.git/config` change, and after the actions that write a base.
 */
export async function readBranchConfig(
  cwd: string
): Promise<{ defaultBranchName: string; worktreeBases: Record<string, string> }> {
  const worktreeBases: Record<string, string> = {};
  let defaultBranchName = "";
  // Exit 1 where nothing matches, which `run` would turn into an error; the empty stdout is right,
  // as it is for a broken config. Keys come lowercased but for the branch name.
  const result = await git(cwd, ["config", "--get-regexp", "^(init\\.defaultbranch|branch\\..*\\.base)$"]).catch(
    () => undefined
  );
  for (const line of result?.stdout.split("\n") ?? []) {
    // The last one wins, as `--get` has it; a key without a value is an empty one.
    const initial = /^init\.defaultbranch(?: (.*))?$/.exec(line.trim());
    if (initial) {
      defaultBranchName = initial[1]?.trim() ?? "";
      continue;
    }
    // Greedy, so a branch named "x.base" keeps its dot: the last `.base` is the key's.
    const entry = /^branch\.(.+)\.base (.*)$/.exec(line.trim());
    if (entry) {
      worktreeBases[entry[1]] = entry[2];
    }
  }
  return { defaultBranchName: defaultBranchName || "main", worktreeBases };
}

/** Whether `git worktree remove` would refuse the worktree without `--force`: a change or an
 *  untracked file. Asked before its terminals close, never on the refresh path. */
export async function hasChanges(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["--no-optional-locks", "status", "--porcelain"]);
  return result.code !== 0 || result.stdout.trim() !== "";
}

/** `remoteNames`: the remotes as last read, which `for-each-ref` can't tell apart from the branch
 *  part of a remote-tracking ref (`readRefs`). */
export async function readState(cwd: string, remoteNames: string[] = []): Promise<RepositoryState> {
  try {
    // No `isRepository` check: Repository asks once on open, and the check costs a quarter of every
    // refresh where starting git is slow. The stash list is the third process, earned by being a
    // list the user acts on; anything added here has to earn its process too. All three run at
    // once, so no extra wall time. Operation and worktrees are file reads.
    const statusOf = readStatus(cwd);
    const refsOf = readRefs(cwd, remoteNames);
    const stashesOf = readStashes(cwd);
    // One resolution of the git directory for both file readers, synchronous and so read only once
    // the three git processes have started: it never delays one.
    const gitDirs = resolveGitDirs(cwd);
    const [status, refs, stashes, operation, worktrees] = await Promise.all([
      statusOf,
      refsOf,
      stashesOf,
      readOperation(gitDirs.gitDir),
      readWorktrees(cwd, gitDirs)
    ]);
    return { ...status, ...refs, stashes, operation, worktrees };
  } catch (error) {
    return { ...EMPTY_REPOSITORY_STATE, error: errorMessage(error) };
  }
}

/** One git command for the UI: a non-zero exit carries git's message, a failed start the error's. */
async function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<GitActionResult> {
  try {
    const result = await git(cwd, args, env, timeoutMs);
    if (result.code === 0) {
      return { ok: true };
    }
    // Without the "hint:" lines: terminal advice a notice has no room for.
    const message = (result.stderr || result.stdout)
      .split("\n")
      .filter((line) => !line.startsWith("hint:"))
      .join("\n")
      .trim();
    return { ok: false, error: message };
  } catch (error) {
    return failure(error);
  }
}

/** The env of every command reaching a remote. git must never ask for a password: there is no
 *  terminal, and a waiting command holds the repository's one action slot forever. Credentials come
 *  from the user's credential helper, else a login typed into tet (`NetworkLogin`), which git then
 *  stores in that helper itself; tet writes nothing into it. */
const NETWORK_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  // Set but empty: unset, git falls back to the terminal.
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  // Git Credential Manager ignores GIT_TERMINAL_PROMPT and waits on a window of its own (measured:
  // 86 s until killed, Windows, GCM 2.9). Told never to, it gives up at once, git fails for want of
  // a login and tet asks; a login that then works through askpass it still stores (measured).
  GCM_INTERACTIVE: "never",
  // A stalled connection is given up: below 1 KB/s for a minute, git's http transport aborts. The
  // ssh equivalent is in networkEnv.
  GIT_HTTP_LOW_SPEED_LIMIT: "1000",
  GIT_HTTP_LOW_SPEED_TIME: "60",
  // AUTH_FAILURES matches git's messages as text into `authRequired`, on which tet asks for a login,
  // and git translates them (LANG=de_DE: "Authentifizierung fehlgeschlagen").
  LC_ALL: "C"
};

/**
 * The messages meaning git stopped for want of credentials. No exit code says so (every fatal clone
 * error is 128), so the message is read, as GitHub Desktop does: `GIT_TERMINAL_PROMPT=0` produces
 * the first, a 401 or 403 the second. Not "repository not found": both hosts answer 404 for a
 * private one *and* for a typo.
 */
const AUTH_FAILURES = [/could not read (?:Username|Password)/i, /Authentication failed/i];

/** Drops the track-count cache for a working directory whose project closed; this process outlives it. */
export function forget(cwd: string): void {
  for (const key of trackCounts.keys()) {
    if (key.startsWith(`${cwd}\0`)) {
      trackCounts.delete(key);
    }
  }
}

/**
 * `NETWORK_ENV` plus an ssh that never asks (`-oBatchMode=yes`, e.g. about an unknown host key) and
 * never hangs: four unanswered keepalives 15 s apart end it, the minute http gets too. Only where
 * the user chose no ssh of their own: `GIT_SSH_COMMAND` outranks `GIT_SSH` and `core.sshCommand`, so
 * setting it blindly breaks a plink or `ssh -i work_key` setup; a non-OpenSSH program lacks the flag.
 * `core.sshCommand` is read per network command, not cached: the global config changes unwatched,
 * and a stale "none" would override the user's ssh. Off the refresh path, beside a remote round trip.
 */
async function networkEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  if (process.env.GIT_SSH || process.env.GIT_SSH_COMMAND) {
    return NETWORK_ENV;
  }
  const configured = await git(cwd, ["config", "--get", "core.sshCommand"]).then(
    (result) => (result.code === 0 ? result.stdout.trim() : ""),
    () => ""
  );
  return configured
    ? NETWORK_ENV
    : { ...NETWORK_ENV, GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oServerAliveInterval=15 -oServerAliveCountMax=4" };
}

/** A login typed into tet, or kept by it, for a command's http(s) remote; `askpassDir` is where
 *  the answering script goes (ensureAskpass). */
export interface NetworkLogin extends GitLogin {
  askpassDir: string;
  /** "https://host[:port]", the only origin askpass answers for (ASKPASS_SCRIPT). */
  origin: string;
}

interface NetworkOptions {
  login?: NetworkLogin;
  /** For a command nobody waits on (see `git`). */
  timeoutMs?: number;
}

/**
 * The login goes through askpass, which git asks only when no credential helper answered: the
 * user's own login still comes first. The helpers stay on, so git stores a login that worked in
 * the user's helper and erases one the host refused, as for any login typed at git's prompt.
 */
async function loginEnv(cwd: string, login?: NetworkLogin): Promise<NodeJS.ProcessEnv> {
  const askpass = login && {
    GIT_ASKPASS: await ensureAskpass(login.askpassDir),
    TET_ASKPASS_ORIGIN: login.origin,
    TET_ASKPASS_USER: login.username,
    TET_ASKPASS_TOKEN: login.password
  };
  return { ...(await networkEnv(cwd)), ...askpass };
}

async function runNetwork(cwd: string, args: string[], { login, timeoutMs }: NetworkOptions = {}): Promise<GitActionResult> {
  const result = await run(cwd, args, await loginEnv(cwd, login), timeoutMs);
  if (result.ok || !AUTH_FAILURES.some((pattern) => pattern.test(result.error ?? ""))) {
    return result;
  }
  return { ...result, authRequired: true };
}

/** `--prune`, like GitHub Desktop: a branch deleted on the remote leaves the tree. `remote` names
 *  the one whose login is given, else git's default. `timeoutMs` is for a fetch nobody waits on. */
export function fetch(cwd: string, remote?: string, login?: NetworkLogin, timeoutMs?: number): Promise<GitActionResult> {
  const args = remote === undefined ? ["fetch", "--prune"] : ["fetch", "--prune", "--", remote];
  return runNetwork(cwd, args, { login, timeoutMs });
}

/** `git pull`, so the user's configured merge or rebase applies — plus `--ff` where `pull.ff` is
 *  unset, as GitHub Desktop does: without it git refuses to pull into a diverged branch until told
 *  how to reconcile. */
export async function pull(cwd: string, login?: NetworkLogin): Promise<GitActionResult> {
  const pullFF = await git(cwd, ["config", "--get", "pull.ff"]);
  return runNetwork(cwd, pullFF.code === 0 ? ["pull"] : ["pull", "--ff"], { login });
}

/** Asks the remote for its HEAD branch again after a pull, as GitHub Desktop does: a clone's
 *  `<remote>/HEAD` never follows a changed default, and a remote added by hand has none. A failure
 *  only leaves the old one. */
export async function updateRemoteHead(cwd: string, remote: string, login?: NetworkLogin): Promise<void> {
  await runNetwork(cwd, ["remote", "set-head", "--auto", remote], { login });
}

/**
 * Moves every local branch that is only behind its upstream up to it, after a fetch or pull, as
 * GitHub Desktop does: "Update from" merges the local default branch, which would otherwise lag.
 * `fetch .` refuses anything but a fast-forward. A branch checked out in any worktree is left out,
 * since git refuses the whole fetch for one of them.
 */
export async function fastForwardBranches(cwd: string): Promise<void> {
  const refs = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(upstream)%00%(upstream:trackshort)%00%(worktreepath)",
    "refs/heads"
  ]);
  const refspecs = refs.stdout
    .split("\n")
    .map((line) => line.trim().split("\0"))
    .filter(([refname, upstream, trackshort, worktree]) => refname && upstream && trackshort === "<" && !worktree)
    .map(([refname, upstream]) => `${upstream}:${refname}`);
  if (refs.code === 0 && refspecs.length > 0) {
    await git(cwd, ["fetch", "--no-write-fetch-head", ".", ...refspecs], { GIT_REFLOG_ACTION: "pull" });
  }
}

/** Pushes the current branch to its upstream by name, as GitHub Desktop does, whatever `push.default`
 *  says; without an upstream it also sets tracking ("publish branch"). */
export function push(
  cwd: string,
  remote: string,
  branch: string,
  upstreamBranch: string | undefined,
  login?: NetworkLogin
): Promise<GitActionResult> {
  return runNetwork(
    cwd,
    upstreamBranch === undefined
      ? ["push", "--set-upstream", "--", remote, branch]
      : ["push", "--", remote, `${branch}:${upstreamBranch}`],
    { login }
  );
}

/** Clones into `directory`, which git creates with its parents, refusing a non-empty one. The cwd
 *  only anchors a relative path. */
export function clone(url: string, directory: string, login?: NetworkLogin): Promise<GitActionResult> {
  return runNetwork(os.homedir(), ["clone", "--", url, directory], { login });
}

/** Whether git has a credential helper for this url, which then keeps a login that worked; tet
 *  keeps it only where there is none (GitLoginStore). An empty value clears the list. */
export async function hasCredentialHelper(cwd: string, url: string): Promise<boolean> {
  const helper = await git(cwd, ["config", "--get-urlmatch", "credential.helper", url]);
  return helper.code === 0 && helper.stdout.trim() !== "";
}

/** `git init`, which creates the folder with its parents, like clone. */
export function init(directory: string): Promise<GitActionResult> {
  return run(os.homedir(), ["init", "--", directory]);
}

/**
 * A GIT_ASKPASS script answering from environment variables (VS Code's askpass.sh pattern). One sh
 * script everywhere: Git for Windows runs a non-exe askpass through its own sh. No secret in it.
 * git's question is `$1`: "Username for 'https://host': " or "Password for 'https://user@host': ",
 * the url with its path under `credential.useHttpPath`, and the host as the remote's url spells
 * it, while TET_ASKPASS_ORIGIN (urlOrigin) is lowercase without a default port. It answers only
 * for that origin: a
 * submodule, a pushurl or a redirect on another host gets nothing, and git fails there for want of
 * a login rather than being handed one for elsewhere.
 */
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  "url=${1#*\"'\"}",
  "url=${url%\"'\"*}",
  "host=${url#*://}",
  "host=${host%%/*}",
  "host=${host#*@}",
  "origin=$(printf '%s' \"${url%%://*}://$host\" | tr '[:upper:]' '[:lower:]')",
  "case \"$origin\" in https://*:443) origin=${origin%:443} ;; http://*:80) origin=${origin%:80} ;; esac",
  "[ \"$origin\" = \"$TET_ASKPASS_ORIGIN\" ] || exit 1",
  "case \"$1\" in",
  "Username*) printf '%s\\n' \"$TET_ASKPASS_USER\" ;;",
  "Password*) printf '%s\\n' \"$TET_ASKPASS_TOKEN\" ;;",
  "*) exit 1 ;;",
  "esac",
  ""
].join("\n");

/** The script in `dir` (tet's data folder), written when missing or from another tet — not on
 *  every call: on Windows a rename over the script while an sh reads it fails, and two commands
 *  reaching remotes at once (the periodic fetches) would race. Not the temp directory: git executes
 *  the script itself, which a `noexec` /tmp refuses (measured), and a long-running tet would find it
 *  cleaned away. */
export async function ensureAskpass(dir: string): Promise<string> {
  const file = path.join(dir, "askpass.sh");
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current !== ASKPASS_SCRIPT) {
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(file, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o755 });
  }
  return file;
}

/** A clone with a provider account's token, handed to git as a login. `credential.helper=`
 *  empties the helper list for this command: a stale login on the machine would otherwise answer
 *  first and 403, and the token is the account's to keep, not the helper's. */
export function cloneWithToken(
  url: string,
  directory: string,
  user: string,
  token: string,
  askpassDir: string
): Promise<GitActionResult> {
  return runNetwork(os.homedir(), ["-c", "credential.helper=", "clone", "--", url, directory], {
    login: { username: user, password: token, askpassDir, origin: urlOrigin(url) }
  });
}

/** Each remote's fetch url, keyed by remote name. */
export async function readRemoteUrls(cwd: string): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const result = await git(cwd, ["remote", "--verbose"]);
  if (result.code !== 0) {
    return urls;
  }
  for (const line of result.stdout.split("\n")) {
    // "origin\tgit@github.com:owner/repo.git (fetch)", and again for (push). A partial clone adds
    // its filter after the fetch line: " [blob:none]" (measured).
    const match = /^(\S+)\t(.+) \(fetch\)(?: \[[^\]]*\])?$/.exec(line.trim());
    if (match) {
      urls[match[1]] = match[2];
    }
  }
  return urls;
}

export function setRemoteUrl(cwd: string, remote: string, url: string): Promise<GitActionResult> {
  return run(cwd, ["remote", "set-url", "--", remote, url]);
}

/** Creates the branch and switches to it, as GitHub Desktop does: tracking nothing, since git would
 *  track a remote start point and a push would then go to that branch — the first push publishes. */
export function createBranch(cwd: string, name: string, startPoint: string): Promise<GitActionResult> {
  return run(cwd, ["switch", "--create", name, "--no-track", startPoint]);
}

/** A rename changing only case fails where refs are files on a case-insensitive filesystem: the old
 *  one "already exists". GitHub Desktop then forces it, unless a branch of exactly that name exists. */
export async function renameBranch(cwd: string, from: string, to: string): Promise<GitActionResult> {
  // `--`: a name starting with "-" is git's to refuse, not an option (`-f` would force the move).
  const moved = await run(cwd, ["branch", "--move", "--", from, to]);
  if (moved.ok || from === to || from.toLowerCase() !== to.toLowerCase()) {
    return moved;
  }
  const names = await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  const taken = names.stdout.split("\n").some((line) => line.trim() === `refs/heads/${to}`);
  return names.code !== 0 || taken ? moved : run(cwd, ["branch", "-M", "--", from, to]);
}

/** `--force`, like GitHub Desktop; the confirmation states the risk. */
export function deleteBranch(cwd: string, name: string): Promise<GitActionResult> {
  return run(cwd, ["branch", "--delete", "--force", name]);
}

/** A branch already gone from the remote only loses its remote-tracking ref, as in GitHub Desktop.
 *  Gone is `ls-remote --exit-code`'s 2 ("no matching refs"), asked only after the delete failed:
 *  the push's exit code is 1 for any refusal. */
export async function deleteRemoteBranch(
  cwd: string,
  remote: string,
  name: string,
  login?: NetworkLogin
): Promise<GitActionResult> {
  const deleted = await runNetwork(cwd, ["push", remote, "--delete", name], { login });
  if (deleted.ok || deleted.authRequired) {
    return deleted;
  }
  const listed = await git(cwd, ["ls-remote", "--exit-code", remote, `refs/heads/${name}`], await loginEnv(cwd, login));
  if (listed.code !== 2) {
    return deleted;
  }
  return run(cwd, ["update-ref", "-d", `refs/remotes/${remote}/${name}`]);
}

export function merge(cwd: string, ref: string): Promise<GitActionResult> {
  return run(cwd, ["merge", ref]);
}

export function rebase(cwd: string, ref: string): Promise<GitActionResult> {
  return run(cwd, ["rebase", ref]);
}

/** Whether rebasing HEAD onto `ref` rewrites commits its upstream already has, by GitHub Desktop's
 *  measure: the upstream holds commits `ref` lacks. False without an upstream. */
export async function rebaseRewritesPushed(cwd: string, ref: string): Promise<boolean> {
  const result = await git(cwd, ["rev-list", "--count", `${ref}..HEAD@{upstream}`]);
  return result.code === 0 && Number(result.stdout.trim()) > 0;
}

export function abortOperation(cwd: string, operation: GitOperation): Promise<GitActionResult> {
  return run(cwd, [operation, "--abort"]);
}

/** Always annotated, with an empty message too, as in GitHub Desktop. */
export function createTag(cwd: string, name: string, target: string, message: string): Promise<GitActionResult> {
  return run(cwd, ["tag", "--annotate", "--message", message, "--", name, target]);
}

export function pushTag(cwd: string, remote: string, name: string, login?: NetworkLogin): Promise<GitActionResult> {
  return runNetwork(cwd, ["push", remote, `refs/tags/${name}`], { login });
}

export function deleteTag(cwd: string, name: string): Promise<GitActionResult> {
  return run(cwd, ["tag", "--delete", name]);
}

export function deleteRemoteTag(
  cwd: string,
  remote: string,
  name: string,
  login?: NetworkLogin
): Promise<GitActionResult> {
  return runNetwork(cwd, ["push", remote, "--delete", `refs/tags/${name}`], { login });
}

export function checkoutTag(cwd: string, name: string): Promise<GitActionResult> {
  return run(cwd, ["switch", "--detach", `refs/tags/${name}`]);
}

/** `add --all` first: `commit --all` alone leaves out the untracked files the list shows. */
export async function commitAll(cwd: string, message: string): Promise<GitActionResult> {
  const added = await run(cwd, ["add", "--all"]);
  return added.ok ? run(cwd, ["commit", "--message", message]) : added;
}

/** The same for these files: `commit -- <paths>` takes their working-tree state regardless of what
 *  is staged, but only for paths git knows, so untracked ones are added first. Not `add --all --
 *  <paths>`: a rename's old path is in neither index nor tree, and `add` refuses it. */
export async function commitPaths(
  cwd: string,
  message: string,
  paths: string[],
  untracked: string[]
): Promise<GitActionResult> {
  if (untracked.length > 0) {
    const added = await run(cwd, [LITERAL_PATHSPECS, "add", "--", ...untracked]);
    if (!added.ok) {
      return added;
    }
  }
  return run(cwd, [LITERAL_PATHSPECS, "commit", "--message", message, "--", ...paths]);
}

/** For every command given paths from the changes list: otherwise git reads `*`, `?` and `[…]` as
 *  a pattern, and discarding `app/[id]/page.tsx` also resets `app/i/page.tsx`. */
const LITERAL_PATHSPECS = "--literal-pathspecs";

/** Enough subjects to read the repository's commit style off. */
const RECENT_SUBJECTS = 20;
/** The budget for diff plus untracked files in a commit-message question; the tail past it is cut
 *  and marked as cut. */
const MAX_COMMIT_CONTEXT = 128 * 1024;
/** Enough of an untracked file to see what it is; a new lockfile mustn't eat the budget. */
const MAX_UNTRACKED_CONTEXT = 16 * 1024;

function capped(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget).trimEnd()}\n[truncated]`;
}

/**
 * Everything an agent needs for a commit message up front: recent subjects for the style, and what
 * the commit would take — every change, or only `selection`. Three invocations plus a read per
 * untracked file, fine on a wand press. Measured with `claude -p`: running git itself, the agent
 * took several times as long, each status, diff and log a round trip. Without HEAD there are no
 * subjects and the diff is the staged one: a file added before the first commit is neither
 * untracked nor in a diff against HEAD.
 */
export async function readCommitContext(cwd: string, selection?: string[]): Promise<string> {
  const pathspec = selection ? ["--", ...selection] : [];
  const [subjects, againstHead, untracked] = await Promise.all([
    git(cwd, ["log", `-${RECENT_SUBJECTS}`, "--format=%s"]),
    git(cwd, [LITERAL_PATHSPECS, "diff", "HEAD", ...pathspec]),
    git(cwd, [LITERAL_PATHSPECS, "ls-files", "--others", "--exclude-standard", "-z", ...pathspec])
  ]);
  const diff = againstHead.code === 0 ? againstHead : await git(cwd, [LITERAL_PATHSPECS, "diff", "--cached", ...pathspec]);
  const sections: string[] = [];
  if (subjects.code === 0 && subjects.stdout.trim() !== "") {
    sections.push(`=== recent commit subjects ===\n${subjects.stdout.trim()}`);
  }
  let budget = MAX_COMMIT_CONTEXT;
  const tracked = diff.code === 0 ? capped(diff.stdout, budget) : "";
  if (tracked.trim() !== "") {
    budget -= tracked.length;
    sections.push(`=== ${diff === againstHead ? "diff against HEAD" : "staged diff, no commit yet"} ===\n${tracked.trimEnd()}`);
  }
  const paths = untracked.code === 0 ? untracked.stdout.split("\0").filter((entry) => entry !== "") : [];
  for (const relative of paths) {
    if (budget <= 0) {
      sections.push(`=== untracked: ${relative} ===\n[not read: the files above filled the budget]`);
      continue;
    }
    // A buffer, so a NUL byte marks a binary, which is only named: as text it is noise the agent
    // pays for.
    const content = await fs.readFile(path.join(cwd, relative)).catch(() => undefined);
    if (!content) {
      sections.push(`=== untracked: ${relative} ===\n[could not be read]`);
      continue;
    }
    if (content.includes(0)) {
      sections.push(`=== untracked: ${relative} ===\n[binary, ${content.length} bytes]`);
      continue;
    }
    const text = capped(content.toString("utf8"), Math.min(budget, MAX_UNTRACKED_CONTEXT));
    budget -= text.length;
    sections.push(`=== untracked: ${relative} ===\n${text.trimEnd()}`);
  }
  return sections.join("\n\n");
}

/** `--include-untracked`, so "stash all changes" covers the files the list shows. All only, as in
 *  GitHub Desktop: `stash push -- <paths>` mishandles a staged rename. */
export function stashPush(cwd: string, message: string): Promise<GitActionResult> {
  return run(cwd, ["stash", "push", "--include-untracked", ...(message ? ["--message", message] : [])]);
}

/** A stash command on the entry with this commit, its ref looked up now, as GitHub Desktop does: a
 *  stash made in a terminal since the last refresh renumbers the refs the list shows. */
export async function stash(cwd: string, command: StashCommand, sha: string): Promise<GitActionResult> {
  const found = (await readStashes(cwd)).find((entry) => entry.sha === sha);
  return found ? run(cwd, ["stash", command, found.ref]) : { ok: false, error: "The stash no longer exists" };
}

export async function checkout(cwd: string, target: CheckoutTarget, localBranches: string[]): Promise<GitActionResult> {
  // By name if a local branch of that name exists; otherwise create a tracking branch.
  if (target.remote === undefined || localBranches.includes(target.name)) {
    return run(cwd, ["switch", target.name]);
  }
  const tracked = await run(cwd, ["switch", "--track", refName(target)]);
  // The local branch may have appeared since the last refresh.
  return tracked.ok ? tracked : run(cwd, ["switch", target.name]);
}

/**
 * A worktree always with a new branch of its own at `base`, the default branch: tet couples the
 * two, so deleting one does the other, and the worktree is named by its branch. `--no-track`, as `createBranch`: the first push
 * publishes it. `--relative-paths` (git 2.48) links the two `.git`s relatively, so the link holds
 * in an sbx sandbox, where the paths differ from the host's on Windows (measured, git 2.53 in the
 * kits: status, commit and branch work with the main `.git` mounted). It sets
 * `extensions.relativeWorktrees` in the main repository's config.
 *
 * git keeps no branch's origin, so the base is recorded as `branch.<name>.base`, as superset does:
 * `branch -m` carries the key along and `branch -D` drops it. A failed write loses only that.
 */
export async function worktreeAdd(cwd: string, target: string, branch: string, base: CheckoutTarget): Promise<GitActionResult> {
  const added = await run(cwd, ["worktree", "add", "--relative-paths", "--no-track", "-b", branch, "--", target, refName(base)]);
  if (added.ok) {
    await git(cwd, ["config", `branch.${branch}.base`, base.name]).catch(() => undefined);
  }
  return added;
}

/** Without `force` git refuses a worktree with changes or untracked files; a locked one either way. */
export function worktreeRemove(cwd: string, target: string, force: boolean): Promise<GitActionResult> {
  return run(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), "--", target]);
}

/** Forgets worktrees whose folder is gone; until then git keeps their branches checked out. */
export function worktreePrune(cwd: string): Promise<GitActionResult> {
  return run(cwd, ["worktree", "prune"]);
}

async function readStashes(cwd: string): Promise<StashEntry[]> {
  // %gd is the ref the stash commands take ("stash@{0}"), %H the stash's commit, %gs the message.
  const result = await git(cwd, ["stash", "list", "--format=%gd%x00%H%x00%gs"]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.includes("\0"))
    .map((line) => {
      const [ref, sha, message] = line.split("\0");
      return { ref, sha, message };
    });
}

/**
 * Which of these paths HEAD has, for a discard: a conflict may be one side's addition, and a file
 * untracked by `git rm --cached` has HEAD's version to restore — the status tells neither. At
 * discard time only, never on the refresh path. `ls-tree` takes paths literally, never as globs.
 */
export async function readHeadPaths(cwd: string, paths: string[]): Promise<string[]> {
  const listed = await git(cwd, [LITERAL_PATHSPECS, "ls-tree", "-z", "--name-only", "HEAD", "--", ...paths]);
  if (listed.code === 0) {
    return listed.stdout.split("\0").filter((entry) => entry !== "");
  }
  // An unborn branch has nothing in HEAD. Asked only after the failure, so a repository with
  // commits pays one process.
  const born = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (born.code !== 0) {
    return [];
  }
  throw new Error(listed.stderr.trim() || `git ls-tree exited with ${listed.code}`);
}

export interface DiscardTargets {
  /** Paths in HEAD — index and worktree are restored from it, a conflict's stages included. */
  restore: string[];
  /** Paths not in HEAD, already trashed; this drops a staged addition's index entry, or a conflict's
   *  stages — `restore` refuses an unmerged path HEAD lacks. */
  drop: string[];
}

/** Throws away local changes. The caller trashes files HEAD lacks first (GitHub Desktop's rule) and
 *  hands over sorted targets. */
export async function discard(cwd: string, targets: DiscardTargets): Promise<GitActionResult> {
  if (targets.drop.length > 0) {
    // --ignore-unmatch: a never-staged path has no index entry, which is fine.
    const dropped = await run(cwd, [LITERAL_PATHSPECS, "rm", "--cached", "--force", "--ignore-unmatch", "--", ...targets.drop]);
    if (!dropped.ok) {
      return dropped;
    }
  }
  if (targets.restore.length === 0) {
    return { ok: true };
  }
  return run(cwd, [LITERAL_PATHSPECS, "restore", "--source=HEAD", "--staged", "--worktree", "--", ...targets.restore]);
}

/** Escapes what a gitignore line reads as syntax. */
function escapeIgnorePattern(pattern: string): string {
  return pattern.replace(/[\\!#*?[\]]/g, "\\$&");
}

/** Adds the file, or its extension, to .gitignore unless the rule is already there. Written in
 *  place: a temp file beside it would show up in the changes list this was started from. */
export async function ignorePath(cwd: string, filePath: string, scope: "file" | "extension"): Promise<GitActionResult> {
  const extension = path.extname(filePath);
  if (scope === "extension" && !extension) {
    return { ok: false, error: `${filePath} has no extension to ignore` };
  }
  const rule = scope === "file" ? escapeIgnorePattern(filePath) : `*${escapeIgnorePattern(extension)}`;

  const file = path.join(cwd, ".gitignore");
  try {
    const existing = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) {
      return { ok: true };
    }
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : newline;
    await fs.appendFile(file, `${separator}${rule}${newline}`, "utf8");
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

interface HeadBlobOptions {
  /** A rename's source path — the one HEAD has. */
  origPath?: string;
  /** Past this the blob counts as binary: the editor's own cap, since both sides share the editor. */
  maxBytes: number;
}

/**
 * HEAD's version of a file, the diff editor's original side. A path HEAD lacks (untracked, newly
 * added, unborn branch) is `missing`, not an error: it diffs as all new.
 *
 * `cat-file --filters`, not `show`: it applies the smudge filters and eol conversion of
 * `.gitattributes` and `core.autocrlf`, so the text reads like the working tree. `show` returns the
 * stored blob, which under an LFS or `ident` filter is not the file (pinned in `git.test.ts`).
 * Buffer encoding, as in `readFile`: utf8 replaces invalid bytes and would break an image.
 */
export async function readHeadBlob(cwd: string, filePath: string, options: HeadBlobOptions): Promise<HeadBlob> {
  // A rename is one entry over two paths, and only the old one is in HEAD.
  const at = (options.origPath ?? filePath).replace(/\\/g, "/");
  const read = await new Promise<{ blob: Buffer | null; tooLarge: boolean }>((resolve) => {
    execFile(
      "git",
      ["cat-file", "--filters", `HEAD:${at}`],
      {
        cwd,
        // One byte over the cap: node kills the child with its own error code, which tells a blob
        // too large from one HEAD lacks.
        maxBuffer: options.maxBytes + 1,
        windowsHide: true,
        encoding: "buffer",
        // `--filters` runs the repository's smudge filter, and an LFS one fetches: never ask for
        // credentials without a terminal.
        env: { ...process.env, ...NETWORK_ENV }
      },
      (error, stdout) =>
        resolve({
          blob: error ? null : stdout,
          tooLarge: (error as NodeJS.ErrnoException | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        })
    );
  });
  // Too large, an image, or a NUL byte: no text side, and the editor tab says so.
  if (read.tooLarge) {
    return { content: "", binary: true, missing: false };
  }
  if (read.blob === null) {
    return { content: "", binary: false, missing: true };
  }
  if (isImage(at)) {
    return { content: "", binary: true, missing: false, image: toDataUrl(at, read.blob) };
  }
  if (read.blob.includes(0)) {
    return { content: "", binary: true, missing: false };
  }
  return { content: read.blob.toString("utf8"), binary: false, missing: false };
}

/** Every path the exclude chain hides, repository-relative with forward slashes; `--directory`
 *  collapses an ignored directory to one entry with a trailing `/`, so the walk can skip it. */
export async function listIgnored(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout.split("\0").filter((entry) => entry !== "");
}
