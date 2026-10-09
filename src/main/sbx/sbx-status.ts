import * as os from "node:os";
import * as path from "node:path";
import type { ProjectRef } from "../../shared/types/project";
import type { SbxAccess, SbxBlocker, SbxStatus } from "../../shared/types/sbx";
import { SANDBOXED_AGENTS } from "../agents";
import { readLinkedGitDir } from "../util/linked-git-dir";
import { normalizeHostPath, relativeInside } from "../util/path-inside";
import {
  isMountAllowed,
  parseFilesystemRules,
  parseGovernance,
  parseSbxJson,
  sbxBlocked,
  sbxNotReady,
  type FilesystemRule,
  type PathFlavor,
} from "./sbx-policy";
import { projectsDir, sandboxDir } from "../store/project-dirs";
import { augmentAgentPath } from "../agents/agent-path";
import { PLATFORM } from "../util/host-platform";
import { jsonOf, readSbxVersion, runSbx, SBX_PROBE_TIMEOUT_MS, sbxFailure, sbxVersionSupported, type RunResult } from "./sbx-cli";

/** The `tet-ctl` bundle (ensureSandboxLauncher) and control port (isControlChannelAllowed), set
 *  by prepareControl (ctl-channel.ts). Unset without a control channel, and then nothing of it reaches a sandbox. */
let control: { cliPath: string; port: number } | undefined;
/** TET's data folder, holding its mounted folders (readSbxBlockers, project-dirs.ts). */
let dataRoot: string | undefined;
export function configureSandboxes(cliPath: string, port: number, root: string): void {
  control = { cliPath, port };
  dataRoot = root;
}

/** The control channel configureSandboxes was given, for a sandboxed tab's env and launcher
 *  (sbx.ts's prepareSbxRun). */
export function sandboxControl(): { cliPath: string; port: number } | undefined {
  return control;
}

/** Whether sbx is signed in to Docker, as probeSbx tells it: its sandbox listing answers. */
export async function readSbxSignedIn(): Promise<boolean> {
  return (await listSandboxes()) !== undefined;
}

/** `sbx ls --json` as name → workspaces. */
export type SandboxList = Map<string, string[]>;

/**
 * Before every sandboxed spawn (`resolvePlace`): the first unmet precondition as a notice, or the
 * sandbox listing the sign-in probe's `sbx ls` produced and the filesystem rules the policy check
 * read, for `prepareSbxRun`. The policy check (readSbxBlockers) repeats the dialog's: a policy
 * changes outside TET, and an agent whose hooks cannot reach TET or whose folders are unmounted
 * runs with no turn marks and no reason given.
 */
export async function checkSbxReady(
  projectRefPath: string,
  ref: ProjectRef,
): Promise<{ notReady: string } | { sandboxes: SandboxList; organization?: string; rules?: FilesystemRule[] }> {
  // No PATH re-read on the spawn path: on macOS/Linux that is a login shell per call.
  const { status, sandboxes, policy } = await probeSbx(false);
  const notReady = sbxNotReady(status);
  // A listing exists whenever signed in (probeSbx); `!sandboxes` only narrows it.
  if (notReady !== undefined || !sandboxes) {
    return { notReady: notReady ?? "SBX is not signed in to Docker" };
  }
  const { blockers, rules, failure } = await readSbxBlockers(projectRefPath, ref, policy?.rules);
  if (failure !== undefined) {
    return { notReady: `SBX failed: ${failure}` };
  }
  const blocked = sbxBlocked(blockers, status.organization);
  if (blocked !== undefined) {
    return { notReady: blocked };
  }
  return { sandboxes, organization: status.organization, rules };
}

/** A status with what was read on the way to it: the sandboxes (signed in) and the filesystem
 *  rules (the policy read), for a caller asking more of sbx at once (tet-ctl's sbx verbs). */
export interface SbxReading {
  status: SbxStatus;
  sandboxes?: SandboxList;
  rules?: FilesystemRule[];
}

/**
 * What the sbx-settings dialog asks before showing its fields. PATH is re-read: "Check again"
 * follows an install. Nothing cached — sbx changes from outside TET at any time.
 */
export async function readSbxStatus(projectRefPath: string, ref: ProjectRef): Promise<SbxStatus> {
  return (await readSbxReading(projectRefPath, ref, true)).status;
}

/** readSbxStatus, with what it read on the way. `refreshPath` only where an install may have
 *  happened since (the dialog's "Check again"): on macOS/Linux that is a login shell per call. */
export async function readSbxReading(projectRefPath: string, ref: ProjectRef, refreshPath: boolean): Promise<SbxReading> {
  const { status, sandboxes, policy } = await probeSbx(refreshPath);
  if (!status.policyInitialized) {
    return { status, sandboxes };
  }
  const { blockers, rules, failure } = await readSbxBlockers(projectRefPath, ref, policy?.rules);
  status.blockers = blockers;
  status.failure = failure;
  return { status, sandboxes, rules };
}

