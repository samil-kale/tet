import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EMPTY_REPOSITORY_STATE } from "../../shared/types";
import type {
  CheckoutTarget,
  ChangeStatus,
  DiffLine,
  DiffOptions,
  FileChange,
  FileDiff,
  GitActionResult,
  GitOperation,
  ImageDiff,
  RemoteInfo,
  RepositoryState,
  StashEntry
} from "../../shared/types";

const MAX_BUFFER = 64 * 1024 * 1024;
/** Rendering a whole huge diff would stall the renderer; the viewer shows a hint instead. */
const MAX_DIFF_LINES = 5000;
/** Untracked files are read to synthesise their diff — do not pull a huge file into memory. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs the local git CLI. Resolves for any exit code (callers decide what a non-zero one
 * means) and rejects only when git itself could not be started.
 */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8", env: env && { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new Error(`git could not be started (${error.code ?? error.message})`));
          return;
        }
        resolve({ stdout, stderr, code: error ? Number(error.code) : 0 });
      }
    );
  });
}

/**
 * Whether the git CLI can be started at all — everything else in here takes that for granted.
 * Run from the temp directory: the one folder that exists everywhere and is no repository's
 * business.
 */
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

/**
 * The repository root of `cwd`, or undefined when it is not inside one. A picked folder may be
 * a subdirectory, and every path git reports is relative to the root — so the root is what the
 * project works against.
 */
export async function resolveRoot(cwd: string): Promise<string | undefined> {
  try {
    const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    return result.code === 0 && root ? path.normalize(root) : undefined;
  } catch {
    return undefined;
  }
}

/** What the status header says about HEAD, on top of the changed files it precedes. */
type HeadState = Pick<RepositoryState, "head" | "detached" | "upstream" | "ahead" | "behind">;

/**
 * What `--branch` puts in front of the status output: the current branch, its upstream, and
 * how far the two have drifted. Read from there rather than from a `rev-parse` and a
 * `rev-list` of their own — one process instead of three.
 *
 * Only a detached HEAD needs a second call: the header names no ref then, and the UI has to
 * show a commit id instead.
 */
async function readHead(cwd: string, header: string): Promise<HeadState> {
  const base = { upstream: undefined, ahead: 0, behind: 0 };
  if (header === "HEAD (no branch)") {
    const short = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    return { ...base, head: short.stdout.trim() || "HEAD", detached: true };
  }
  // Unborn branch (a fresh repository without commits): HEAD points at a ref that does not
  // exist yet, and git says so in words. The wording changed in 2.16; both are accepted.
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(header);
  if (unborn) {
    return { ...base, head: unborn[1], detached: false };
  }
  // "<branch>...<upstream> [ahead 1, behind 2]" when it tracks one, plain "<branch>" when it
  // does not. A branch name holds neither "..." nor a space, so the first field is the name.
  const [name, rest] = header.split("...");
  const tracking = /^(\S+)(?: \[(.*)\])?$/.exec(rest ?? "");
  const divergence = tracking?.[2] ?? "";
  return {
    head: name.split(" ")[0] || "HEAD",
    detached: false,
    // "[gone]" is an upstream the remote no longer has; there is nothing to compare against,
    // so it counts as none at all.
    upstream: tracking && divergence !== "gone" ? tracking[1] : undefined,
    ahead: Number(/ahead (\d+)/.exec(divergence)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(divergence)?.[1] ?? 0)
  };
}

/**
 * Ahead/behind for one local branch against its upstream, as two counts rather than sourcegit's
 * commit-hash lists — this tree has no commit graph to hand them to, so `--count` turns
 * `rev-list --left-right` into the two numbers the row wants instead of lines to parse.
 */
