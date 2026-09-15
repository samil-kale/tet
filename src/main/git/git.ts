import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { EMPTY_REPOSITORY_STATE } from "../../shared/types";
import type {
  CheckoutTarget,
  ChangeStatus,
  FileChange,
  GitActionResult,
  GitOperation,
  HeadBlob,
  RemoteInfo,
  RepositoryState,
  StashEntry
} from "../../shared/types";

const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
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

/** Whether the git CLI can be started. Runs in the temp directory, which exists everywhere. */
export async function isAvailable(): Promise<boolean> {
  try {
    const result = await git(os.tmpdir(), ["--version"]);
    return result.code === 0;
  } catch {
    return false;
  }
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
  defaultBranch?: string;
  branchTrack: Record<string, { ahead: number; behind: number }>;
  headCommit?: string;
}> {
  // Full ref names, not %(refname:short): that shortens "refs/remotes/origin/HEAD" to "origin", like
  // a branch of that name. %(symref) is set only on "<remote>/HEAD", naming the default branch.
  const result = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(symref)%00%(objectname)%00%(HEAD)%00%(upstream)%00%(upstream:trackshort)",
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
  let headCommit: string | undefined;

  for (const line of result.stdout.split("\n")) {
    const [refname, symref = "", objectname = "", isHead = "", upstream = "", trackshort = ""] = line
      .trim()
      .split("\0");
    if (!refname) {
      continue;
    }
    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      localBranches.push(name);
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
    defaultBranch: defaultBranches.get("origin") ?? defaultBranches.values().next().value,
    branchTrack,
    headCommit,
    remotes: [...remotes].map(([name, branches]) => ({ name, branches }))
  };
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
      changes.push({ path: filePath, status, origPath });
      continue;
    }
    changes.push({ path: filePath, status });
  }
  return changes;
}

/** Where this tree's git data lives: `.git`, or the directory a linked worktree's `.git` file names. */
async function resolveGitDir(cwd: string): Promise<string> {
  const dotGit = path.join(cwd, ".git");
  const stat = await fs.stat(dotGit).catch(() => undefined);
  if (stat?.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, "utf8").catch(() => ""));
    if (pointer) {
      return path.resolve(cwd, pointer[1].trim());
    }
  }
  return dotGit;
}

/**
 * A merge or rebase stopped midway, for the "Abort" entry — three stats instead of a git process,
 * as GitHub Desktop reads it. */
