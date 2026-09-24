import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { statSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONTROL_ENV } from "../shared/control";
import {
  SBX_KNOWLEDGE_KINDS,
  SBX_PROBLEM,
  addProblems,
  forbiddenBy,
  isPort,
  sbxPortKey,
  sbxProblemNotices,
  withoutProblems
} from "../shared/sbx-rules";
import { SBX_AGENT_IDS } from "../shared/types";
import type {
  SbxAccess,
  SbxAgentId,
  SbxBlocker,
  SbxKnowledgeConfig,
  SbxKnowledgeEntry,
  SbxKnowledgeKind,
  SbxKnowledgeSource,
  SbxPath,
  SbxOption,
  SbxPort,
  SbxProblems,
  SbxProjectConfig,
  SbxSecret,
  SbxStatus
} from "../shared/types";
import { getAgent } from "./agents";
import { canBind } from "./can-bind";
import type { AgentPaths } from "./agents/agent";
import { readSbxConfig, writeSbxConfig } from "./tet-json";
import { readLinkedGitDir } from "./git/linked-git-dir";
import { mapLimited } from "./map-limited";
import { relativeInside } from "./path-inside";
import { isMountAllowed, parseFilesystemRules, parseGovernance, sbxNotReady, type FilesystemRule, type PathFlavor } from "./sbx-policy";
import { agentDataDir, agentDirFor } from "./terminals/agent-data";
import { augmentAgentPath } from "./terminals/agent-path";
import { toContainerPath } from "./terminals/hook-target";
import { isSimulatedMissing } from "./simulate";
import { resolveCommand } from "./terminals/pty";
import { checkAgentInstalled, isAgentInstalled } from "./terminals/terminal-session";

/**
 * The `sbx` process the settings dialog waits on, for `cancelSbxSetup`. Only `login` and `policy
 * init` register (`RunOptions.cancellable`): a spawn's `sbx ls` or `create` must survive Cancel.
 */
let currentChild: ChildProcess | undefined;

/** The `tet-ctl` bundle (ensureSandboxLauncher) and control port (isControlChannelAllowed), set
 *  from main.ts. Unset without a control channel, and then nothing of it reaches a sandbox. */
let control: { cliPath: string; port: number } | undefined;
/** tet's data folder, holding its mounted folders (readSbxBlockers, agent-data.ts). */
let storageRoot: string | undefined;
export function configureSandboxes(cliPath: string, port: number, dataRoot: string): void {
  control = { cliPath, port };
  storageRoot = dataRoot;
}

interface RunOptions {
  /** Written to stdin, then closed. Without it stdin is closed from the start, so a command waiting
   *  on it fails. */
  stdin?: string;
  /** Whether `cancelSbxSetup` may kill this one. */
  cancellable?: boolean;
  /**
   * Forwards stdout and stderr live, in arrival order, to the tab about to run in the sandbox
   * (its `onOutput` channel), `\n` as `\r\n`: sbx never prints a bare `\r` (measured), and xterm
   * has no `convertEol`.
   */
  onData?: (chunk: string) => void;
}

type OnData = RunOptions["onData"];

interface RunResult {
  /** Exited 0. */
  ok: boolean;
  stdout: string;
  /** sbx's own errors and those of a command it ran (measured). */
  stderr: string;
}

/** What sbx said on failing: its last line, `ERROR: …` without the prefix — progress lines
 *  ("Starting sandboxd daemon...") precede it. Empty when it said nothing. */
function sbxError(result: RunResult): string {
  return result.stderr.trim().split(/\r?\n/).pop()?.replace(/^ERROR:\s*/, "") ?? "";
}

/** Why sbx refused, as a problem's reason (SbxProblems): what it said, else that it refused. */
function sbxRefusal(result: RunResult): string {
  return sbxError(result) || SBX_PROBLEM.refused;
}

/** Every `sbx` invocation: a plain spawn through `resolveCommand`, no shell, from the temp
 *  directory so the working directory never reads as a workspace. */
function runSbx(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const resolved = resolveCommand("sbx", args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    if (options.cancellable) {
      currentChild = child;
    }
    let stdout = "";
    let stderr = "";
    const forward = (chunk: Buffer): void => options.onData?.(chunk.toString().replace(/\n/g, "\r\n"));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      forward(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      forward(chunk);
    });
    let settled = false;
    const finish = (result: RunResult) => {
      if (!settled) {
        settled = true;
        if (currentChild === child) {
          currentChild = undefined;
        }
        resolve(result);
      }
    };
    child.on("error", () => finish({ ok: false, stdout, stderr }));
    child.on("exit", (code) => finish({ ok: code === 0, stdout, stderr }));
    if (options.stdin !== undefined) {
      // A command gone before reading it fails the write (EPIPE, measured on Linux); unhandled, that
      // stream error raises Electron's modal crash dialog. The exit reports the failure.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}

/**
 * One command via `sbx exec` (no shell, `-w` the sandbox's view of `cwd`), for one-off actions on a
 * sandboxed session; exec starts a stopped sandbox. Stdout on exit 0, else rejects with stderr —
 * for a deleted sandbox `ERROR: sandbox '<name>' not found`.
 */
export async function execInSandbox(name: string, cwd: string, command: string[]): Promise<string> {
  const result = await runSbx(["exec", "-i", "-w", toContainerPath(cwd), name, ...command]);
  if (!result.ok) {
    const said = result.stderr.trim();
    throw new Error(`${command[0]} failed in sandbox ${name}${said ? `: ${said.slice(-300)}` : ""}`);
  }
  return result.stdout;
}

/** A `--json` run's stdout parsed: undefined when sbx failed or printed no JSON, so a reader
 *  answers "sbx cannot say" rather than an empty list. The shape is the caller's claim, read
 *  defensively at its site. */
function jsonOf<T>(result: RunResult): T | undefined {
  if (!result.ok) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

/** One `sbx … --json` read (jsonOf). */
async function sbxJson<T>(args: string[]): Promise<T | undefined> {
  return jsonOf<T>(await runSbx(args));
}

/** For the dialog's Cancel. Plain `kill()` suffices: `sbx.exe` is native, no cmd.exe shim (unlike
 *  `ask.ts`). */
export function cancelSbxSetup(): void {
  currentChild?.kill();
  currentChild = undefined;
}

/**
 * The sbx version test/agents.test.ts last passed against (TET_SBX_TEST=1): every measured value in
 * this file held there. As `AgentDefinition.verifiedVersion`, read by nothing in the app.
 */
export const SBX_VERIFIED_VERSION = "0.45.1";

/** `version` is a subcommand; `sbx --version` fails with "unknown flag". */
export function isSbxInstalled(): Promise<boolean> {
  return checkAgentInstalled("sbx", ["version"], os.tmpdir());
}

/**
 * `sbx version`'s answer ("sbx version: v0.45.1 <commit>") as "0.45.1"; undefined when sbx is not
 * installed (probeSbx's sign of it), "" when it printed no version.
 */
async function readSbxVersion(): Promise<string | undefined> {
  if (isSimulatedMissing("sbx")) {
    return undefined;
  }
  const result = await runSbx(["version"]);
  return result.ok ? (/\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? "") : undefined;
}

/** Whether that version is 0.45 or later: from there on a sandbox's live mounts survive a stop
 *  and `sbx inspect` lists them (mountAll). */
export function sbxVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => parseInt(part, 10) || 0);
  return major > 0 || minor >= 45;
}

/**
 * sbx shows a one-time wizard on a machine's first interactive `sbx run` (a tet tab is one).
 * Any valid JSON at `%LOCALAPPDATA%\DockerSandboxes\sandboxes\config\first-run-import.json`
 * suppresses it (measured); an existing file is kept. Loses the wizard's MCP-server import
 * (`sbx mcp add` by hand). Undocumented, verified on Windows only — a no-op elsewhere. Best-effort.
 */
async function suppressSbxFirstRunWizard(): Promise<void> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    return;
  }
  const markerFile = path.join(process.env.LOCALAPPDATA, "DockerSandboxes", "sandboxes", "config", "first-run-import.json");
  try {
    await fs.access(markerFile);
    return;
  } catch {
    // Not there yet.
  }
  try {
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await fs.writeFile(markerFile, "{}");
  } catch {
    // Worst case the wizard shows once.
  }
}

/** `sbx login` opens the browser and waits on its own callback; no console needed. */
export async function runSbxLogin(): Promise<boolean> {
  return (await runSbx(["login"], { cancellable: true })).ok;
}

/**
 * The machine-wide network policy "balanced", Docker's recommended default — no per-project choice:
 * changing it needs `sbx policy reset`, which stops every running sandbox.
 */
export async function initSbxPolicy(): Promise<boolean> {
  return (await runSbx(["policy", "init", "balanced"], { cancellable: true })).ok;
}

/** `sbx ls --json` as name → workspaces. */
type SandboxList = Map<string, string[]>;

/**
 * Before every sandboxed spawn (`resolveSbxRun`): the first unmet precondition as a notice, or the
 * sandbox listing the sign-in probe's `sbx ls` produced and the filesystem rules the policy check
 * read, for `prepareSbxRun`. The policy check (readSbxBlockers) repeats the dialog's: a policy
 * changes outside tet, and an agent whose hooks cannot reach tet or whose folders are unmounted
 * runs with no turn marks and no reason given.
 */