/**
 * Remembered per commit pair: two hashes name two fixed histories, so their count can never
 * change — and readRefs runs on every refresh, which would otherwise spend one process per
 * diverged branch each time. Only a successful count is kept.
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
 * Every ref the tree shows, from one `for-each-ref`. Tags ride along with the branches rather
 * than costing a `git tag` of their own — the same process either way.
 *
 * `%(upstream:trackshort)` rides along too: "=" or empty costs nothing more, but a local branch
 * it reports as differing gets a `rev-list --left-right --count` of its own so the tree can show
 * the actual numbers — sourcegit's own filter, applied here before a process is spent rather
 * than after. The checked-out branch is skipped: `readHead` already gets its ahead/behind for
 * free from the status header, a second count for the same branch would just repeat it. And a
 * branch whose upstream is configured but no longer exists among these refs (deleted on the
 * remote, "[gone]" from status's own point of view) is skipped too — nothing to diff against.
 */
async function readRefs(
  cwd: string
): Promise<{
  localBranches: string[];
  remotes: RemoteInfo[];
  tags: string[];
  defaultBranch?: string;
  branchTrack: Record<string, { ahead: number; behind: number }>;
}> {
  // Full ref names, not %(refname:short): git shortens "refs/remotes/origin/HEAD" to plain
  // "origin", which cannot be told apart from a branch named after its remote. %(symref) is
  // empty for everything but "<remote>/HEAD", where it names the remote's default branch.
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
  // Every remote-tracking ref's own commit, so a diverged local branch can be diffed against it
  // by hash rather than by name — the same ref could in principle also be a tag.
  const remoteHeads = new Map<string, string>();
  // Per remote, since the refs come sorted and "backup/HEAD" would otherwise beat "origin/HEAD".
  const defaultBranches = new Map<string, string>();
  const diverged: { name: string; head: string; upstream: string }[] = [];

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
    // "origin/HEAD" is a symbolic pointer at the remote's default branch, not a branch of its
    // own — listing it would duplicate an entry that is already there. What it points at is
    // worth keeping: the branch "Update from ..." merges in.
    const separator = remoteRef.indexOf("/");
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
  // Index status first, worktree status second; the first non-space one describes the change.
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

/** The changed files and, from the `--branch` header, what HEAD is — in one git process. */
async function readStatus(cwd: string): Promise<HeadState & { changes: FileChange[] }> {
  // --no-optional-locks: without it `git status` takes the index lock to write its refreshed
  // stat cache back, the watcher reports that write as a change, and the refresh it schedules
  // runs this again — forever. Measured: 50 filesystem events per run without the flag, 0 with
  // it, same runtime. It costs a stale index being re-stated by every status instead of read
  // from the cache once.
  // core.quotePath=false keeps non-ASCII paths readable instead of octal-escaped.
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

  // Thrown rather than read as an empty status: `readState` turns it into an error the branch
  // bar reports, where a blank result would have looked like a repository with nothing in it.
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `git status exited with ${result.code}`);
  }

  const records = result.stdout.split("\0");
  // The header is one record like any other, and always the first one.
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

/**
 * Where this working tree's git data lives. Usually `.git`, but a linked worktree has a *file*
 * there pointing at the directory that holds its own HEAD and its own half-finished merges.
 */
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
 * A merge or rebase git stopped in the middle of, which is what the "Abort" entry needs. Read
 * off the filesystem the way GitHub Desktop reads it rather than from a command of its own:
 * three stats of a directory that is in the page cache anyway, and no git process.
 */
async function readOperation(cwd: string): Promise<GitOperation | undefined> {
  const gitDir = await resolveGitDir(cwd);
  const exists = (name: string): Promise<boolean> =>
    fs.stat(path.join(gitDir, name)).then(
      () => true,
      () => false
    );
  // A rebase that stopped at a conflict has both, and it is the rebase that has to be aborted.
  if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) {
    return "rebase";
  }
  return (await exists("MERGE_HEAD")) ? "merge" : undefined;
}