async function readOperation(cwd: string): Promise<GitOperation | undefined> {
  const gitDir = await resolveGitDir(cwd);
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

/** `remoteNames`: the remotes as last read, which `for-each-ref` can't tell apart from the branch
 *  part of a remote-tracking ref (`readRefs`). */
export async function readState(cwd: string, remoteNames: string[] = []): Promise<RepositoryState> {
  try {
    // No `isRepository` check: Repository asks once on open, and the check costs a quarter of every
    // refresh where starting git is slow. The stash list is the third process, earned by being a
    // list the user acts on; anything added here has to earn its process too. All three run at
    // once, so no extra wall time.
    const [status, refs, stashes, operation] = await Promise.all([
      readStatus(cwd),
      readRefs(cwd, remoteNames),
      readStashes(cwd),
      readOperation(cwd)
    ]);
    return { ...status, ...refs, stashes, operation };
  } catch (error) {
    return { ...EMPTY_REPOSITORY_STATE, error: error instanceof Error ? error.message : String(error) };
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
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The env of every command reaching a remote. git must never ask for a password: there is no
 *  terminal, and a waiting command holds the repository's one action slot forever. Credentials come
 *  from the user's credential helper or a provider token; tet writes nothing into that helper. */
const NETWORK_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  // Set but empty: unset, git falls back to the terminal.
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  // A stalled connection is given up: below 1 KB/s for a minute, git's http transport aborts. The
  // ssh equivalent is in networkEnv.
  GIT_HTTP_LOW_SPEED_LIMIT: "1000",
  GIT_HTTP_LOW_SPEED_TIME: "60",
  // AUTH_FAILURES matches git's messages as text into `authRequired`, the one thing the add-repository
  // dialog's CloneAuth acts on, and git translates them (LANG=de_DE: "Authentifizierung fehlgeschlagen").
  LC_ALL: "C"
};

/**
 * The messages meaning git stopped for want of credentials. No exit code says so (every fatal clone
 * error is 128), so the message is read, as GitHub Desktop does: `GIT_TERMINAL_PROMPT=0` produces
 * the first, a 401 or 403 the second. Not "repository not found": both hosts answer 404 for a
 * private one *and* for a typo.
 */
const AUTH_FAILURES = [/could not read (?:Username|Password)/i, /Authentication failed/i];

/** `core.sshCommand` per working directory, read once rather than a process per network command. */
const sshCommands = new Map<string, Promise<string>>();

/** Drops both caches for a working directory whose project closed; this process outlives them. */
export function forget(cwd: string): void {
  sshCommands.delete(cwd);
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
 */
async function networkEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  if (process.env.GIT_SSH || process.env.GIT_SSH_COMMAND) {
    return NETWORK_ENV;
  }
  let configured = sshCommands.get(cwd);
  if (!configured) {
    configured = git(cwd, ["config", "--get", "core.sshCommand"]).then(
      (result) => (result.code === 0 ? result.stdout.trim() : ""),
      () => ""
    );
    sshCommands.set(cwd, configured);
  }
  return (await configured)
    ? NETWORK_ENV
    : { ...NETWORK_ENV, GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oServerAliveInterval=15 -oServerAliveCountMax=4" };
}

async function runNetwork(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number
): Promise<GitActionResult> {
  const result = await run(cwd, args, { ...(await networkEnv(cwd)), ...env }, timeoutMs);
  if (result.ok || !AUTH_FAILURES.some((pattern) => pattern.test(result.error ?? ""))) {
    return result;
  }
  return { ...result, authRequired: true };
}

/** `--prune`, like GitHub Desktop: a branch deleted on the remote leaves the tree. `timeoutMs` is for
 *  a fetch nobody waits on (see `git`). */
export function fetch(cwd: string, timeoutMs?: number): Promise<GitActionResult> {
  return runNetwork(cwd, ["fetch", "--prune"], undefined, timeoutMs);
}

/** Plain `git pull`, so the user's configured merge or rebase applies. */
export function pull(cwd: string): Promise<GitActionResult> {
  return runNetwork(cwd, ["pull"]);
}

/** Pushes the current branch; without an upstream it also sets tracking ("publish branch"). */
export function push(cwd: string, remote: string, branch: string, setUpstream: boolean): Promise<GitActionResult> {
  return runNetwork(cwd, setUpstream ? ["push", "--set-upstream", remote, branch] : ["push"]);
}

/** Clones into `directory`, which git creates with its parents, refusing a non-empty one. The cwd
 *  only anchors a relative path. */
export function clone(url: string, directory: string): Promise<GitActionResult> {
  return runNetwork(os.homedir(), ["clone", "--", url, directory]);
}

/** `git init`, which creates the folder with its parents, like clone. */
export function init(directory: string): Promise<GitActionResult> {
  return run(os.homedir(), ["init", "--", directory]);
}

/**
 * A GIT_ASKPASS script answering from two environment variables (VS Code's askpass.sh pattern). One
 * sh script everywhere: Git for Windows runs a non-exe askpass through its own sh. No secret in it.
 */
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  'case "$1" in',
  '*sername*) printf \'%s\\n\' "$TET_ASKPASS_USER" ;;',
  '*) printf \'%s\\n\' "$TET_ASKPASS_TOKEN" ;;',
  "esac",
  ""
].join("\n");

let askpassPath: Promise<string> | undefined;

/** Written once per process into its own directory: a fixed name under a shared /tmp may belong to
 *  another user, failing the rename. */
function ensureAskpass(): Promise<string> {
  askpassPath ??= (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tet-askpass-"));
    const file = path.join(dir, "askpass.sh");
    await writeFileAtomic(file, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o755 });
    return file;
  })().catch((error: unknown) => {
    askpassPath = undefined;
    throw error;
  });
  return askpassPath;
}

/** A clone with a provider account's token. `credential.helper=` empties the helper list for this
 *  command: a stale login on the machine would otherwise answer first and 403. */