export async function checkSbxReady(
  projectPath: string,
  projectId: string
): Promise<{ notReady: string } | { sandboxes: SandboxList; organization?: string; rules: FilesystemRule[] }> {
  // No PATH re-read on the spawn path: on macOS/Linux that is a login shell per call.
  const { status, sandboxes } = await probeSbx(false);
  const notReady = sbxNotReady(status);
  // A listing exists whenever signed in (probeSbx); `!sandboxes` only narrows it.
  if (notReady !== undefined || !sandboxes) {
    return { notReady: notReady ?? "SBX is not signed in to Docker" };
  }
  const { blockers, rules } = await readSbxBlockers(projectPath, projectId);
  if (blockers.length > 0) {
    const policy = status.organization ? "your organization's SBX policy" : "SBX's policy";
    return { notReady: `${policy} does not allow ${blockers.map((blocker) => blocker.allow).join("; ")}` };
  }
  return { sandboxes, organization: status.organization, rules };
}

/**
 * What the sbx-settings dialog asks before showing its fields. PATH is re-read: "Check again"
 * follows an install. Nothing cached — sbx changes from outside tet at any time.
 */
export async function readSbxStatus(projectPath: string, projectId: string): Promise<SbxStatus> {
  const { status } = await probeSbx(true);
  if (status.policyInitialized) {
    status.blockers = (await readSbxBlockers(projectPath, projectId)).blockers;
  }
  return status;
}

/** A rule covering a folder and below: under home as `~`, in this platform's separators — a rule
 *  matches only its own path format. */
function folderRule(folder: string): string {
  const relative = relativeInside(os.homedir(), folder);
  return path.join(relative !== undefined ? path.join("~", relative) : folder, "**");
}

/**
 * What sbx's policy must still allow for a sandboxed tab: the control channel
 * (isControlChannelAllowed), the project as workspace, and tet's mounted folders — each agentDir
 * rw (fixedMountSpecs). Checked as mounted, asked for as one rule under agentDataDir, read *and*
 * write as Docker's docs require (write alone measured to suffice). Rules come from one
 * `sbx policy ls`, evaluated in sbx-policy.ts. The user's Allowed paths and knowledge are not asked
 * for — a tab starts without them.
 *
 * Both questions are asked at once, for the same reason probeSbx asks its three that way. The rules
 * are returned too, for a spawn's readSbxProblems.
 */
async function readSbxBlockers(
  projectPath: string,
  projectId: string
): Promise<{ blockers: SbxBlocker[]; rules: FilesystemRule[] }> {
  const [channelAllowed, rules] = await Promise.all([isControlChannelAllowed(), readFilesystemRules()]);
  const blockers: SbxBlocker[] = [];
  if (!channelAllowed) {
    blockers.push({ what: "tet's hooks", allow: "localhost (network, no port)" });
  }
  const mountable = mountableBy(rules);
  if (!mountable(projectPath, "rw")) {
    blockers.push({ what: "The project", allow: `${folderRule(projectPath)} (read and write)` });
  }
  const repositoryGitDir = readLinkedGitDir(projectPath)?.commonDir;
  if (repositoryGitDir !== undefined && !mountable(repositoryGitDir, "rw")) {
    blockers.push({ what: "The worktree's repository", allow: `${folderRule(repositoryGitDir)} (read and write)` });
  }
  if (storageRoot) {
    const root = storageRoot;
    const own = SBX_AGENT_IDS.every((agentId) => mountable(agentDirFor(root, agentId, projectId), "rw"));
    if (!own) {
      blockers.push({ what: "tet's agent data", allow: `${folderRule(agentDataDir(root))} (read and write)` });
    }
  }
  return { blockers, rules };
}

/** This machine's paths, as sbx-policy.ts compares them. */
function hostFlavor(): PathFlavor {
  return { platform: process.platform, home: os.homedir() };
}

/** sbx's filesystem rules, evaluated in tet (sbx-policy.ts): sbx has no `policy check` for them. */
async function readFilesystemRules(): Promise<FilesystemRule[]> {
  return parseFilesystemRules((await runSbx(["policy", "ls", "--type", "filesystem", "--json"])).stdout);
}

/** Whether the rules let a path of this machine be mounted with that access. */
function mountableBy(rules: FilesystemRule[]): (hostPath: string, access: SbxAccess) => boolean {
  return (hostPath, access) => isMountAllowed(rules, normalizeHostPath(hostPath), access, hostFlavor());
}

/**
 * Whether sbx's network policy lets a sandbox reach the host, asked as isNetworkAllowed does
 * (readSbxProblems). True for a wildcard, which cannot be asked: `policy check` takes it as a literal name (measured: `*.github.com` refused where
 * `github.com` is allowed, 0.42.1).
 *
 * One host per call, all asked at once: sbx queues them on its own lock, so a cap gains nothing — 6 took 1.8 s, 10 took 2.6 s, 20 took 5.4 s
 * with answers unchanged, its "docker hub refresh lock held" warning on stderr only (measured,
 * 2026-09-18, 0.42.1).
 */
export async function readHostAllowed(host: string): Promise<boolean> {
  return host.includes("*") || (await isNetworkAllowed(host));
}

/**
 * Behind both. Three processes, always: `version` says installed and whether old enough to be
 * reported as a failure (sbxVersionSupported), `policy ls`'s exit code says initialized, its output
 * governed, and asking it and `ls` before the answers are read costs nothing but two processes on a
 * machine without sbx. They start together because an sbx invocation is ~0.45 s of CLI startup,
 * which a spawn pays five times over (with readSbxBlockers): 2.26 s in a row against 1.58 s as
 * these two groups, same answers (measured, 2026-09-16, 0.42.1). The answers are still read in
 * order, so the first "no" is still the one reported — `sbx policy ls` fails when signed out too.
 *
 * `sbx ls` is the sign-in probe: side-effect-free, exits 1 with "Not authenticated to Docker" when
 * signed out, and `prepareSbxRun` needs its listing. Not `sbx policy ls`, which also exits 1 signed
 * in without a policy. Only that text reads as signed out: after `sbx logout` and `login`, sandboxd
 * can hang on a sandbox's orphaned containerd shim, and every command then exits 1 with
 * "ERROR: ensure daemon: …" — `sbx daemon restart` does not help, only ending the shim (measured,
 * 0.42.1, Windows). That error is reported as sbx's own.
 *
 * A governed account's `sbx policy ls` opens with "Governance: Managed by <org>" (parseGovernance).
 * Governance words a blocker and hides the dialog's Allowed hosts; what is allowed is asked of the
 * policy (readSbxBlockers).
 */
async function probeSbx(refreshPath: boolean): Promise<{ status: SbxStatus; sandboxes?: SandboxList }> {
  const status: SbxStatus = { installed: false, loggedIn: false, policyInitialized: false, blockers: [] };
  if (refreshPath) {
    await augmentAgentPath();
  }
  const [version, list, policy] = await Promise.all([readSbxVersion(), runSbx(["ls", "--json"]), runSbx(["policy", "ls"])]);
  status.installed = version !== undefined;
  if (version === undefined) {
    return { status };
  }
  if (version && !sbxVersionSupported(version)) {
    status.failure = `version ${version} is too old, tet needs 0.45 or later`;
    return { status };
  }
  const sandboxes = parseSandboxes(list);
  if (!sandboxes) {
    if (!/not authenticated/i.test(list.stderr)) {
      status.failure = sbxError(list) || "sbx ls failed";
    }
    return { status };
  }
  status.loggedIn = true;
  status.policyInitialized = policy.ok;
  status.organization = policy.ok ? parseGovernance(policy.stdout) : undefined;
  return { status, sandboxes };
}

/** The organization managing sbx's policy, if one does (parseGovernance), from one `policy ls`. */
export async function readGovernance(): Promise<string | undefined> {
  const policy = await runSbx(["policy", "ls"]);
  return policy.ok ? parseGovernance(policy.stdout) : undefined;
}

/** A yes is kept for the run; a no is asked again next spawn, as the policy may change. */
let controlAllowed: Promise<boolean> | undefined;

/**
 * `sbx policy check` asks the same authorizer the sandbox's proxy does, so no matching is
 * reproduced. A denial exits 1 with `"allowed": false`; JSON on stdout either way (measured,
 * 0.42.1) — so a failed run reads as denied.
 */
async function isNetworkAllowed(target: string): Promise<boolean> {
  return (await sbxJson<{ allowed?: boolean }>(["policy", "check", "network", "--json", target]))?.allowed === true;
}

/**
 * Whether the sandbox reaches the control channel, allowing it first if not: as `localhost:<port>`,
 * since sbx's proxy rewrites `host.docker.internal` to `localhost` before the policy (measured: a
 * `host.docker.internal` rule matches nothing, and `sbx policy log` shows `localhost:<port>`).
 * Rechecked after the allow, which a deny rule outranks. On a governed account every local `policy
 * allow` exits 1 (measured, 0.42.1), so only the organization can allow it — without a port, as
 * the port is probed per run (findControlPort). True without a control channel.
 */
async function isControlChannelAllowed(): Promise<boolean> {
  if (!control) {
    return true;
  }
  const resource = `localhost:${control.port}`;
  controlAllowed ??= (async () =>
    (await isNetworkAllowed(resource)) ||
    ((await runSbx(["policy", "allow", "network", resource])).ok && (await isNetworkAllowed(resource))))();
  const allowed = await controlAllowed;
  if (!allowed) {
    controlAllowed = undefined;
  }
  return allowed;
}