export async function readState(cwd: string): Promise<RepositoryState> {
  try {
    // No `isRepository` check here: a folder does not stop being a repository, so Repository
    // asks once when it opens. Where starting git is slow, dropping it took a quarter off
    // every refresh.
    //
    // The stash list is the third process a refresh spends, and earns it by being a list the
    // user acts on: one updating only when something else happened would offer to pop a stash
    // that is no longer there. All three run at once, so it costs no extra wall time.
    const [status, refs, stashes, operation] = await Promise.all([
      readStatus(cwd),
      readRefs(cwd),
      readStashes(cwd),
      readOperation(cwd)
    ]);
    return { ...status, ...refs, stashes, operation };
  } catch (error) {
    return { ...EMPTY_REPOSITORY_STATE, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One git command, reported the way the UI wants it: a non-zero exit is the command's own
 * message, and a git that could not be started is the thrown error's.
 */
async function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitActionResult> {
  try {
    const result = await git(cwd, args, env);
    if (result.code === 0) {
      return { ok: true };
    }
    // Without the "hint:" block: a pull hitting diverged branches or a conflict answers with
    // eight lines of advice about what to type next in a terminal. What went wrong is in the
    // lines above it, and that is what a notice has room for.
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

/**
 * What every command that reaches a remote runs with. git must never stop to ask for a
 * password here: there is no terminal it could ask in, and a command waiting for an answer
 * that cannot come would hold this repository's one action slot open forever.
 */
const NETWORK_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  // Set but empty: git falls back to the terminal when it is unset, which is the very thing
  // the line above is trying to prevent.
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  // git translates its own messages, and the two below are matched as text. Pinned to C, or a
  // machine with LANG=de_DE answers "Authentifizierung fehlgeschlagen" and matches neither.
  LC_ALL: "C"
};

/**
 * The two messages that mean git stopped for want of credentials. There is no exit code for
 * it — every fatal error of a clone is 128 — so this reads the message, the way GitHub Desktop
 * maps git's stderr onto its own error codes. Both are git's own and read the same whatever
 * host answered: `GIT_TERMINAL_PROMPT=0` above produces the first (asking for the password
 * alone when the url already carries a user), a 401 or 403 the second.
 *
 * A repository git could not find is deliberately not in here: GitHub and GitLab answer 404
 * for a private repository *and* for a typo, so credentials would be a guess.
 */
const AUTH_FAILURES = [/could not read (?:Username|Password)/i, /Authentication failed/i];

/**
 * `core.sshCommand`, remembered per working directory: a setting that changes about never,
 * read once so no network command spends a second process on it.
 */
const sshCommands = new Map<string, Promise<string>>();

/**
 * `NETWORK_ENV` plus an ssh that never asks — `-oBatchMode=yes` keeps a host key ssh has never
 * seen from turning into a question nobody can answer. Only where the user has not chosen an
 * ssh of their own: `GIT_SSH_COMMAND` outranks both `GIT_SSH` and `core.sshCommand`, so setting
 * it blindly turned a working plink or `ssh -i work_key` setup into "Permission denied" for
 * every command from here — and a program that is not OpenSSH would not know the flag anyway.
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
  return (await configured) ? NETWORK_ENV : { ...NETWORK_ENV, GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };
}

async function runNetwork(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitActionResult> {
  const result = await run(cwd, args, { ...(await networkEnv(cwd)), ...env });
  if (result.ok || !AUTH_FAILURES.some((pattern) => pattern.test(result.error ?? ""))) {
    return result;
  }
  return { ...result, authRequired: true };
}

/** `--prune`, like GitHub Desktop: a branch deleted on the remote goes from the tree too. */
export function fetch(cwd: string): Promise<GitActionResult> {
  return runNetwork(cwd, ["fetch", "--prune"]);
}

/** Plain `git pull`, so whatever the user configured — merge or rebase — is what happens. */
export function pull(cwd: string): Promise<GitActionResult> {
  return runNetwork(cwd, ["pull"]);
}

/**
 * Pushes the current branch. Without an upstream this is GitHub Desktop's "publish branch":
 * the same command, plus the tracking configuration that makes every later push a plain one.
 */
export function push(cwd: string, remote: string, branch: string, setUpstream: boolean): Promise<GitActionResult> {
  return runNetwork(cwd, setUpstream ? ["push", "--set-upstream", remote, branch] : ["push"]);
}

/**
 * Clones into `directory`, which git creates itself — leading folders included — and refuses
 * when it exists and is not empty, with a message that says so. The cwd only anchors a
 * relative path, and the home directory always exists.
 */
export function clone(url: string, directory: string): Promise<GitActionResult> {
  return runNetwork(os.homedir(), ["clone", "--", url, directory]);
}

/** `git init`, which creates the folder — leading folders included — like clone does. */
export function init(directory: string): Promise<GitActionResult> {
  return run(os.homedir(), ["init", "--", directory]);
}

/**
 * A GIT_ASKPASS script answering with what two environment variables hold — VS Code's
 * askpass.sh pattern, and like there the same sh script on every platform: Git for Windows
 * runs a non-exe askpass through its own sh. The script holds no secret, only the environment
 * of the one command using it does; LF and a temp+rename write, since another process reads it.
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

/**
 * Written once per process, into a directory of its own: a fixed name under a shared /tmp can
 * already belong to another user, and the rename then fails — for good, were that rejection
 * kept.
 */
function ensureAskpass(): Promise<string> {
  askpassPath ??= (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tet-askpass-"));
    const file = path.join(dir, "askpass.sh");
    const temp = `${file}.${process.pid}`;
    await fs.writeFile(temp, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o755 });
    await fs.rename(temp, file);
    return file;
  })().catch((error: unknown) => {
    askpassPath = undefined;
    throw error;
  });
  return askpassPath;
}

/**
 * A clone authenticated by a provider account's token, for the remote tab — where the user
 * just browsed the repository with that token, so the clone must not depend on a credential
 * helper knowing the host too. `credential.helper=` empties the helper list for this one
 * command: a stale login stored on the machine would otherwise answer first and 403.
 */
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
    // "origin\tgit@github.com:owner/repo.git (fetch)", and the same again for (push).
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

/** Creates the branch and switches to it, which is what GitHub Desktop's dialog does too. */
export function createBranch(cwd: string, name: string, startPoint: string): Promise<GitActionResult> {
  return run(cwd, ["switch", "--create", name, startPoint]);
}

export function renameBranch(cwd: string, from: string, to: string): Promise<GitActionResult> {
  return run(cwd, ["branch", "--move", from, to]);
}

/**
 * `--force`, like GitHub Desktop: a branch whose commits are not merged anywhere would
 * otherwise be refused with a message about a state the user cannot see here. The confirmation
 * says out loud what that risks.
 */
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

/** Puts the working tree back the way it was before the merge or rebase started. */
export function abortOperation(cwd: string, operation: GitOperation): Promise<GitActionResult> {
  return run(cwd, [operation, "--abort"]);
}

/** An annotated tag when there is a message for it, a lightweight one when there is not. */
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

/** A tag names a commit, not a branch, so checking one out is a detached HEAD by definition. */
export function checkoutTag(cwd: string, name: string): Promise<GitActionResult> {
  return run(cwd, ["switch", "--detach", `refs/tags/${name}`]);
}

/**
 * `add --all` first, so "commit all changes" covers the same files the list shows, untracked
 * included — `commit --all` alone would leave those behind.
 */
export async function commitAll(cwd: string, message: string): Promise<GitActionResult> {
  const added = await run(cwd, ["add", "--all"]);
  return added.ok ? run(cwd, ["commit", "--message", message]) : added;
}

/** `--include-untracked`, so "stash all changes" covers the same files the list shows. */
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
  // A remote branch is checked out by name once a local branch of that name exists;
  // otherwise git creates it as a tracking branch.
  if (target.remote === undefined || localBranches.includes(target.name)) {
    return run(cwd, ["switch", target.name]);
  }
  const tracked = await run(cwd, ["switch", "--track", `${target.remote}/${target.name}`]);
  // The local branch may have appeared since the last refresh — then a plain switch is what
  // was needed, and its own error is the one worth reporting.
  return tracked.ok ? tracked : run(cwd, ["switch", target.name]);
}

async function readStashes(cwd: string): Promise<StashEntry[]> {
  // %gd is the ref the other commands take ("stash@{0}"), %gs the message git itself wrote.
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
  /** Paths that exist in HEAD — index and worktree both go back to what it holds. */
  restore: string[];
  /** Paths that do not exist in HEAD; the file is already in the trash, this drops the index
      entry that a staged addition left behind. */
  drop: string[];
}

/**
 * Throws away local changes. Files HEAD does not know are the caller's to move to the trash
 * first (GitHub Desktop's rule: nothing that only exists locally is deleted outright), hence
 * the targets already sorted rather than the changes themselves.
 */
export async function discard(cwd: string, targets: DiscardTargets): Promise<GitActionResult> {
  if (targets.drop.length > 0) {
    // --ignore-unmatch: a path that was never staged has no index entry to remove, and that
    // is a success here, not a failure.
    const dropped = await run(cwd, ["rm", "--cached", "--force", "--ignore-unmatch", "--", ...targets.drop]);
    if (!dropped.ok) {
      return dropped;
    }
  }
  if (targets.restore.length === 0) {
    return { ok: true };
  }
  return run(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...targets.restore]);
}