/** A rule covering a folder and below: under home as `~`, in this platform's separators — a rule
 *  matches only its own path format. */
function folderRule(folder: string): string {
  const relative = relativeInside(os.homedir(), folder);
  return path.join(relative !== undefined ? path.join("~", relative) : folder, "**");
}

/**
 * What sbx's policy must still allow for a sandboxed tab: the control channel
 * (isControlChannelAllowed), the repository or worktree as workspace, and TET's mounted folders —
 * each agent's sandbox folder rw (fixedMountSpecs). Checked as mounted, asked for as one rule over
 * projectsDir, which covers a worktree TET made as well, read and write. `rules` are the probe's
 * (probeSbx), evaluated in sbx-policy.ts. The user's Allowed paths and knowledge are not asked
 * for — a tab starts without them. The rules are returned too, for a spawn's readSbxProblems.
 * Either unanswered is a `failure`, never a blocker: could-not-say is no refusal, and the rules it
 * would ask for may well be there.
 */
async function readSbxBlockers(
  projectRefPath: string,
  ref: ProjectRef,
  rules: FilesystemRule[] | undefined,
): Promise<{ blockers: SbxBlocker[]; rules?: FilesystemRule[]; failure?: string }> {
  const channelAllowed = await isControlChannelAllowed();
  if (channelAllowed === undefined || rules === undefined) {
    return { blockers: [], failure: "its policy could not be read" };
  }
  const blockers: SbxBlocker[] = [];
  if (!channelAllowed) {
    blockers.push({ what: "TET's hooks", allow: "localhost (network, no port)" });
  }
  const mountable = mountableBy(rules);
  const projects = dataRoot === undefined ? undefined : projectsDir(dataRoot);
  // A worktree TET made lies under projectsDir, which the rule below covers.
  const ownWorktree = ref.worktree !== undefined;
  if (!ownWorktree && !mountable(projectRefPath, "rw")) {
    blockers.push({ what: "The project", allow: `${folderRule(projectRefPath)} (read and write)` });
  }
  const repositoryGitDir = readLinkedGitDir(projectRefPath)?.commonDir;
  if (repositoryGitDir !== undefined && !mountable(repositoryGitDir, "rw")) {
    blockers.push({ what: "The worktree's repository", allow: `${folderRule(repositoryGitDir)} (read and write)` });
  }
  if (dataRoot !== undefined && projects !== undefined) {
    const root = dataRoot;
    const own =
      SANDBOXED_AGENTS.every((agent) => mountable(sandboxDir(root, ref, agent.id), "rw")) &&
      (!ownWorktree || mountable(projectRefPath, "rw"));
    if (!own) {
      blockers.push({ what: "TET's project data", allow: `${folderRule(projects)} (read and write)` });
    }
  }
  return { blockers, rules };
}

/** This machine's paths, as sbx-policy.ts compares them. */
function hostFlavor(): PathFlavor {
  return { platform: PLATFORM, home: os.homedir() };
}

/** What one `sbx policy ls --type filesystem --json` says: the filesystem rules, evaluated in TET
 *  (sbx-policy.ts: sbx has no `policy check` for them), and the organization managing the policy. */
export interface SbxPolicy {
  rules: FilesystemRule[];
  organization?: string;
}

function policyOf(listed: RunResult): SbxPolicy | undefined {
  return listed.ok ? { rules: parseFilesystemRules(listed.stdout), organization: parseGovernance(listed.stdout) } : undefined;
}

/** Undefined when sbx cannot say. */
export async function readPolicy(): Promise<SbxPolicy | undefined> {
  return policyOf(await runSbx(["policy", "ls", "--type", "filesystem", "--json"]));
}

/** Whether the rules let a path of this machine be mounted with that access. */
export function mountableBy(rules: FilesystemRule[]): (hostPath: string, access: SbxAccess) => boolean {
  return (hostPath, access) => isMountAllowed(rules, normalizeHostPath(hostPath), access, hostFlavor());
}

/**
 * Whether sbx's network policy lets a sandbox reach the host, asked as isNetworkAllowed does
 * (readSbxProblems). True for a wildcard, which `policy check` would take as a literal name. One
 * host per call, all asked at once: sbx queues them on its own lock, so a cap gains nothing.
 */
export async function readHostAllowed(host: string): Promise<boolean> {
  if (host.includes("*")) {
    return true;
  }
  const allowed = await isNetworkAllowed(host);
  if (allowed === undefined) {
    throw new Error(`SBX could not say whether ${host} is allowed.`);
  }
  return allowed;
}