export async function cloneWithToken(
  url: string,
  directory: string,
  user: string,
  token: string
): Promise<GitActionResult> {
  const askpass = await ensureAskpass();
  return runNetwork(os.homedir(), ["-c", "credential.helper=", "clone", "--", url, directory], {
    GIT_ASKPASS: askpass,
    TET_ASKPASS_USER: user,
    TET_ASKPASS_TOKEN: token
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
    // "origin\tgit@github.com:owner/repo.git (fetch)", and again for (push).
    const match = /^(\S+)\t(.+) \(fetch\)$/.exec(line.trim());
    if (match) {
      urls[match[1]] = match[2];
    }
  }
  return urls;
}

export function setRemoteUrl(cwd: string, remote: string, url: string): Promise<GitActionResult> {
  return run(cwd, ["remote", "set-url", remote, url]);
}

/** Creates the branch and switches to it, as GitHub Desktop does. */
export function createBranch(cwd: string, name: string, startPoint: string): Promise<GitActionResult> {
  return run(cwd, ["switch", "--create", name, startPoint]);
}

export function renameBranch(cwd: string, from: string, to: string): Promise<GitActionResult> {
  return run(cwd, ["branch", "--move", from, to]);
}

/** `--force`, like GitHub Desktop; the confirmation states the risk. */
export function deleteBranch(cwd: string, name: string): Promise<GitActionResult> {
  return run(cwd, ["branch", "--delete", "--force", name]);
}

export function deleteRemoteBranch(cwd: string, remote: string, name: string): Promise<GitActionResult> {
  return runNetwork(cwd, ["push", remote, "--delete", name]);
}

export function merge(cwd: string, ref: string): Promise<GitActionResult> {
  return run(cwd, ["merge", ref]);
}

export function rebase(cwd: string, ref: string): Promise<GitActionResult> {
  return run(cwd, ["rebase", ref]);
}

export function abortOperation(cwd: string, operation: GitOperation): Promise<GitActionResult> {
  return run(cwd, [operation, "--abort"]);
}

/** Annotated with a message, lightweight without. */
export function createTag(cwd: string, name: string, target: string, message: string): Promise<GitActionResult> {
  const args = message ? ["tag", "--annotate", "--message", message] : ["tag"];
  return run(cwd, [...args, name, target]);
}

export function pushTag(cwd: string, remote: string, name: string): Promise<GitActionResult> {
  return runNetwork(cwd, ["push", remote, `refs/tags/${name}`]);
}

export function deleteTag(cwd: string, name: string): Promise<GitActionResult> {
  return run(cwd, ["tag", "--delete", name]);
}

export function deleteRemoteTag(cwd: string, remote: string, name: string): Promise<GitActionResult> {
  return runNetwork(cwd, ["push", remote, "--delete", `refs/tags/${name}`]);
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

export function stashApply(cwd: string, ref: string): Promise<GitActionResult> {
  return run(cwd, ["stash", "apply", ref]);
}

export function stashPop(cwd: string, ref: string): Promise<GitActionResult> {
  return run(cwd, ["stash", "pop", ref]);
}

export function stashDrop(cwd: string, ref: string): Promise<GitActionResult> {
  return run(cwd, ["stash", "drop", ref]);
}

export async function checkout(cwd: string, target: CheckoutTarget, localBranches: string[]): Promise<GitActionResult> {
  // By name if a local branch of that name exists; otherwise create a tracking branch.
  if (target.remote === undefined || localBranches.includes(target.name)) {
    return run(cwd, ["switch", target.name]);
  }
  const tracked = await run(cwd, ["switch", "--track", `${target.remote}/${target.name}`]);
  // The local branch may have appeared since the last refresh.
  return tracked.ok ? tracked : run(cwd, ["switch", target.name]);
}

async function readStashes(cwd: string): Promise<StashEntry[]> {
  // %gd is the ref the other commands take ("stash@{0}"), %gs the message.
  const result = await git(cwd, ["stash", "list", "--format=%gd%x00%gs"]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.includes("\0"))
    .map((line) => {
      const [ref, message] = line.split("\0");
      return { ref, message };
    });
}

export interface DiscardTargets {
  /** Paths in HEAD — index and worktree are restored from it. */
  restore: string[];
  /** Paths not in HEAD, already trashed; this drops a staged addition's index entry. */
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
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Shown as images instead of "binary file". SVG stays text on purpose. */
const IMAGE_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

function imageType(filePath: string): string | undefined {
  return IMAGE_TYPES[path.extname(filePath).slice(1).toLowerCase()];
}

/** Also used by `Repository.readFile` to tell an image from any other binary. */
export function isImage(filePath: string): boolean {
  return imageType(filePath) !== undefined;
}

/** One version of an image, or undefined for an empty file. No size cap of its own: both callers
 *  already apply the editor's, and a second number would go stale. */
export function toDataUrl(filePath: string, content: Buffer): string | undefined {
  return content.length > 0 ? `data:${imageType(filePath)};base64,${content.toString("base64")}` : undefined;
}

export interface HeadBlobOptions {
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