/** The characters a gitignore line reads as syntax rather than as part of a name. */
function escapeIgnorePattern(pattern: string): string {
  return pattern.replace(/[\\!#*?[\]]/g, "\\$&");
}

/**
 * Adds the file, or everything with its extension ("Ignore all .log files", GitHub Desktop's
 * second ignore action), to the repository's .gitignore — skipping a rule it already holds
 * verbatim.
 *
 * Written in place rather than through a temp file and a rename: a working tree file the user
 * owns, written once per menu click, and a temp file beside it would show up in the very list
 * this was started from.
 */
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
    // Match the file's own line ending, and start on a line of its own.
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : newline;
    await fs.appendFile(file, `${separator}${rule}${newline}`, "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnifiedDiff(text: string): { lines: DiffLine[]; truncated: boolean } {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of text.split("\n")) {
    // A second file section (a rename git was told not to detect: one deletion, one addition)
    // starts with headers again, whose `---`/`+++` lines must not read as content.
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      // Carried on the header so the view knows where the gap in front of it ends, and can
      // offer to fill it. The gutter renders nothing for a hunk line either way.
      lines.push({ type: "hunk", oldLine, newLine, text: raw });
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ type: "add", newLine: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", oldLine: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) });
    }
    // "\ No newline at end of file" and any trailing empty line are not part of the content.

    if (lines.length >= MAX_DIFF_LINES) {
      return { lines, truncated: true };
    }
  }

  return { lines, truncated: false };
}