/**
 * Behind both. Three processes, always, started together since each sbx invocation pays its CLI
 * startup: `version` says installed and whether old enough to be reported as a failure
 * (sbxVersionSupported), `policy ls`'s exit code says initialized, its output governed. The answers
 * are read in order, so the first "no" is the one reported — `sbx policy ls` fails when signed out
 * too.
 *
 * `sbx ls` is the sign-in probe: side-effect-free, exits 1 with "Not authenticated to Docker" when
 * signed out, and `prepareSbxRun` needs its listing. Not `sbx policy ls`, which also exits 1 signed
 * in without a policy. Only that text reads as signed out; any other error is reported as sbx's
 * own.
 *
 * A governed account's `sbx policy ls --json` names its organization (parseGovernance).
 * Governance words a blocker and hides the dialog's Allowed hosts; what is allowed is asked of the
 * policy (readSbxBlockers).
 */
async function probeSbx(refreshPath: boolean): Promise<SbxProbe> {
  if (refreshPath) {
    return readProbe(true);
  }
  probing ??= readProbe(false).finally(() => {
    probing = undefined;
  });
  const { status, ...read } = await probing;
  // Each caller's own status: readSbxReading sets the blockers of its repository on it.
  return { ...read, status: { ...status, blockers: [...status.blockers] } };
}

interface SbxProbe {
  status: SbxStatus;
  sandboxes?: SandboxList;
  policy?: SbxPolicy;
}

/** The probe underway without a PATH re-read, joined by every caller meanwhile: a project's
 *  sandboxed tabs start together. Let go of once answered, so nothing is cached. */
let probing: Promise<SbxProbe> | undefined;

async function readProbe(refreshPath: boolean): Promise<SbxProbe> {
  const status: SbxStatus = { installed: false, signedIn: false, policyInitialized: false, blockers: [] };
  if (refreshPath) {
    await augmentAgentPath();
  }
  const [version, list, listedPolicy] = await Promise.all([
    readSbxVersion(),
    runSbx(["ls", "--json"], { timeoutMs: SBX_PROBE_TIMEOUT_MS }),
    runSbx(["policy", "ls", "--type", "filesystem", "--json"], { timeoutMs: SBX_PROBE_TIMEOUT_MS }),
  ]);
  const policy = policyOf(listedPolicy);
  status.installed = version !== undefined;
  if (version === undefined) {
    return { status };
  }
  if (version && !sbxVersionSupported(version)) {
    status.failure = `version ${version} is too old, TET needs 0.45 or later`;
    return { status };
  }
  const sandboxes = parseSandboxes(list);
  if (!sandboxes) {
    // Text, since `sbx ls` fails signed out with the same exit code as any other failure and no
    // other cheap command says it. Worth checking on a newer sbx for a structured answer.
    if (!/not authenticated/i.test(list.stderr)) {
      status.failure = sbxFailure(list, "sbx ls");
    }
    return { status };
  }
  status.signedIn = true;
  status.policyInitialized = policy !== undefined;
  status.organization = policy?.organization;
  return { status, sandboxes, policy };
}

/** A yes is kept for the run; a no, or no answer, is asked again next spawn, as the policy may
 *  change. */
let controlAllowed: Promise<boolean | undefined> | undefined;

/**
 * `sbx policy check` asks the same authorizer the sandbox's proxy does, so no matching is
 * reproduced. A denial exits 1 with `"allowed": false`, JSON on stdout either way — so the exit
 * code says nothing, and no answer on stdout is sbx that cannot say (undefined).
 */
async function isNetworkAllowed(target: string): Promise<boolean | undefined> {
  const checked = await runSbx(["policy", "check", "network", "--json", target]);
  try {
    const { allowed } = parseSbxJson(checked.stdout) as { allowed?: unknown };
    return typeof allowed === "boolean" ? allowed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the sandbox reaches the control channel, allowing it first if not: as `localhost:<port>`,
 * since sbx's proxy rewrites `host.docker.internal` to `localhost` before the policy. Rechecked
 * after the allow, which a deny rule outranks. On a governed account every local `policy allow`
 * fails, so only the organization can allow it — without a port, as the port is probed per run
 * (findControlPort). True without a control channel; undefined where sbx could not say.
 */
async function isControlChannelAllowed(): Promise<boolean | undefined> {
  if (!control) {
    return true;
  }
  const resource = `localhost:${control.port}`;
  controlAllowed ??= (async () => {
    const allowed = await isNetworkAllowed(resource);
    if (allowed !== false) {
      return allowed;
    }
    return (await runSbx(["policy", "allow", "network", resource])).ok ? isNetworkAllowed(resource) : false;
  })();
  const allowed = await controlAllowed;
  if (allowed !== true) {
    controlAllowed = undefined;
  }
  return allowed;
}

/** Undefined when `sbx ls` fails, as it does signed out (probeSbx). One process for all sandboxes. */
export async function listSandboxes(): Promise<SandboxList | undefined> {
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