/**
 * Stable per (project, agent) so `sbx run --name` reattaches. Hashed: `sbx create --name` allows
 * only letters, numbers, hyphens and periods.
 */
export function sandboxName(projectId: string, agentId: SbxAgentId): string {
  return `tet-${agentId}-${projectHash(projectId)}`;
}

/**
 * The agent of a sandbox tet made (sandboxName) for this workspace under another project id — the
 * project closed and opened again. Nothing reaches it any more, yet it keeps grants, rules and
 * secrets of its own; undefined for any other sandbox.
 */
function orphanAgent(name: string, workspaces: string[], projectId: string, projectPath: string): SbxAgentId | undefined {
  const agentId = SBX_AGENT_IDS.find((candidate) => new RegExp(`^tet-${candidate}-[0-9a-f]{12}$`).test(name));
  return agentId !== undefined && name !== sandboxName(projectId, agentId) && sameSet(workspaces, [projectPath]) ? agentId : undefined;
}

/** The project's share of a sandbox name and of a secret placeholder: one identity, one place. */
function projectHash(projectId: string): string {
  return crypto.createHash("sha1").update(projectId).digest("hex").slice(0, 12);
}

/** Expands tet.json's `~` and `~/…` (contractHome) — `sbx` is no shell. On win32 `~\…` too. */
function expandHome(hostPath: string): string {
  if (hostPath === "~") {
    return os.homedir();
  }
  const homeRelative = hostPath.startsWith("~/") || (path.sep === "\\" && hostPath.startsWith("~\\"));
  return homeRelative ? path.join(os.homedir(), hostPath.slice(2)) : hostPath;
}

/**
 * The inverse, for tet.json: under home as `~/…` with forward slashes, so a row serves another user
 * on the same OS; else as typed. Case-insensitive on win32 through `path.relative`.
 */
export function contractHome(hostPath: string): string {
  const typed = hostPath.trim();
  const resolved = normalizeHostPath(typed);
  if (!path.isAbsolute(resolved)) {
    return typed;
  }
  if (path.relative(os.homedir(), resolved) === "") {
    return "~";
  }
  const relative = relativeInside(os.homedir(), resolved);
  if (relative === undefined) {
    return typed;
  }
  return `~/${relative.split(path.sep).join("/")}`;
}

/** A typed host path as sbx lists it back: `~` expanded, native separators, no trailing one.
 *  Relative paths are left alone. */