/**
 * What the diff view can show side by side instead of the words "binary file". SVG is not
 * here on purpose: git diffs it as the text it is, and that reads better than two pictures.
 */
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

/** Both versions of an image go into the renderer as data URLs; a large one would not. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function imageType(filePath: string): string | undefined {
  return IMAGE_TYPES[path.extname(filePath).slice(1).toLowerCase()];
}

/** Also used by `Repository.readFile` (Explorer preview) to tell an image from any other binary. */
export function isImage(filePath: string): boolean {
  return imageType(filePath) !== undefined;
}

export function toDataUrl(filePath: string, content: Buffer): string | undefined {
  return content.length > 0 && content.length <= MAX_IMAGE_BYTES
    ? `data:${imageType(filePath)};base64,${content.toString("base64")}`
    : undefined;
}

/**
 * The committed and the current version of an image. Either may be missing — the file was
 * added, or deleted — and is simply left out then; the view draws around it.
 */
async function readImageDiff(cwd: string, filePath: string, origPath?: string): Promise<ImageDiff> {
  const image: ImageDiff = {};
  // Buffer encoding, not the utf8 the rest of this file runs on: text encoding would replace
  // every byte that is not valid utf8 and leave an image nothing could decode.
  const committed = await new Promise<Buffer>((resolve) => {
    execFile(
      "git",
      ["show", `HEAD:${(origPath ?? filePath).replace(/\\/g, "/")}`],
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "buffer" },
      (error, stdout) => resolve(error ? Buffer.alloc(0) : stdout)
    );
  });
  image.before = toDataUrl(origPath ?? filePath, committed);

  try {
    image.after = toDataUrl(filePath, await fs.readFile(path.join(cwd, filePath)));
  } catch {
    // Deleted in the working tree: there is no "after" to show.
  }
  return image;
}