function normalizeHostPath(hostPath: string): string {
  const expanded = expandHome(hostPath.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
}

/**
 * A live bind mount's `sbx mount` and `sbx umount` specs: `HOST:CTR_TARGET[:ro]` and
 * `HOST:CTR_TARGET`. `sbx mount` takes `HOST[:CTR_TARGET[:ro|rw]]`, and `HOST:ro` parses "ro" as
 * the target ("must be absolute"), so the target is always spelled out — via `toContainerPath`,
 * since the host path as target breaks on Windows (two drive colons). Read-write is the same
 * form without a suffix, which lands where the bare host path would (measured, 2026-09-24,
 * 0.45.1: `sbx inspect` lists a bare mount at that container path). `mount` carries the access,
 * so equal `mount`s are the same grant (saveSbxConfig narrows by it, mountAll compares by it).
 *
 * A single file takes both forms (measured, 0.42.1).
 */
interface MountSpec {
  mount: string;
  unmount: string;
}

function mountSpec(host: string, target: string, readOnly: boolean): MountSpec {
  const unmount = `${host}:${target}`;
  return { mount: readOnly ? `${unmount}:ro` : unmount, unmount };
}

/** One allowed-path row as a live mount (not a create positional, see fixedMountSpecs). */
export function pathMountSpecs(entry: SbxPath): MountSpec {
  const host = normalizeHostPath(entry.path);
  return mountSpec(host, toContainerPath(host), entry.access === "ro");
}

/** Undefined for nothing — only what exists is mounted. */
function statOf(candidate: string): Stats | undefined {
  try {
    return statSync(candidate);
  } catch {
    return undefined;
  }
}

type SandboxPaths = Pick<AgentPaths, "agentDir">;

/**
 * tet's own mount for every sandboxed tab: `agentDir` rw (hook settings, agents' records). A live
 * mount, since a create positional cannot change afterwards ("already exists and can't be given
 * new workspaces"). The project stays create-time: `sbx run` has no `--workdir`
 * (docker/sbx-releases#394), and without a positional the agent starts in an empty
 * `/home/agent/workspace` (measured, 0.42.1). It lands at the host path's container form, so
 * `HookTarget` paths hold.
 *
 * Never the agent's config directory (`~/.claude`, `~/.codex`): pointed at by `CLAUDE_CONFIG_DIR`/
 * `CODEX_HOME`, the sandboxed CLI is signed in as the host (measured), and a `/login` inside would
 * replace the host's. Knowledge (AgentDefinition.sandboxKnowledge) and sessions (sessionMountSpecs)
 * are curated subpaths, never the directory holding credentials.
 */
export function fixedMountSpecs(paths: SandboxPaths): MountSpec[] {
  return [pathMountSpecs({ path: paths.agentDir, access: "rw" })];
}

/**
 * A linked worktree's repository `.git`, rw: the worktree's own `.git` is a file pointing there, and
 * without it git fails in the sandbox ("not a git repository"). tet creates worktrees with relative
 * links (git.ts's worktreeAdd), which hold at the container paths; with the mount, status, commit and
 * branch work there (measured, sbx 0.42.1, git 2.53 in the kits). Live, like fixedMountSpecs.
 */
function worktreeMountSpecs(projectPath: string): MountSpec[] {
  const commonDir = readLinkedGitDir(projectPath)?.commonDir;
  return commonDir === undefined ? [] : [pathMountSpecs({ path: commonDir, access: "rw" })];
}

/** An agent's host knowledge per kind, as sandboxKnowledgeFor resolves it. */
type KnowledgeEntries = Record<SbxKnowledgeKind, SbxKnowledgeEntry[]>;

/** Cached (isAgentInstalled). */
async function isInstalledHere(agentId: SbxAgentId): Promise<boolean> {
  const agent = getAgent(agentId);
  return agent.versionArgs !== undefined && (await isAgentInstalled(agent.executable(), agent.versionArgs, os.tmpdir()));
}

/** Where the sandboxed CLI reads its own skills, whether or not it is installed here. */
function skillsTargets(agentId: SbxAgentId): string[] {
  return (getAgent(agentId).sandboxKnowledge?.().skills ?? []).map((entry) => entry.target);
}

/**
 * What a sandboxed agent may bring from this host, per kind, only what exists: its own knowledge
 * only while it is installed here — a folder an uninstalled one left is not wanted — and
 * `~/.agents/skills` at its `sharedSkillsTarget` either way, unless its own skills sit there. An
 * agent without a `sharedSkillsTarget` (Claude) never gets it. A `skillsFolder` replaces both, at
 * the agent's own skills targets, installed or not: the user chose it.
 */
async function sandboxKnowledgeFor(agentId: SbxAgentId, skillsFolder?: string): Promise<KnowledgeEntries> {
  const agent = getAgent(agentId);
  const own = (await isInstalledHere(agentId)) ? agent.sandboxKnowledge?.() : undefined;
  const existing = (entries: SbxKnowledgeEntry[] = []): SbxKnowledgeEntry[] => entries.filter((entry) => statOf(entry.host));
  const rest = { plugins: existing(own?.plugins), instructions: existing(own?.instructions) };
  if (skillsFolder !== undefined) {
    const skills = statOf(skillsFolder) ? skillsTargets(agentId).map((target) => ({ host: skillsFolder, target })) : [];
    return { skills, ...rest };
  }
  const skills = existing(own?.skills);
  const target = agent.sharedSkillsTarget;
  const shared = path.join(os.homedir(), ".agents", "skills");
  if (target !== undefined && !skills.some((entry) => entry.target === target) && statOf(shared)) {
    skills.push({ host: shared, target });
  }
  return { skills, ...rest };
}

/** The Knowledge tab's agents: those installed here, with what each brings of its own. */
export async function readKnowledgeSources(): Promise<SbxKnowledgeSource[]> {
  const sources = await Promise.all(
    SBX_AGENT_IDS.map(async (agentId): Promise<SbxKnowledgeSource | undefined> =>
      (await isInstalledHere(agentId))
        ? {
            agentId,
            displayName: getAgent(agentId).displayName,
            own: await sandboxKnowledgeFor(agentId),
            skillsTargets: skillsTargets(agentId)
          }
        : undefined
    )
  );
  return sources.filter((source) => source !== undefined);
}

/** A grant the dialog changes, with the row it is for (SbxProblems' option and row). */
interface Grant extends MountSpec {
  option: "paths" | "knowledge";
  row: string;
}

/**
 * Every grant the dialog changes (Allowed paths, knowledge), as one list: Save narrows and each
 * spawn re-applies the same set (mountAll, revokeMounts). Only what exists here; a missing row or
 * skills folder is a problem (readSbxProblems). A different access is a different grant (`mount`).
 * Knowledge is bind-mounted (`HOST:TARGET[:ro]`), not symlinked: sbx cannot follow a link out of
 * its workspace. Folders and files both work (measured).
 */
async function grantsOf(agentId: SbxAgentId, knowledge: SbxKnowledgeConfig, paths: SbxPath[]): Promise<Grant[]> {
  const entries = await sandboxKnowledgeFor(agentId, knowledge.skillsFolder);
  return [
    ...SBX_KNOWLEDGE_KINDS.flatMap((kind) => {
      const access = knowledge[kind];
      return access
        ? entries[kind].map((entry) => ({
            ...mountSpec(entry.host, entry.target, access === "ro"),
            option: "knowledge" as const,
            row: kind
          }))
        : [];
    }),
    ...paths
      .filter((entry) => statOf(normalizeHostPath(entry.path)))
      .map((entry) => ({ ...pathMountSpecs(entry), option: "paths" as const, row: entry.path }))
  ];
}

/** Sandboxes given the `tet-ctl` launcher this run; cleared in removeSandbox. */
const launcherWritten = new Set<string>();

/** The `sbx create` (or rebuild) underway per sandbox name — see ensureSandboxExists. */
const sandboxSetups = new Map<string, Promise<unknown>>();

/** Runs `action` once the one underway under `name` in `queue` is over, however that one ended. */
function inTurn<T>(queue: Map<string, Promise<unknown>>, name: string, action: () => Promise<T>): Promise<T> {
  const turn = (queue.get(name) ?? Promise.resolve()).catch(() => undefined).then(action);
  queue.set(name, turn);
  const forget = (): void => {
    if (queue.get(name) === turn) {
      queue.delete(name);
    }
  };
  turn.then(forget, forget);
  return turn;
}

/** Undefined when `sbx ls` fails, as it does signed out (probeSbx). One process for all sandboxes. */
async function listSandboxes(): Promise<SandboxList | undefined> {
  return parseSandboxes(await runSbx(["ls", "--json"]));
}

/** probeSbx reads the run itself too, for why `ls` failed. */
function parseSandboxes(result: RunResult): SandboxList | undefined {
  const parsed = jsonOf<{ sandboxes?: { name?: string; workspaces?: string[] }[] }>(result);
  if (!parsed) {
    return undefined;
  }
  const sandboxes: SandboxList = new Map();
  for (const sandbox of parsed.sandboxes ?? []) {
    if (sandbox.name) {
      sandboxes.set(sandbox.name, sandbox.workspaces ?? []);
    }
  }
  return sandboxes;
}

/**
 * Each sandbox's Allowed hosts as sbx has them, what saveSbxConfig brings in line with tet.json,
 * from one `policy ls`. A rule counts when an allow scoped `sandbox:<name>` and
 * editable, as `sbx policy allow network --sandbox` makes it (measured, 0.42.1); a kit's rule is
 * not editable, a global one is the machine's. One rule per resource, so the list is their union.
 * Inactive rules count too: governance hides them by default (0 of 20 listed, measured, 0.42.1),
 * and a Save without governance would then add them a second time.
 */
async function readSandboxHosts(): Promise<Map<string, string[]>> {
  // Unreadable reads as no rules.
  const parsed = await sbxJson<{ rules?: { scope?: string; decision?: string; editable?: boolean; resources?: string[] }[] }>([
    "policy", "ls", "--type", "network", "--include-inactive", "--json"
  ]);
  const hosts = new Map<string, string[]>();
  for (const rule of parsed?.rules ?? []) {
    if (rule.decision !== "allow" || !rule.editable || !rule.scope?.startsWith("sandbox:")) {
      continue;
    }
    const name = rule.scope.slice("sandbox:".length);
    hosts.set(name, [...(hosts.get(name) ?? []), ...(rule.resources ?? [])]);
  }
  return hosts;
}

function sameSet(a: string[], b: string[]): boolean {
  const sorted = (list: string[]) => [...list].sort();
  const [left, right] = [sorted(a), sorted(b)];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function removeSandbox(name: string, onData?: OnData): Promise<boolean> {
  launcherWritten.delete(name);
  return (await runSbx(["rm", name, "--force"], { onData })).ok;
}

/**
 * A removed or renamed worktree's sandboxes: their one workspace is gone, and the project id they
 * are named by (sandboxName) never comes back. Nothing when sbx cannot list them.
 */
export async function removeProjectSandboxes(projectId: string): Promise<void> {
  const sandboxes = await listSandboxes();
  for (const agentId of SBX_AGENT_IDS) {
    const name = sandboxName(projectId, agentId);
    if (sandboxes?.has(name)) {
      await removeSandbox(name);
    }
  }
}

/**
 * Starts a stopped sandbox with a cheap `exec`: `sbx mount` and `ports` refuse one ("409
 * Conflict"; `umount` takes one since 0.45, see mountAll). False also when it does not exist — the
 * same to its best-effort callers.
 *
 * A spawn starts it before it knows it may (`SbxRunRequest.warm`), because this is the slowest step
 * of the lot: ~2.5 s for a stopped sandbox against 0.7 s for a running one (measured, 2026-09-16,
 * 0.42.1). Safe that early because it creates nothing: for a sandbox that does not exist it fails
 * in ~0.55 s with "sandbox '<name>' not found" (measured), and a rebuild removing the sandbox under
 * a start still in flight leaves both exiting 0 and the `create` after it working (measured).
 */
export async function ensureRunning(name: string, onData?: OnData): Promise<boolean> {
  return (await runSbx(["exec", "-i", name, "true"], { onData })).ok;
}

/**
 * Ensures a sandbox whose one workspace is this project — all else is mounted live, so this is
 * all `sbx create` is told. A different workspace means a rebuild: an older tet's sandbox with
 * create-time fixed paths, or a project whose path moved under the same id (`sandboxName` hashes
 * the id; `projects.json` is hand-editable). Nothing open can be attached to such a sandbox, so it
 * is removed outright. Returns whether it created one, which needs seeding from tet.json
 * (prepareSbxRun's allowHosts).
 *
 * `--skills=off`, since sbx (0.43 on) otherwise binds its own skills store read-only at the
 * agent's skills directory (`~/.claude/skills`), the very target of tet's knowledge mount: that
 * stacks over the store and leaves it showing once unmounted. Off, the directory is not there,
 * tet's mount takes it read-write, and a later `sbx run` adds no store — create-time, so a
 * sandbox keeps what it was made with (measured, 2026-09-24, 0.45.1).
 *
 * A failed `create` is not best-effort: `sbx run --name` would create the sandbox without the
 * workspace, and the agent would start in an empty directory unannounced (e.g. pi's kit unpulled
 * without network). Rejects, leaving the tab in error; sbx's message reached it via `onData`.
 *
 * One setup per sandbox (`sandboxSetups`), listing again first: two tabs starting together both
 * find it missing, and a second `create` fails with `409 Conflict: sandbox "…" already exists`
 * (measured) — or, rebuilding, removes the one just made.
 */
function ensureSandboxExists(
  agentId: SbxAgentId,
  projectPath: string,
  name: string,
  sandboxes: SandboxList,
  onData?: OnData
): Promise<boolean> {
  const listed = sandboxes.get(name);
  if (listed !== undefined && sameSet(listed, [projectPath])) {
    return Promise.resolve(false);
  }
  return inTurn(sandboxSetups, name, async () => {
    const existing = ((await listSandboxes()) ?? sandboxes).get(name);
    if (existing !== undefined && sameSet(existing, [projectPath])) {
      return false;
    }
    if (existing !== undefined) {
      await removeSandbox(name, onData);
    }
    const created = await runSbx(["create", getAgent(agentId).sandboxKit ?? agentId, projectPath, "--name", name, "--skills=off"], { onData });
    if (!created.ok) {
      throw new Error(`sbx could not create the ${agentId} sandbox`);
    }
    // A new sandbox holds nothing of the one that had this name — and one removed outside tet
    // (`sbx rm`, `prune`, `reset`) never passed removeSandbox, which is the other place this is
    // forgotten. Kept here, the launcher would be skipped and the agent would run without hooks.
    launcherWritten.delete(name);
    return true;
  });
}

/**
 * Writes `tet-ctl` into the sandbox's `~/.local/bin` — first on every template's PATH and writable
 * by the "agent" user, unlike `/usr/local/bin` (verified, 2026-09-08). Not a mounted launcher:
 * `sbx run -e PATH=...` replaces PATH literally, never prepends. The ~9 KB bundle is piped in
 * behind a `#!/usr/bin/env node` shebang; every template has node. Runs after ensureSandboxExists.
 */
async function ensureSandboxLauncher(name: string, onData?: OnData): Promise<void> {
  if (!control || launcherWritten.has(name)) {
    return;
  }
  const bundle = await fs.readFile(control.cliPath, "utf8").catch(() => undefined);
  if (bundle === undefined) {
    return;
  }
  const written = await runSbx(
    ["exec", "-i", name, "sh", "-c", "mkdir -p ~/.local/bin && cat > ~/.local/bin/tet-ctl && chmod +x ~/.local/bin/tet-ctl"],
    { stdin: `#!/usr/bin/env node\n${bundle}`, onData }
  );
  if (written.ok) {
    launcherWritten.add(name);
  }
}

const MOUNT_CONCURRENCY = 6;

/**
 * The live mounts a sandbox holds, from one `sbx inspect --json` (`runtime_mounts[]`: `host_path`
 * as given, `container_target`, `read_only` only when true), as MountSpecs. Answers for a stopped
 * sandbox too, in ~0.5 s (measured, 2026-09-24, 0.45.1). Undefined when sbx cannot say, as for a
 * sandbox that does not exist.
 */
async function readRuntimeMounts(name: string): Promise<MountSpec[] | undefined> {
  const parsed = await sbxJson<{ runtime_mounts?: { host_path?: string; container_target?: string; read_only?: boolean }[] }>([
    "inspect", name, "--json"
  ]);
  return parsed?.runtime_mounts?.flatMap(({ host_path, container_target, read_only }) =>
    host_path && container_target ? [mountSpec(host_path, container_target, read_only === true)] : []
  );
}

/** The mountAll underway per sandbox name (inTurn). */
const mountSetups = new Map<string, Promise<unknown>>();

/**
 * Brings a sandbox's live mounts to `specs` at every start, against what it holds
 * (readRuntimeMounts): a mount it lacks is mounted, one it holds that `specs` has not — another
 * access included — unmounted. Measured, 2026-09-24, sbx 0.45.1:
 * - mounts survive a stop, access included, and are bound again at the start. `sbx stop` can
 *   happen outside tet, so the sandbox is asked each time rather than tet remembering.
 * - mounting what is mounted is not idempotent: a read-only *file* fails ("create target file …
 *   read-only file system"), a folder is bound a second time over the first. Hence only what is
 *   missing.
 * - a mount whose host path is gone keeps the sandbox from starting ("422 … cannot restore
 *   mount"); `sbx umount` takes it out of a stopped sandbox too. `specs` holds only what exists,
 *   so it goes with the rest, before the start.
 * - another access is refused while one is held ("409 … already mounted read-only …; cannot also
 *   mount it read-write"), so the unmounts run first.
 *
 * Concurrent, since each `sbx mount` costs ~0.45s: 6 at once took 1.6s instead of 2.6s, all binds
 * present, ro honoured; 12 at once hit "docker hub refresh lock held by another process" (measured,
 * 2026-09-16, 0.42.1), hence MOUNT_CONCURRENCY. One sandbox's tabs take turns (`mountSetups`):
 * two tabs starting together would both mount what is missing, the second failing on a read-only
 * file; in turn, the second finds it all there.
 *
 * `started` is a start already underway (`SbxRunRequest.warm`), waited for before unmounting and
 * joined instead of started again — but only its *success* counts: it may have run before the
 * sandbox existed (two tabs of one agent starting together, the second one seeing the first
 * one's), or failed on a mount whose host path is gone. Returns what sbx refused, by `mount`, with
 * its reason (sbxRefusal).
 */
function mountAll(name: string, specs: MountSpec[], onData?: OnData, started?: Promise<boolean>): Promise<Map<string, string>> {
  return inTurn(mountSetups, name, async () => {
    const [live = [], running] = await Promise.all([readRuntimeMounts(name), started]);
    const wanted = new Set(specs.map((spec) => spec.mount));
    // One by one: rare (a change since the last start), and concurrent umounts are unmeasured.
    for (const mount of live.filter((mount) => !wanted.has(mount.mount))) {
      await runSbx(["umount", name, mount.unmount], { onData });
    }
    if (!running) {
      await ensureRunning(name, onData);
    }
    const held = new Set(live.map((mount) => mount.mount));
    const missing = specs.filter((spec) => !held.has(spec.mount));
    const refused = await mapLimited(missing, MOUNT_CONCURRENCY, async (spec) => {
      const result = await runSbx(["mount", name, spec.mount], { onData });
      return result.ok ? undefined : sbxRefusal(result);
    });
    return new Map(missing.flatMap((spec, index) => (refused[index] === undefined ? [] : [[spec.mount, refused[index]] as const])));
  });
}

/**
 * Narrows grants at Save, not at the next start: a dropped or rw→ro path or knowledge kind must
 * stop being accessible *now* in a running sandbox, and a stopped one would bind it again at its
 * start. Only a grant the sandbox holds (readRuntimeMounts; every one when sbx cannot say): one it
 * does not hold is gone already. A stopped sandbox takes the `umount` (measured, 2026-09-24,
 * 0.45.1). Adds what sbx would not take back to `refused`.
 */
async function revokeMounts(name: string, grants: Grant[], refused: SbxProblems): Promise<void> {
  const live = (await readRuntimeMounts(name))?.map((mount) => mount.mount);
  for (const grant of grants.filter((grant) => live?.includes(grant.mount) ?? true)) {
    const result = await runSbx(["umount", name, grant.unmount]);
    if (!result.ok) {
      addProblems(refused, grant.option, { [grant.row]: sbxRefusal(result) });
    }
  }
}

/**
 * Allows the project's hosts scoped to this sandbox (`--sandbox`, as kits scope theirs). A policy
 * rule lives in sbx's policy store, not the sandbox — measured, 2026-09-09, sbx 0.42.1:
 * - the sandbox must *exist* (`sandbox "x" not found`) but need not run, so no ensureRunning; both
 *   callers know it exists.
 * - the rule survives a stop and dies with `sbx rm`, so only a *new* sandbox is given tet.json's
 *   (prepareSbxRun); Save brings an existing one in line (saveSbxConfig), a rule set by hand
 *   included.
 * - RESOURCES is comma-separated, one process (~0.5 s), idempotent per scope ("Already covered",
 *   exit 0). A host allowed globally still gets its entry, so the list equals the dialog's.
 * - a change reaches a *running* sandbox at once (403 → 200), so saveSbxConfig applies it too.
 * - on a governed account every local `policy allow` exits 1 (measured, 0.42.1), so it is never
 *   asked there (readSbxProblems asks the organization's policy instead).
 * sbx refuses a URL or a space inside a name ("invalid network pattern …", measured, 2026-09-24,
 * 0.45.1), which lands in `refused` like any refusal. Returns what sbx refused, by host: the list
 * in one go, and one by one only once that failed, to tell which.
 */
async function allowHosts(name: string, hosts: string[], onData?: OnData): Promise<Record<string, string>> {
  if (hosts.length === 0) {
    return {};
  }
  const allow = (resources: string[]) => runSbx(["policy", "allow", "network", "--sandbox", name, resources.join(",")], { onData });
  if ((await allow(hosts)).ok) {
    return {};
  }
  const refused: Record<string, string> = {};
  for (const host of hosts) {
    const result = await allow([host]);
    if (!result.ok) {
      refused[host] = sbxRefusal(result);
    }
  }
  return refused;
}

/**
 * Removes dropped hosts at Save, ending the allowance *now* (as revokeMounts). One `rm` per host:
 * the comma-list form removes nothing if any entry is missing (measured), and one removed by hand
 * answers "rule not found", exit 1, while the others still go. `--force`: from 0.45 on `rm` asks
 * first, and with stdin closed (runSbx) fails "stdin is not a terminal; use --force to skip
 * confirmation" (measured, 2026-09-24, 0.45.1).
 */
async function revokeStaleHosts(name: string, previous: string[], current: string[]): Promise<void> {
  for (const host of previous.filter((old) => !current.includes(old))) {
    await runSbx(["policy", "rm", "network", "--sandbox", name, "--resource", host, "--force"]);
  }
}

/**
 * What the sandbox has published, what applyProjectPorts brings in line (as readSandboxHosts is
 * for hosts): a port sbx refused at the last Save is missing here and is tried again. Measured, 2026-09-17, sbx 0.42.1: a *stopped* sandbox answers
 * "No published ports" though its ports survive the stop and return with it, so only ask a running
 * one. `--json` is an array of `{host_ip, host_port, sandbox_port, protocol}`.
 */
async function readSandboxPorts(name: string): Promise<SbxPort[]> {
  return parsePublishedPorts((await runSbx(["ports", name, "--json"])).stdout);
}

/** Unreadable reads as none published: every configured port is then tried, and re-publishing one
 *  the sandbox has only answers "already published". */
export function parsePublishedPorts(stdout: string): SbxPort[] {
  try {
    const listed = JSON.parse(stdout) as { host_port?: number; sandbox_port?: number }[];
    return listed
      .filter((entry) => typeof entry?.host_port === "number" && typeof entry.sandbox_port === "number")
      .map((entry) => ({ host: String(entry.host_port), container: String(entry.sandbox_port) }));
  } catch {
    return [];
  }
}

/**
 * Publishes and unpublishes the ports given: only what the sandbox does not have as asked, since
 * re-publishing errors ("already published", verified) — the callers work that out
 * (applyProjectPorts, prepareSbxRun). A published port survives a stop (verified, 2026-09-08), so
 * this runs at Save and at a sandbox's creation, not per spawn. Returns what sbx refused, by `host:container`, with its last line (sbx's
 * `ERROR: …`). Measured, 2026-09-17, sbx 0.42.1: publishing starts a stopped sandbox; a host port
 * another process holds on 127.0.0.1 answers 500, one another sandbox holds 409; `--unpublish` of a
 * port never published exits 0.
 */
async function applyPortChanges(
  name: string,
  delta: { removed: SbxPort[]; added: SbxPort[] },
  onData?: OnData
): Promise<Record<string, string>> {
  const changes = [
    ...delta.removed.map((port) => ["--unpublish", sbxPortKey(port)]),
    ...delta.added.map((port) => ["--publish", sbxPortKey(port)])
  ];
  const refused: Record<string, string> = {};
  for (const [flag, key] of changes) {
    const result = await runSbx(["ports", name, flag, key], { onData });
    if (!result.ok) {
      refused[key] = sbxRefusal(result);
    }
  }
  return refused;
}

/**
 * The placeholder a project's secret goes by in its sandboxes: fixed by tet (`--placeholder`), not
 * sbx's random one, so it outlives a changed value and a rebuild, and `sbx run -e` can name it
 * without asking sbx. The prefix tells tet's secrets from ones set in the sandbox's scope by hand.
 */
export function secretPlaceholder(projectId: string, env: string): string {
  return `${secretPrefix(projectId)}${env}`;
}

function secretPrefix(projectId: string): string {
  return `tet-${projectHash(projectId)}-`;
}

/** A custom secret as `sbx secret ls --json` lists it. */
interface LiveSecret {
  placeholder: string;
  hosts: string[];
}

/**
 * Each sandbox's custom secrets — the truth applySecrets works against, as readSandboxHosts is for
 * hosts — from one `sbx secret ls --json` (`custom_secrets`: `{scope, targets, env, placeholder,
 * secret}`, scope the sandbox's name or "global"; measured, 0.42.1). Never the value: sbx lists
 * only its first characters. Undefined when sbx does not answer: read as none, every secret set
 * would fail as "already exists", and a changed one would never arrive.
 */
async function readSandboxSecrets(): Promise<Map<string, LiveSecret[]> | undefined> {
  const parsed = await sbxJson<{ custom_secrets?: { scope?: string; targets?: string[]; placeholder?: string }[] }>([
    "secret", "ls", "--json"
  ]);
  if (!parsed) {
    return undefined;
  }
  const secrets = new Map<string, LiveSecret[]>();
  for (const secret of parsed.custom_secrets ?? []) {
    if (secret.scope && secret.placeholder) {
      const live = { placeholder: secret.placeholder, hosts: secret.targets ?? [] };
      secrets.set(secret.scope, [...(secrets.get(secret.scope) ?? []), live]);
    }
  }
  return secrets;
}

/**
 * Brings a sandbox's custom secrets in line with the rows that have a value here. Scoped to the
 * sandbox (`--sandbox`), as its hosts are. Measured, 2026-09-18, sbx 0.42.1:
 * - the proxy swaps the placeholder for the value in any request header to a listed host, Basic
 *   auth's base64 included (so git over HTTPS works), never in the URL or body, never for another
 *   host; the swap reaches a *running* sandbox at once.
 * - sbx sets `--env` in the sandbox only at `sbx create`, so tet leaves it out and passes the
 *   placeholder itself with `sbx run -e` (prepareSbxRun), which reaches an existing sandbox too.
 * - `sbx rm` removes the sandbox's secrets with it, and sbx never gives a value back: a new sandbox
 *   is seeded from this machine's store (sbx-local.ts).
 * - no update: a second secret for one placeholder or env fails ("already exists", exit 1), so a
 *   changed one is removed and set again. `rm` without `-f` asks, cancels on closed stdin, exits 0.
 * - the value goes through stdin: `--value` would show in the process list.
 * `changed` holds the env names whose value was just replaced. Returns what sbx refused, by env name.
 */
async function applySecrets(
  name: string,
  projectId: string,
  secrets: SbxSecret[],
  values: ReadonlyMap<string, string>,
  live: LiveSecret[],
  changed: ReadonlySet<string>,
  onData?: OnData
): Promise<Record<string, string>> {
  const wanted = secrets.filter((secret) => values.has(secret.env));
  const ours = live.filter((secret) => secret.placeholder.startsWith(secretPrefix(projectId)));
  const kept = wanted.filter(
    (secret) =>
      !changed.has(secret.env) &&
      ours.some((old) => old.placeholder === secretPlaceholder(projectId, secret.env) && sameSet(old.hosts, secret.hosts))
  );
  const keptPlaceholders = kept.map((secret) => secretPlaceholder(projectId, secret.env));
  for (const old of ours.filter((secret) => !keptPlaceholders.includes(secret.placeholder))) {
    await runSbx(["secret", "rm", "--sandbox", name, "--placeholder", old.placeholder, "-f"], { onData });
  }
  const refused: Record<string, string> = {};
  for (const secret of wanted.filter((entry) => !kept.includes(entry))) {
    const placeholder = secretPlaceholder(projectId, secret.env);
    const hosts = secret.hosts.flatMap((host) => ["--host", host]);
    const result = await runSbx(["secret", "set-custom", "--sandbox", name, "--placeholder", placeholder, ...hosts], {
      stdin: values.get(secret.env),
      onData
    });
    if (!result.ok) {
      refused[secret.env] = sbxRefusal(result);
    }
  }
  return refused;
}

/** A `SandboxSessionMount` with an absolute host side, for `sessionMountSpecs`. */
interface SbxSessionMount {
  host: string;
  target: string;
  file?: boolean;
}

interface SbxRunRequest {
  agentId: SbxAgentId;
  projectId: string;
  projectPath: string;
  config: SbxProjectConfig;
  /** This machine's knowledge for the project (SbxLocalStore.knowledge). */
  knowledge: SbxKnowledgeConfig;
  /** What `checkSbxReady` just listed, so it is not listed again. */
  sandboxes: SandboxList;
  /** The organization managing sbx's policy, as `checkSbxReady` read it (readSbxProblems). */
  organization?: string;
  /** The filesystem rules `checkSbxReady` just read, so they are not listed again. */
  rules?: FilesystemRule[];
  /** The `ensureRunning` the caller began while `checkSbxReady` ran, so the two overlap; mountAll
   *  waits on it. Silent, since the tab it would write into may yet turn out to run on this machine
   *  — a start worth reporting is the one mountAll repeats. Dropped when the sandbox turned out to
   *  need building, as it answers for the one that was there before. */
  warm?: Promise<boolean>;
  paths: SandboxPaths;
  /** The agent's command line after `sbx run`'s "--" — hook and resume arguments. */
  agentArgs: string[];
  /** `AgentDefinition.sandboxEnv` — "KEY=VALUE" entries for `sbx run -e`. */
  env?: string[];
  /** This machine's values of `config.secrets`, by env name (SbxLocalStore.values). */
  secretValues: ReadonlyMap<string, string>;
  /** This machine's values of `config.variables`, likewise. */
  variableValues: ReadonlyMap<string, string>;
  /** Where this agent's sessions land on the host; created if missing, rw, re-applied per spawn. */
  sessionMounts?: SbxSessionMount[];
  /** Setup output, forwarded live to the tab (see `RunOptions.onData`). */
  onData?: OnData;
}

/**
 * Mounts putting a sandboxed agent's sessions on the host (why: SessionProvider.sandbox), rw.
 *
 * The host side is created first (directory or empty file) — `sbx mount` needs it. The container
 * side need not exist (verified, 2026-09-09), and a mount wins over a template's volume there
 * (Claude's `~/.claude/projects`). A host side that cannot be created is left out; one sbx refuses
 * stops the tab like tet's own mounts (prepareSbxRun).
 */
async function sessionMountSpecs(mounts: SbxSessionMount[]): Promise<MountSpec[]> {
  const specs: MountSpec[] = [];
  for (const mount of mounts) {
    try {
      if (mount.file) {
        await fs.mkdir(path.dirname(mount.host), { recursive: true });
        // Never truncate: it is the session index the sandbox appends to.
        await fs.appendFile(mount.host, "");
      } else {
        await fs.mkdir(mount.host, { recursive: true });
      }
      specs.push(mountSpec(mount.host, mount.target, false));
    } catch (error) {
      console.error("[tet] could not prepare sandbox session mount:", error);
    }
  }
  return specs;
}

/**
 * A sandboxed tab's variables for `sbx run -e`: the agent's own and each secret's placeholder as
 * `NAME=value` (`env`), each variable only by name (`passed`, its value for the environment the
 * caller spawns `sbx run` with, as the control channel's are), since the process list shows a
 * command line and a variable's value is real. A variable a name of tet's own or a secret already
 * holds is left out — tet.json and the dialog refuse one, a hand-edited file may not — as is a
 * secret or variable without a value on this machine (a problem, readSbxProblems).
 */
export function sandboxEnv({
  projectId,
  config,
  env: agentEnv = [],
  secretValues,
  variableValues
}: Pick<SbxRunRequest, "projectId" | "config" | "env" | "secretValues" | "variableValues">): {
  env: string[];
  passed: Record<string, string>;
} {
  const secrets = config.secrets.filter((secret) => secretValues.has(secret.env));
  const taken = new Set([
    ...agentEnv.map((entry) => entry.slice(0, entry.indexOf("="))),
    ...Object.values(CONTROL_ENV),
    ...config.secrets.map((secret) => secret.env)
  ]);
  const passed: Record<string, string> = {};
  for (const { env: name } of config.variables.filter((variable) => !taken.has(variable.env))) {
    const value = variableValues.get(name);
    if (value !== undefined) {
      passed[name] = value;
    }
  }
  return {
    env: [...agentEnv, ...secrets.map((secret) => `${secret.env}=${secretPlaceholder(projectId, secret.env)}`)],
    passed
  };
}

/**
 * Readies a tab's sandbox and returns the `sbx run` arguments: tet's mounts, knowledge and Allowed
 * paths, ports, secrets and variables (sandboxEnv: `env` for the caller to spawn `sbx run` with),
 * and with a control channel its env and the `tet-ctl` launcher. Creates the sandbox itself
 * (ensureSandboxExists), since the launcher must be written before `sbx run` starts the agent.
 * Applies tet.json as it stands and never writes it: what cannot be applied here
 * (readSbxProblems), or what sbx refuses, is skipped and returned as `problems` for the caller to
 * tell (sbxProblemNotices) — how a user learns that governance took over. Rejects only when
 * creating fails or a folder of tet's own cannot be mounted.
 */
export async function prepareSbxRun(
  request: SbxRunRequest
): Promise<{ args: string[]; env: Record<string, string>; problems: SbxProblems }> {
  const { agentId, onData, secretValues, variableValues } = request;
  const name = sandboxName(request.projectId, agentId);
  const created = await ensureSandboxExists(agentId, request.projectPath, name, request.sandboxes, onData);
  // Ports, hosts and secrets only reach a sandbox this call created: they survive a stop, and after
  // that a Save brings them in line (saveSbxConfig). A port another sandbox of the project forwards
  // is in place already (applyProjectPorts).
  const forwarded = created && request.config.ports.length > 0 ? await readProjectPorts(request.projectId, request.sandboxes) : new Set<string>();
  const problems = await readSbxProblems({
    projectId: request.projectId,
    config: request.config,
    knowledge: request.knowledge,
    values: { secrets: new Set(secretValues.keys()), variables: new Set(variableValues.keys()) },
    agentIds: [agentId],
    organization: request.organization,
    rules: request.rules,
    ports: created,
    published: forwarded
  });
  const { config, knowledge } = withoutProblems(request.config, request.knowledge, problems);
  const { env, passed } = sandboxEnv({ ...request, config });
  // tet's own folders are not skipped: without them the agent has no hook settings or listable
  // sessions, silently. Everything else is in place by here, so a refusal is sbx's policy, and the
  // tab stops with sbx's reason in its output.
  const own = [
    ...fixedMountSpecs(request.paths),
    ...worktreeMountSpecs(request.projectPath),
    ...(await sessionMountSpecs(request.sessionMounts ?? []))
  ];
  const grants = await grantsOf(agentId, knowledge, config.paths);
  const refused = await mountAll(name, [...own, ...grants], onData, created ? undefined : request.warm);
  const ownFailed = own.filter((spec) => refused.has(spec.mount)).map((spec) => spec.mount);
  if (ownFailed.length > 0) {
    throw new Error(`sbx did not mount tet's own ${ownFailed.length === 1 ? "folder" : "folders"} ${ownFailed.join(", ")} — see the tab's output`);
  }
  for (const grant of grants) {
    const reason = refused.get(grant.mount);
    if (reason !== undefined) {
      addProblems(problems, grant.option, { [grant.row]: reason });
    }
  }
  if (created) {
    // Not under governance, where no local rule applies (allowHosts).
    if (!request.organization) {
      addProblems(problems, "hosts", await allowHosts(name, config.hosts, onData));
    }
    // Not `sbx run -p`: the sandbox always exists by here, and `run --name` drops `-p` on an
    // existing one with a warning, even for a free port (measured, 2026-09-17, sbx 0.42.1).
    const added = config.ports.filter((port) => !forwarded.has(sbxPortKey(port)));
    addProblems(problems, "ports", await applyPortChanges(name, { removed: [], added }, onData));
    // The sandbox's secrets went with any earlier one of its name.
    addProblems(problems, "secrets", await applySecrets(name, request.projectId, config.secrets, secretValues, [], new Set(), onData));
  }
  // No workspace positionals, not even right after creating: the sandbox always exists by now, and
  // sbx run refuses them on an existing one even when unchanged (verified, 2026-09-08: "sandbox 'x'
  // already exists and can't be given new workspaces"). The agent positional is only verified by
  // sbx; `--name` finds the sandbox. The plain agent id even for a kit (AgentDefinition.sandboxKit).
  const args = [
    "run",
    agentId,
    "--name",
    name,
    ...env.flatMap((entry) => ["-e", entry]),
    ...Object.keys(passed).flatMap((variable) => ["-e", variable])
  ];
  if (control) {
    // The tab id too: a hook reports for the tab it runs in (ProjectSessionManager.hookEvent).
    const passThrough = [CONTROL_ENV.port, CONTROL_ENV.token, CONTROL_ENV.projectId, CONTROL_ENV.tabId];
    args.push(...passThrough.flatMap((variable) => ["-e", variable]), "-e", `${CONTROL_ENV.host}=host.docker.internal`);
    // Best-effort: a missing launcher must not keep the agent from starting.
    await ensureSandboxLauncher(name, onData);
  }
  args.push("--", ...request.agentArgs);
  await suppressSbxFirstRunWizard();
  return { args, env: passed, problems };
}

/** The ports the project's sandboxes publish — a stopped one lists none, and holds none. */
async function readProjectPorts(projectId: string, listed?: SandboxList): Promise<Set<string>> {
  const sandboxes = listed ?? (await listSandboxes()) ?? new Map();
  const names = SBX_AGENT_IDS.map((agentId) => sandboxName(projectId, agentId)).filter((name) => sandboxes.has(name));
  return new Set((await Promise.all(names.map(readSandboxPorts))).flat().map(sbxPortKey));
}

/** What readSbxProblems checks: the rows, and what this machine holds for them. */
interface SbxCheck {
  projectId: string;
  config: SbxProjectConfig;
  knowledge: SbxKnowledgeConfig;
  /** The env names holding a value here: stored, or typed at this Save. */
  values: { secrets: ReadonlySet<string>; variables: ReadonlySet<string> };
  /** Whose knowledge is mounted: every agent at Save, the starting one at its spawn. */
  agentIds: readonly SbxAgentId[];
  /** readGovernance's. */
  organization: string | undefined;
  /** readFilesystemRules', when the caller has them already. */
  rules?: FilesystemRule[];
  /** Whether the ports are applied now: at Save, and at the spawn creating a sandbox. */
  ports: boolean;
  /** readProjectPorts', when the caller has it already. */
  published?: ReadonlySet<string>;
}

/**
 * Every row of the SBX Settings that cannot be applied here, with what is wrong: one check for the
 * dialog's live marks, a Save (which saves and applies the rest, saveProjectSbx) and a sandboxed
 * session's start (which skips them and tells, prepareSbxRun). As far as it can be known before
 * applying; what sbx refuses then is a problem too.
 * - hosts: only under governance, asked of the organization's policy (readHostAllowed), as no
 *   local rule applies there (allowHosts). Without it tet adds the rule.
 * - paths and knowledge: must exist, and sbx's filesystem rules allow the mount with its access
 *   (sbx-policy.ts's prediction: sbx has no `policy check` for them).
 * - ports: the host port is free, unless one of the project's sandboxes holds it.
 * - secrets: a value here, and every host reachable; an Allowed host counts without governance.
 * - variables: a value here.
 * The policy questions are sbx processes, asked together.
 */
export async function readSbxProblems(check: SbxCheck): Promise<SbxProblems> {
  const { config, knowledge, values, organization } = check;
  const forbidden = forbiddenBy(organization);
  const problems: SbxProblems = {};
  const add = (option: SbxOption, row: string, reason: string): void => addProblems(problems, option, { [row]: reason });
  const kinds = SBX_KNOWLEDGE_KINDS.filter((kind) => knowledge[kind] !== false);
  const secretHosts = [...new Set(config.secrets.flatMap((secret) => secret.hosts))];
  // A host both allowed and a secret's is asked once.
  const asked = new Map<string, Promise<boolean>>();
  const allowed = (host: string): Promise<boolean> => {
    const pending = asked.get(host) ?? readHostAllowed(host);
    asked.set(host, pending);
    return pending;
  };
  const reachable = async (host: string): Promise<boolean> =>
    (!organization && config.hosts.includes(host)) || (await allowed(host));
  const [rules, hostsAllowed, secretHostsAllowed, published, own] = await Promise.all([
    config.paths.length > 0 || kinds.length > 0 ? (check.rules ?? readFilesystemRules()) : Promise.resolve([]),
    organization ? Promise.all(config.hosts.map(allowed)) : Promise.resolve(config.hosts.map(() => true)),
    Promise.all(secretHosts.map(reachable)),
    check.published ?? (check.ports && config.ports.length > 0 ? readProjectPorts(check.projectId) : new Set<string>()),
    Promise.all(check.agentIds.map((agentId) => sandboxKnowledgeFor(agentId, knowledge.skillsFolder)))
  ]);
  const mountable = mountableBy(rules);

  for (const kind of kinds) {
    const access = knowledge[kind] as SbxAccess;
    if (kind === "skills" && knowledge.skillsFolder !== undefined && !statOf(knowledge.skillsFolder)) {
      add("knowledge", kind, SBX_PROBLEM.missing);
    } else if (own.some((entries) => entries[kind].some((entry) => !mountable(entry.host, access)))) {
      add("knowledge", kind, forbidden);
    }
  }
  if (check.ports) {
    const free = await Promise.all(
      config.ports.map((port) => !isPort(port.host) || published.has(sbxPortKey(port)) || canBind(Number(port.host)))
    );
    config.ports.forEach((port, index) => free[index] || add("ports", sbxPortKey(port), SBX_PROBLEM.portInUse));
  }
  for (const entry of config.paths) {
    if (!statOf(normalizeHostPath(entry.path))) {
      add("paths", entry.path, SBX_PROBLEM.missing);
    } else if (!mountable(entry.path, entry.access)) {
      add("paths", entry.path, forbidden);
    }
  }
  config.hosts.forEach((host, index) => hostsAllowed[index] || add("hosts", host, forbidden));
  for (const secret of config.secrets) {
    if (!values.secrets.has(secret.env)) {
      add("secrets", secret.env, SBX_PROBLEM.noValue);
    } else if (secret.hosts.some((host) => !secretHostsAllowed[secretHosts.indexOf(host)])) {
      add("secrets", secret.env, forbidden);
    }
  }
  for (const variable of config.variables) {
    if (!values.variables.has(variable.env)) {
      add("variables", variable.env, SBX_PROBLEM.noValue);
    }
  }
  return problems;
}

/**
 * Brings the project's forwarded ports to `ports`. A host port is forwarded by one sandbox only —
 * another's publish of it is refused ("409 Conflict … already published", measured) — so a port is
 * in place once any of the project's sandboxes has it: one it is dropped from is unpublished there,
 * a missing one published by the first sandbox that takes it. Each sandbox is started first, as
 * only a running one lists its ports (readSandboxPorts). Returns what no sandbox took, by
 * `host:container`, and a port it would not unpublish.
 */
async function applyProjectPorts(names: string[], ports: SbxPort[]): Promise<Record<string, string>> {
  const started = await Promise.all(names.map((name) => ensureRunning(name)));
  const running = names.filter((_, index) => started[index]);
  const published = await Promise.all(running.map(readSandboxPorts));
  const wanted = new Set(ports.map(sbxPortKey));
  const refused: Record<string, string> = {};
  for (const [index, name] of running.entries()) {
    Object.assign(refused, await applyPortChanges(name, { removed: published[index].filter((port) => !wanted.has(sbxPortKey(port))), added: [] }));
  }
  const forwarded = new Set(published.flat().map(sbxPortKey));
  // The first sandbox that takes it; sbx's last refusal otherwise.
  const publish = async (port: SbxPort): Promise<string | undefined> => {
    let reason: string = SBX_PROBLEM.notStarted;
    for (const name of running) {
      const refusal = (await applyPortChanges(name, { removed: [], added: [port] }))[sbxPortKey(port)];
      if (refusal === undefined) {
        return undefined;
      }
      reason = refusal;
    }
    return reason;
  };
  for (const port of ports.filter((entry) => !forwarded.has(sbxPortKey(entry)))) {
    const reason = await publish(port);
    if (reason !== undefined) {
      refused[sbxPortKey(port)] = reason;
    }
  }
  return refused;
}

/**
 * The dialog's Save of the rows readSbxProblems passed (saveProjectSbx): every sandbox goes if
 * sandboxing is off, one with another workspace too (see ensureSandboxExists; rebuilt at its next
 * tab), and one an earlier id of the project left (orphanAgent). The others are brought in line: ports (applyProjectPorts), hosts both ways without
 * governance (revokeStaleHosts, allowHosts) and secrets (applySecrets), each against the sandboxes'
 * own (readSandboxPorts, readSandboxHosts, readSandboxSecrets), so a hand-set rule deleted as a row
 * goes too and a port never published is tried again. A row sbx refuses in any sandbox is
 * `refused`, left out of tet.json and taken back where it went through — a port it would not
 * unpublish stays, as the sandbox still has it: tet.json holds what was applied. Grants are
 * narrowed last (revokeMounts), a mount cannot be given back at Save; one sbx would not take back
 * is `refused` too, its row and knowledge kind kept as they were. Ports need the sandbox running.
 * A sandbox that cannot be removed rejects, tet.json left as it was. Returns the agents
 * whose sandboxes were removed, for the caller to say so: a running session of theirs just lost its
 * sandbox; those of the earlier ids; what sbx refused; what could not be taken back; and what
 * tet.json and the knowledge now hold.
 */
export async function saveSbxConfig(
  projectPath: string,
  projectId: string,
  request: SbxProjectConfig,
  knowledge: { previous: SbxKnowledgeConfig; current: SbxKnowledgeConfig },
  secretValues: ReadonlyMap<string, string>,
  changedSecrets: ReadonlySet<string>,
  organization: string | undefined
): Promise<{
  removed: SbxAgentId[];
  orphans: SbxAgentId[];
  refused: SbxProblems;
  failures: string[];
  config: SbxProjectConfig;
  knowledge: SbxKnowledgeConfig;
}> {
  const previous = await readSbxConfig(projectPath);
  const config = { ...request, paths: request.paths.map((entry) => ({ ...entry, path: contractHome(entry.path) })) };
  const sandboxes = (await listSandboxes()) ?? new Map();
  const removed: SbxAgentId[] = [];
  const orphans: SbxAgentId[] = [];
  for (const [name, workspaces] of sandboxes) {
    const agentId = orphanAgent(name, workspaces, projectId, projectPath);
    if (agentId === undefined) {
      continue;
    }
    if (!(await removeSandbox(name))) {
      throw new Error(`An earlier ${getAgent(agentId).displayName} sandbox (${name}) could not be removed.`);
    }
    orphans.push(agentId);
  }
  const kept: { agentId: SbxAgentId; name: string }[] = [];
  for (const agentId of SBX_AGENT_IDS) {
    const name = sandboxName(projectId, agentId);
    const existing = sandboxes.get(name);
    if (existing === undefined) {
      continue;
    }
    if (config.enabled && sameSet(existing, [projectPath])) {
      kept.push({ agentId, name });
    } else if (await removeSandbox(name)) {
      removed.push(agentId);
    } else {
      throw new Error(`The ${getAgent(agentId).displayName} sandbox could not be removed.`);
    }
  }
  // Brings every kept sandbox to `target`. The listings answer for every sandbox at once, so they
  // are asked together, and only when the project has one: each is an sbx process (~0.45 s).
  const apply = async (target: SbxProjectConfig): Promise<SbxProblems> => {
    const refused: SbxProblems = {};
    if (kept.length === 0) {
      return refused;
    }
    const secrets = target.secrets.length > 0 || previous.secrets.length > 0;
    const [liveHosts, liveSecrets] = await Promise.all([
      organization ? new Map<string, string[]>() : readSandboxHosts(),
      secrets ? readSandboxSecrets() : new Map<string, LiveSecret[]>()
    ]);
    // Whenever any are configured or were, since what a sandbox published is only readable while it
    // runs: the rows may match tet.json and still be unpublished (ports written before the sandbox
    // existed).
    if (target.ports.length > 0 || previous.ports.length > 0) {
      addProblems(refused, "ports", await applyProjectPorts(kept.map(({ name }) => name), target.ports));
    }
    for (const { name } of kept) {
      if (!organization) {
        const live = liveHosts.get(name) ?? [];
        await revokeStaleHosts(name, live, target.hosts);
        addProblems(
          refused,
          "hosts",
          await allowHosts(
            name,
            target.hosts.filter((host) => !live.includes(host))
          )
        );
      }
      if (secrets) {
        addProblems(
          refused,
          "secrets",
          liveSecrets
            ? await applySecrets(name, projectId, target.secrets, secretValues, liveSecrets.get(name) ?? [], changedSecrets)
            : Object.fromEntries(target.secrets.map((secret) => [secret.env, SBX_PROBLEM.secretsUnlisted]))
        );
      }
    }
    return refused;
  };
  const refused = await apply(config);
  const refusedPort = (port: SbxPort): boolean => refused.ports?.[sbxPortKey(port)] !== undefined;
  const applied: SbxProjectConfig = {
    ...config,
    ports: [
      ...config.ports.filter((port) => !refusedPort(port)),
      ...previous.ports.filter((port) => refusedPort(port) && !config.ports.some((next) => sbxPortKey(next) === sbxPortKey(port)))
    ],
    hosts: config.hosts.filter((host) => refused.hosts?.[host] === undefined),
    secrets: config.secrets.filter((secret) => refused.secrets?.[secret.env] === undefined)
  };
  const failures =
    Object.keys(refused).length > 0 ? sbxProblemNotices(await apply(applied)).map((notice) => `Not taken back: ${notice}`) : [];
  const unrevoked: SbxProblems = {};
  for (const { agentId, name } of kept) {
    const current = new Set((await grantsOf(agentId, knowledge.current, applied.paths)).map((grant) => grant.mount));
    const stale = (await grantsOf(agentId, knowledge.previous, previous.paths)).filter((grant) => !current.has(grant.mount));
    if (stale.length > 0) {
      await revokeMounts(name, stale, unrevoked);
    }
  }
  // A grant sbx would not take back is still there: its row stays as it was.
  const stays = new Set(Object.keys(unrevoked.paths ?? {}).map(normalizeHostPath));
  applied.paths = [
    ...applied.paths.filter((entry) => !stays.has(normalizeHostPath(entry.path))),
    ...previous.paths.filter((entry) => stays.has(normalizeHostPath(entry.path))).map((entry) => ({ ...entry, path: contractHome(entry.path) }))
  ];
  const appliedKnowledge = { ...knowledge.current };
  for (const kind of SBX_KNOWLEDGE_KINDS.filter((candidate) => unrevoked.knowledge?.[candidate] !== undefined)) {
    appliedKnowledge[kind] = knowledge.previous[kind];
    if (kind === "skills") {
      appliedKnowledge.skillsFolder = knowledge.previous.skillsFolder;
    }
  }
  for (const [option, rows] of Object.entries(unrevoked) as [SbxOption, Record<string, string>][]) {
    addProblems(refused, option, rows);
  }
  await writeSbxConfig(projectPath, applied);
  return { removed, orphans, refused, failures, config: applied, knowledge: appliedKnowledge };
}