/** An untracked file has nothing to diff against, so its content becomes an all-added diff. */
async function readUntrackedDiff(cwd: string, filePath: string): Promise<FileDiff> {
  const absolute = path.join(cwd, filePath);
  const base: FileDiff = { path: filePath, lines: [], binary: false, truncated: false };
  try {
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_UNTRACKED_BYTES) {
      return { ...base, truncated: true };
    }
    const content = await fs.readFile(absolute);
    if (content.includes(0)) {
      return { ...base, binary: true };
    }
    const text = content.toString("utf8");
    const rows = text.split("\n");
    if (rows.at(-1) === "") {
      rows.pop();
    }
    const lines: DiffLine[] = rows
      .slice(0, MAX_DIFF_LINES)
      .map((row, index) => ({ type: "add" as const, newLine: index + 1, text: row }));
    return { ...base, lines, truncated: rows.length > MAX_DIFF_LINES };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ReadDiffOptions extends DiffOptions {
  untracked: boolean;
  /** The rename's source path — without it git diffs the new path as a wholly new file. */
  origPath?: string;
}

/**
 * The diff of one file against HEAD — index and worktree changes combined, which is what
 * the "Local Changes" list shows as a single entry.
 */
export async function readDiff(cwd: string, filePath: string, options: ReadDiffOptions): Promise<FileDiff> {
  const base: FileDiff = { path: filePath, lines: [], binary: false, truncated: false };
  if (isImage(filePath)) {
    return { ...base, binary: true, image: await readImageDiff(cwd, filePath, options.origPath) };
  }
  if (options.untracked) {
    return readUntrackedDiff(cwd, filePath);
  }

  const paths = options.origPath ? [options.origPath, filePath] : [filePath];
  const flags = options.ignoreWhitespace ? ["--ignore-all-space"] : [];
  try {
    let result = await git(cwd, ["diff", "HEAD", "--no-color", ...flags, "--", ...paths]);
    if (result.code !== 0) {
      // No HEAD yet (unborn branch): compare against the index instead.
      result = await git(cwd, ["diff", "--no-color", ...flags, "--", ...paths]);
      if (result.code !== 0) {
        return { ...base, error: (result.stderr || result.stdout).trim() };
      }
    }
    if (/^Binary files /m.test(result.stdout)) {
      return { ...base, binary: true };
    }
    const { lines, truncated } = parseUnifiedDiff(result.stdout);
    return { ...base, lines, truncated };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Every path `.gitignore` (and the rest of the exclude chain) hides, for a FILES tree asked to
 * hide them too — files and, with `--directory`, whole ignored directories collapsed to one
 * entry with a trailing `/`, so the walk can skip them without git naming each file inside.
 * Repository-relative, forward-slashed, as git prints them. Empty when git has nothing to say.
 */
export async function listIgnored(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout.split("\0").filter((entry) => entry !== "");
}

/**
 * Lines `from` to `to` of the file as it is now, 1-based and inclusive — what the diff view
 * puts into a gap it was asked to open. Context lines are by definition the same in both
 * versions, so the working tree is the one place they have to be read from.
 */
export async function readFileLines(cwd: string, filePath: string, from: number, to: number): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(cwd, filePath), "utf8");
    const rows = content.split("\n");
    if (rows.at(-1) === "") {
      rows.pop();
    }
    return rows.slice(Math.max(0, from - 1), to);
  } catch {
    // A file that cannot be read has no context to add; the gap simply stays closed.
    return [];
  }
}
