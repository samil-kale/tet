import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { statSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONTROL_ENV } from "../shared/control";
import { SBX_AGENT_IDS } from "../shared/types";
import type { SbxAgentId, SbxBlocker, SbxKnowledgeConfig, SbxPath, SbxPort, SbxProjectConfig, SbxStatus } from "../shared/types";
import type { AgentPaths } from "./agents/agent";
import { readSbxConfig, writeSbxConfig } from "./git/commands";
import { mapLimited } from "./map-limited";
import { relativeInside } from "./path-inside";
import { isMountAllowed, parseFilesystemRules } from "./sbx-policy";
import { agentDataDir, agentDirFor } from "./terminals/agent-data";
import { augmentAgentPath } from "./terminals/agent-path";
import { SANDBOX_HOME, toContainerPath } from "./terminals/hook-target";
import { resolveCommand } from "./terminals/pty";
import { checkAgentInstalled } from "./terminals/terminal-session";

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

/** For the dialog's Cancel. Plain `kill()` suffices: `sbx.exe` is native, no cmd.exe shim (unlike
 *  `ask.ts`). */
export function cancelSbxSetup(): void {
  currentChild?.kill();
  currentChild = undefined;
}

/** `version` is a subcommand; `sbx --version` fails with "unknown flag". */
export function isSbxInstalled(): Promise<boolean> {
  return checkAgentInstalled("sbx", ["version"], os.tmpdir());
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
 * sandbox listing the sign-in probe's `sbx ls` produced, for `prepareSbxRun`. The policy check
 * (readSbxBlockers) repeats the dialog's: a policy changes outside tet, and an agent whose hooks
 * cannot reach tet or whose folders are unmounted runs with no turn marks and no reason given.
 */
export async function checkSbxReady(projectPath: string, projectId: string): Promise<{ notReady: string } | { sandboxes: SandboxList }> {
  // No PATH re-read on the spawn path: on macOS/Linux that is a login shell per call.
  const { status, sandboxes } = await probeSbx(false);
  if (!status.installed) {
    return { notReady: "SBX is not installed (or no longer on PATH)" };
  }
  if (!status.loggedIn || !sandboxes) {
    return { notReady: "SBX is not signed in to Docker" };
  }
  if (!status.policyInitialized) {
    return { notReady: "SBX's network policy is not set up" };
  }
  const blockers = await readSbxBlockers(projectPath, projectId);
  if (blockers.length > 0) {
    const policy = status.governed ? "your organization's SBX policy" : "SBX's policy";
    return { notReady: `${policy} does not allow ${blockers.map((blocker) => blocker.allow).join("; ")}` };
  }
  return { sandboxes };
}

/**
 * What the sbx-settings dialog asks before showing its fields. PATH is re-read: "Check again"
 * follows an install. Nothing cached — sbx changes from outside tet at any time.
 */
export async function readSbxStatus(projectPath: string, projectId: string): Promise<SbxStatus> {
  const { status } = await probeSbx(true);
  if (status.policyInitialized) {
    status.blockers = await readSbxBlockers(projectPath, projectId);
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
 * Both questions are asked at once, for the same reason probeSbx asks its three that way.
 */
export async function readSbxBlockers(projectPath: string, projectId: string): Promise<SbxBlocker[]> {
  const [channelAllowed, filesystem] = await Promise.all([
    isControlChannelAllowed(),
    runSbx(["policy", "ls", "--type", "filesystem", "--json"])
  ]);
  const blockers: SbxBlocker[] = [];
  if (!channelAllowed) {
    blockers.push({ what: "tet's hooks", allow: "localhost (network, no port)" });
  }
  const rules = parseFilesystemRules(filesystem.stdout);
  const flavor = { platform: process.platform, home: os.homedir() };
  const mountable = (hostPath: string, access: "ro" | "rw") => isMountAllowed(rules, hostPath, access, flavor);
  if (!mountable(projectPath, "rw")) {
    blockers.push({ what: "The project", allow: `${folderRule(projectPath)} (read and write)` });
  }
  if (storageRoot) {
    const root = storageRoot;
    const own = SBX_AGENT_IDS.every((agentId) => mountable(agentDirFor(root, agentId, projectId), "rw"));
    if (!own) {
      blockers.push({ what: "tet's agent data", allow: `${folderRule(agentDataDir(root))} (read and write)` });
    }
  }
  return blockers;
}

/**
 * Behind both. Three processes, always: `policy ls`'s exit code says initialized, its output
 * governed, and asking it and `ls` before the answers are read costs nothing but two processes on a
 * machine without sbx. They start together because an sbx invocation is ~0.45 s of CLI startup,
 * which a spawn pays five times over (with readSbxBlockers): 2.26 s in a row against 1.58 s as
 * these two groups, same answers (measured, 2026-09-16, 0.42.1). The answers are still read in
 * order, so the first "no" is still the one reported — `sbx policy ls` fails when signed out too.
 *
 * `sbx ls` is the sign-in probe: side-effect-free, exits 1 with "Not authenticated to Docker" when
 * signed out, and `prepareSbxRun` needs its listing. Not `sbx policy ls`, which also exits 1 signed
 * in without a policy. Any failure reads as signed out — a needless login costs one glance.
 *
 * A governed account's `sbx policy ls` opens with "Governance: Managed by <org>", SOURCE "org"
 * (measured, 0.42.1; ungoverned: "local" or "kit", no such line). Governance only words a blocker;
 * what is allowed is asked of the policy (readSbxBlockers).
 */
async function probeSbx(refreshPath: boolean): Promise<{ status: SbxStatus; sandboxes?: SandboxList }> {
  const status: SbxStatus = { installed: false, loggedIn: false, policyInitialized: false, governed: false, blockers: [] };
  if (refreshPath) {
    await augmentAgentPath();
  }
  const [installed, sandboxes, policy] = await Promise.all([isSbxInstalled(), listSandboxes(), runSbx(["policy", "ls"])]);
  status.installed = installed;
  if (!status.installed) {
    return { status };
  }
  status.loggedIn = sandboxes !== undefined;
  if (!status.loggedIn) {
    return { status };
  }
  status.policyInitialized = policy.ok;
  status.governed = policy.ok && /managed by/i.test(policy.stdout);
  return { status, sandboxes };
}

/** A yes is kept for the run; a no is asked again next spawn, as the policy may change. */
let controlAllowed: Promise<boolean> | undefined;

/**
 * `sbx policy check` asks the same authorizer the sandbox's proxy does, so no matching is
 * reproduced. A denial exits 1 with `"allowed": false`; JSON on stdout either way (measured, 0.42.1).
 */
async function isNetworkAllowed(target: string): Promise<boolean> {
  const result = await runSbx(["policy", "check", "network", "--json", target]);
  try {
    return (JSON.parse(result.stdout) as { allowed?: boolean }).allowed === true;
  } catch {
    return false;
  }
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
  const hash = crypto.createHash("sha1").update(projectId).digest("hex").slice(0, 12);
  return `tet-${agentId}-${hash}`;
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
 * A live bind mount's `sbx mount` and `sbx umount` specs. `mount` carries the access, so equal
 * `mount`s are the same grant (`staleMounts`).
 */
export interface MountSpec {
  mount: string;
  unmount: string;
}

/**
 * One allowed-path row as a live mount (not a create positional, see fixedMountSpecs). `sbx mount`
 * is `HOST[:CTR_TARGET[:ro|rw]]`, and `HOST:ro` parses "ro" as the target ("must be absolute"). So
 * `rw` is the bare host path (same path inside); `ro` needs three parts, and the host path as
 * target breaks on Windows (two drive colons) — `toContainerPath` works. `sbx umount` takes
 * `HOST[:CTR_TARGET]`, and an explicit-target mount is revoked with that target.
 *
 * A single file takes both forms (measured, 0.42.1).
 */
export function pathMountSpecs(entry: SbxPath): MountSpec {
  const host = normalizeHostPath(entry.path);
  if (entry.access === "rw") {
    return { mount: host, unmount: host };
  }
  const target = toContainerPath(host);
  return { mount: `${host}:${target}:ro`, unmount: `${host}:${target}` };
}

/** Undefined for nothing — only what exists is mounted. */
function statOf(candidate: string): Stats | undefined {
  try {
    return statSync(candidate);
  } catch {
    return undefined;
  }
}

export type SandboxPaths = Pick<AgentPaths, "agentDir">;

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
 * replace the host's. Knowledge (knowledgePaths) and sessions (sessionMountSpecs) are curated
 * subpaths, never the directory holding credentials.
 */
export function fixedMountSpecs(paths: SandboxPaths): string[] {
  return [pathMountSpecs({ path: paths.agentDir, access: "rw" }).mount];
}

interface KnowledgeEntry {
  host: string;
  target: string;
}

/**
 * The agent's shareable knowledge on the host, per `SbxKnowledgeConfig` kind — never the config
 * directory (fixedMountSpecs). The caller drops paths that do not exist.
 *
 * Claude (measured): `~/.claude/skills`, `~/.claude/plugins`, `~/.claude/CLAUDE.md`. Codex
 * (measured): skills in `~/.codex/skills` and `~/.agents/skills` (its "failed to load skill" log
 * names both); all of `~/.codex/plugins` (code under `plugins/cache/…`); `~/.codex/AGENTS.md`,
 * `AGENTS.override.md` preferred per its load order. opencode (documented, not verified): skills in
 * `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`; `~/.config/opencode/plugins`;
 * rules `~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md`. Its config directory (the
 * user's providers in `opencode.json`) stays out; auth is under `~/.local/share/opencode`.
 */
function knowledgePaths(agentId: SbxAgentId): Record<keyof SbxKnowledgeConfig, KnowledgeEntry[]> {
  const home = os.homedir();
  if (agentId === "pi") {
    // Per pi's bundled docs (0.85.1): skills in `~/.pi/agent/skills` and `~/.agents/skills`,
    // extensions in `~/.pi/agent/extensions`, `~/.pi/agent/AGENTS.md` (`AGENTS.override.md`
    // preferred) — at their defaults, as `PI_CODING_AGENT_DIR` is never set.
    const instructionsHost = [path.join(home, ".pi", "agent", "AGENTS.override.md"), path.join(home, ".pi", "agent", "AGENTS.md")].find(statOf);
    return {
      skills: [
        { host: path.join(home, ".pi", "agent", "skills"), target: `${SANDBOX_HOME}/.pi/agent/skills` },
        { host: path.join(home, ".agents", "skills"), target: `${SANDBOX_HOME}/.agents/skills` }
      ],
      plugins: [{ host: path.join(home, ".pi", "agent", "extensions"), target: `${SANDBOX_HOME}/.pi/agent/extensions` }],
      instructions: instructionsHost ? [{ host: instructionsHost, target: `${SANDBOX_HOME}/.pi/agent/AGENTS.md` }] : []
    };
  }
  if (agentId === "claude") {
    return {
      skills: [{ host: path.join(home, ".claude", "skills"), target: `${SANDBOX_HOME}/.claude/skills` }],
      plugins: [{ host: path.join(home, ".claude", "plugins"), target: `${SANDBOX_HOME}/.claude/plugins` }],
      instructions: [{ host: path.join(home, ".claude", "CLAUDE.md"), target: `${SANDBOX_HOME}/.claude/CLAUDE.md` }]
    };
  }
  if (agentId === "opencode") {
    const rules = [
      { host: path.join(home, ".config", "opencode", "AGENTS.md"), target: `${SANDBOX_HOME}/.config/opencode/AGENTS.md` },
      { host: path.join(home, ".claude", "CLAUDE.md"), target: `${SANDBOX_HOME}/.claude/CLAUDE.md` }
    ].find((entry) => statOf(entry.host));
    return {
      skills: [
        { host: path.join(home, ".config", "opencode", "skills"), target: `${SANDBOX_HOME}/.config/opencode/skills` },
        { host: path.join(home, ".claude", "skills"), target: `${SANDBOX_HOME}/.claude/skills` },
        { host: path.join(home, ".agents", "skills"), target: `${SANDBOX_HOME}/.agents/skills` }
      ],
      plugins: [{ host: path.join(home, ".config", "opencode", "plugins"), target: `${SANDBOX_HOME}/.config/opencode/plugins` }],
      instructions: rules ? [rules] : []
    };
  }
  const instructionsHost = [path.join(home, ".codex", "AGENTS.override.md"), path.join(home, ".codex", "AGENTS.md")].find(statOf);
  return {
    skills: [
      { host: path.join(home, ".codex", "skills"), target: `${SANDBOX_HOME}/.codex/skills` },
      { host: path.join(home, ".agents", "skills"), target: `${SANDBOX_HOME}/.agents/skills` }
    ],
    plugins: [{ host: path.join(home, ".codex", "plugins"), target: `${SANDBOX_HOME}/.codex/plugins` }],
    instructions: instructionsHost ? [{ host: instructionsHost, target: `${SANDBOX_HOME}/.codex/AGENTS.md` }] : []
  };
}

/**
 * Mounts (`HOST:TARGET[:ro]`) for the enabled knowledge kinds that exist here. A bind mount, not a
 * symlink: sbx cannot follow one out of its workspace. Folders and files both work (measured).
 */
function knowledgeMountSpecs(agentId: SbxAgentId, knowledge: SbxKnowledgeConfig): MountSpec[] {
  const paths = knowledgePaths(agentId);
  return (Object.keys(knowledge) as (keyof SbxKnowledgeConfig)[]).flatMap((kind) => {
    const access = knowledge[kind];
    if (!access) {
      return [];
    }
    const suffix = access === "ro" ? ":ro" : "";
    return paths[kind]
      .filter((entry) => statOf(entry.host))
      .map((entry) => ({ mount: `${entry.host}:${entry.target}${suffix}`, unmount: `${entry.host}:${entry.target}` }));
  });
}

/**
 * Every grant the dialog changes (Allowed paths, knowledge), as one list: Save narrows and each
 * spawn re-applies the same set (mountAll, staleMounts). Only what exists here; a missing row is
 * reported by prepareSbxRun (`missing`).
 */
function grantedMounts(agentId: SbxAgentId, config: SbxProjectConfig): MountSpec[] {
  return [
    ...knowledgeMountSpecs(agentId, config.knowledge),
    ...config.paths.filter((entry) => statOf(normalizeHostPath(entry.path))).map(pathMountSpecs)
  ];
}

/** Unmounts for grants `current` dropped; by `mount`, so rw→ro is a different grant. */
function staleMounts(previous: MountSpec[], current: MountSpec[]): string[] {
  return previous.filter((old) => !current.some((next) => next.mount === old.mount)).map((old) => old.unmount);
}

/** Sandboxes given the `tet-ctl` launcher this run; cleared in removeSandbox. */
const launcherWritten = new Set<string>();

/** The `sbx create` (or rebuild) underway per sandbox name — see ensureSandboxExists. */
const sandboxSetups = new Map<string, Promise<boolean>>();

/** Undefined when `sbx ls` fails, as it does signed out (probeSbx). One process for all sandboxes. */
async function listSandboxes(): Promise<SandboxList | undefined> {
  const result = await runSbx(["ls", "--json"]);
  if (!result.ok) {
    return undefined;
  }
  const sandboxes: SandboxList = new Map();
  try {
    const parsed = JSON.parse(result.stdout) as { sandboxes?: { name?: string; workspaces?: string[] }[] };
    for (const sandbox of parsed.sandboxes ?? []) {
      if (sandbox.name) {
        sandboxes.set(sandbox.name, sandbox.workspaces ?? []);
      }
    }
  } catch {
    // Unreadable reads as none.
  }
  return sandboxes;
}

/**
 * Each sandbox's Allowed hosts — the truth for that list (tet.json only seeds a new sandbox, see
 * readLiveSbxConfig), from one `policy ls`. A rule counts when an allow scoped `sandbox:<name>` and
 * editable, as `sbx policy allow network --sandbox` makes it (measured, 0.42.1); a kit's rule is
 * not editable, a global one is the machine's. One rule per resource, so the list is their union.
 */
async function readSandboxHosts(): Promise<Map<string, string[]>> {
  const hosts = new Map<string, string[]>();
  try {
    const parsed = JSON.parse((await runSbx(["policy", "ls", "--type", "network", "--json"])).stdout) as {
      rules?: { scope?: string; decision?: string; editable?: boolean; resources?: string[] }[];
    };
    for (const rule of parsed.rules ?? []) {
      if (rule.decision !== "allow" || !rule.editable || !rule.scope?.startsWith("sandbox:")) {
        continue;
      }
      const name = rule.scope.slice("sandbox:".length);
      hosts.set(name, [...(hosts.get(name) ?? []), ...(rule.resources ?? [])]);
    }
  } catch {
    // Unreadable reads as no rules.
  }
  return hosts;
}

/**
 * What the dialog opens with: tet.json, but Allowed hosts from the project's sandboxes if any (a
 * rule changed by hand shows as it stands), several as one union; Save writes them back equal.
 *
 * Only hosts read back (measured, 0.42.1): policy rules answer for a stopped sandbox, but `sbx
 * ports` lists nothing for one (reading would start them all), and mounts have no listing and do
 * not survive a stop. So for paths, knowledge and ports tet.json is the truth, applied whole at
 * every spawn and narrowed by delta at Save. No watch mode: a live read is a snapshot.
 */
export async function readLiveSbxConfig(projectPath: string, projectId: string): Promise<SbxProjectConfig> {
  const config = await readSbxConfig(projectPath);
  const sandboxes = (await listSandboxes()) ?? new Map();
  const existing = SBX_AGENT_IDS.map((agentId) => sandboxName(projectId, agentId)).filter((name) => sandboxes.has(name));
  if (existing.length === 0) {
    return config;
  }
  const live = await readSandboxHosts();
  return { ...config, hosts: [...new Set(existing.flatMap((name) => live.get(name) ?? []))] };
}

function sameWorkspaceSet(a: string[], b: string[]): boolean {
  const sorted = (list: string[]) => [...list].sort();
  const [left, right] = [sorted(a), sorted(b)];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function removeSandbox(name: string, onData?: OnData): Promise<boolean> {
  launcherWritten.delete(name);
  return (await runSbx(["rm", name, "--force"], { onData })).ok;
}

/**
 * Starts a stopped sandbox with a cheap `exec`: `sbx mount`, `umount` and `ports` refuse one
 * ("409 Conflict"). False also when it does not exist — the same to its best-effort callers.
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
 * `sbx create`'s agent argument where it is not the agent id: pi has no built-in kit (not in
 * `sbx create --help` at 0.42.1), so it is the community kit `docker.io/sbx/pi-kit`
 * (docker/sbx-kits-contrib), whose image (shell-docker plus pi, rebuilt nightly) sbx pulls on the
 * first create — nothing installed here; home is `/home/agent` like every built-in.
 *
 * Verified live, 2026-09-09, sbx 0.42.1 (0.39.0 cannot read the kit's v2 manifest):
 * - it is the *first positional*; `--kit` is deprecated there and means a mixin onto a built-in.
 * - only `create` needs it: `sbx run` reattaches by `--name`, and `prepareSbxRun` passes plain
 *   `pi`, the name the kit declares (and `sbx ls --json`'s `agent`).
 * - auth is not tet's: pi has no `/login`, so its kit takes an Anthropic credential from sbx's
 *   store (`sbx secret set anthropic`, a `claude` sandbox's OAuth login, or `claude setup-token`).
 *   Without one the sandbox starts and every model call is a 401.
 */
const SBX_CREATE_TARGET: Partial<Record<SbxAgentId, string>> = { pi: "docker.io/sbx/pi-kit:latest" };

/**
 * Ensures a sandbox whose one workspace is this project — all else is mounted live, so this is
 * all `sbx create` is told. A different workspace means a rebuild: an older tet's sandbox with
 * create-time fixed paths, or a project whose path moved under the same id (`sandboxName` hashes
 * the id; `projects.json` is hand-editable). Nothing open can be attached to such a sandbox, so it
 * is removed outright. Returns whether it created one, which needs seeding from tet.json
 * (prepareSbxRun's allowHosts).
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
  if (listed !== undefined && sameWorkspaceSet(listed, [projectPath])) {
    return Promise.resolve(false);
  }
  const setup = (sandboxSetups.get(name) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const existing = ((await listSandboxes()) ?? sandboxes).get(name);
      if (existing !== undefined && sameWorkspaceSet(existing, [projectPath])) {
        return false;
      }
      if (existing !== undefined) {
        await removeSandbox(name, onData);
      }
      const created = await runSbx(["create", SBX_CREATE_TARGET[agentId] ?? agentId, projectPath, "--name", name], { onData });
      if (!created.ok) {
        throw new Error(`sbx could not create the ${agentId} sandbox`);
      }
      // A new sandbox holds nothing of the one that had this name — and one removed outside tet
      // (`sbx rm`, `prune`, `reset`) never passed removeSandbox, which is the other place this is
      // forgotten. Kept here, the launcher would be skipped and the agent would run without hooks.
      launcherWritten.delete(name);
      return true;
    });
  sandboxSetups.set(name, setup);
  const forget = (): void => {
    if (sandboxSetups.get(name) === setup) {
      sandboxSetups.delete(name);
    }
  };
  setup.then(forget, forget);
  return setup;
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
 * Applies live bind mounts on *every* start: unlike a file on the sandbox's disk, a bind mount
 * does not survive a stop (measured: the target was empty again), and `sbx stop` can happen
 * outside tet, so "already mounted" cannot be cached. Re-mounting is idempotent; access changes and
 * removals are narrowed at Save (revokeMounts), so this never hits "already mounted read-write;
 * cannot also mount read-only" (verified, 2026-09-08).
 *
 * Concurrent, since each `sbx mount` costs ~0.45s: 6 at once took 1.6s instead of 2.6s, all binds
 * present, ro honoured; 12 at once hit "docker hub refresh lock held by another process" (measured,
 * 2026-09-16, 0.42.1), hence MOUNT_CONCURRENCY.
 *
 * `started` is a start already underway (`SbxRunRequest.warm`), joined instead of started again —
 * but only its *success* counts: it may have run before the sandbox existed (two tabs of one agent
 * starting together, the second one seeing the first one's), and mounting a sandbox that is not
 * running is what this line is here to prevent.
 */
async function mountAll(name: string, specs: string[], onData?: OnData, started?: Promise<boolean>): Promise<string[]> {
  if (specs.length === 0) {
    return [];
  }
  if (!(await started)) {
    await ensureRunning(name, onData);
  }
  const mounted = await mapLimited(specs, MOUNT_CONCURRENCY, async (spec) => (await runSbx(["mount", name, spec], { onData })).ok);
  return specs.filter((_, index) => !mounted[index]);
}

/**
 * Narrows grants at Save, not at the next restart: a dropped or rw→ro path or knowledge kind must
 * stop being accessible *now*. And a `sbx mount` grant survives a stop though the bind does not
 * (verified, 2026-09-08: a different access after a restart still hit "already mounted"), so no
 * later mount corrects it. The caller has started the sandbox (`sbx umount` refuses a stopped one).
 */
async function revokeMounts(name: string, unmountSpecs: string[]): Promise<void> {
  for (const spec of unmountSpecs) {
    await runSbx(["umount", name, spec]);
  }
}

/**
 * Allows the project's hosts scoped to this sandbox (`--sandbox`, as kits scope theirs). A policy
 * rule lives in sbx's policy store, not the sandbox — measured, 2026-09-09, sbx 0.42.1:
 * - the sandbox must *exist* (`sandbox "x" not found`) but need not run, so no ensureRunning; both
 *   callers know it exists.
 * - the rule survives a stop and dies with `sbx rm`, so only a *new* sandbox is seeded from
 *   tet.json (prepareSbxRun); after that its rules are the truth (readSandboxHosts), or a host
 *   removed by hand would come back.
 * - RESOURCES is comma-separated, one process (~0.5 s), idempotent per scope ("Already covered",
 *   exit 0). A host allowed globally still gets its entry, so the list equals the dialog's.
 * - a change reaches a *running* sandbox at once (403 → 200), so saveSbxConfig applies it too.
 * Best-effort; sbx validates nothing (see SbxProjectConfig.hosts).
 */
async function allowHosts(name: string, hosts: string[], onData?: OnData): Promise<void> {
  if (hosts.length === 0) {
    return;
  }
  await runSbx(["policy", "allow", "network", "--sandbox", name, hosts.join(",")], { onData });
}

/**
 * Removes dropped hosts at Save, ending the allowance *now* (as revokeMounts). One `rm` per host:
 * the comma-list form removes nothing if any entry is missing (measured), and one removed by hand
 * answers "rule not found", exit 1, while the others still go.
 */
async function revokeStaleHosts(name: string, previous: string[], current: string[]): Promise<void> {
  for (const host of previous.filter((old) => !current.includes(old))) {
    await runSbx(["policy", "rm", "network", "--sandbox", name, "--resource", host]);
  }
}

function portKey(port: SbxPort): string {
  return `${port.host}:${port.container}`;
}

/** See applyPortChanges. */
function portDelta(previous: SbxPort[], current: SbxPort[]): { removed: SbxPort[]; added: SbxPort[] } {
  const previousKeys = new Set(previous.map(portKey));
  const currentKeys = new Set(current.map(portKey));
  return {
    removed: previous.filter((port) => !currentKeys.has(portKey(port))),
    added: current.filter((port) => !previousKeys.has(portKey(port)))
  };
}

/**
 * Publishes/unpublishes only the ports changed since the last save. A published port survives a
 * stop (verified, 2026-09-08), so this runs at Save, not per spawn; `sbx run -p` covers a new
 * sandbox (prepareSbxRun). Re-publishing errors ("already published", verified), so only the delta
 * is sent. The caller has started the sandbox (`sbx ports` refuses a stopped one).
 */
async function applyPortChanges(name: string, delta: { removed: SbxPort[]; added: SbxPort[] }): Promise<void> {
  for (const port of delta.removed) {
    await runSbx(["ports", name, "--unpublish", portKey(port)]);
  }
  for (const port of delta.added) {
    await runSbx(["ports", name, "--publish", portKey(port)]);
  }
}

/** A `SandboxSessionMount` with an absolute host side, for `sessionMountSpecs`. */
export interface SbxSessionMount {
  host: string;
  target: string;
  file?: boolean;
}

export interface SbxRunRequest {
  agentId: SbxAgentId;
  projectId: string;
  projectPath: string;
  config: SbxProjectConfig;
  /** What `checkSbxReady` just listed, so it is not listed again. */
  sandboxes: SandboxList;
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
async function sessionMountSpecs(mounts: SbxSessionMount[]): Promise<string[]> {
  const specs: string[] = [];
  for (const mount of mounts) {
    try {
      if (mount.file) {
        await fs.mkdir(path.dirname(mount.host), { recursive: true });
        // Never truncate: it is the session index the sandbox appends to.
        await fs.appendFile(mount.host, "");
      } else {
        await fs.mkdir(mount.host, { recursive: true });
      }
      specs.push(`${mount.host}:${mount.target}`);
    } catch (error) {
      console.error("[tet] could not prepare sandbox session mount:", error);
    }
  }
  return specs;
}

/**
 * Readies a tab's sandbox and returns the `sbx run` arguments: tet's mounts, knowledge and Allowed
 * paths (`missing` for the caller to report), ports, and with a control channel its env and the
 * `tet-ctl` launcher. Creates the sandbox itself (ensureSandboxExists), since the launcher must be
 * written before `sbx run` starts the agent. Rejects when creating fails or a folder of tet's own
 * cannot be mounted; the rest is best-effort.
 */
export async function prepareSbxRun(request: SbxRunRequest): Promise<{ args: string[]; missing: string[] }> {
  const { agentId, config, onData } = request;
  const env = request.env ?? [];
  const name = sandboxName(request.projectId, agentId);
  const created = await ensureSandboxExists(agentId, request.projectPath, name, request.sandboxes, onData);
  // The user's grants are best-effort: their failure must not keep the agent from starting. A row
  // that exists is mounted (folder or file); one gone from this host is reported as missing.
  // tet's own folders are not best-effort: without them the agent has no hook settings or listable
  // sessions, silently. Everything else is in place by here, so a refusal is sbx's policy, and the
  // tab stops with sbx's reason in its output. Hosts are seeded only into a sandbox this call
  // created; after that its rules are the truth (allowHosts).
  const missing = config.paths.map((entry) => entry.path).filter((entry) => !statOf(normalizeHostPath(entry)));
  const own = [...fixedMountSpecs(request.paths), ...(await sessionMountSpecs(request.sessionMounts ?? []))];
  const granted = grantedMounts(agentId, config).map((spec) => spec.mount);
  const failed = await mountAll(name, [...own, ...granted], onData, created ? undefined : request.warm);
  const ownFailed = failed.filter((spec) => own.includes(spec));
  if (ownFailed.length > 0) {
    throw new Error(`sbx did not mount tet's own ${ownFailed.length === 1 ? "folder" : "folders"} ${ownFailed.join(", ")} — see the tab's output`);
  }
  if (created) {
    await allowHosts(name, config.hosts, onData);
  }
  // No workspace positionals, not even right after creating: the sandbox always exists by now, and
  // sbx run refuses them on an existing one even when unchanged (verified, 2026-09-08: "sandbox 'x'
  // already exists and can't be given new workspaces"). The agent positional is only verified by
  // sbx; `--name` finds the sandbox. The plain agent id even for a kit (SBX_CREATE_TARGET).
  const args = [
    "run",
    agentId,
    "--name",
    name,
    ...config.ports.flatMap((port) => ["-p", portKey(port)]),
    ...env.flatMap((entry) => ["-e", entry])
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
  return { args, missing };
}

/**
 * The dialog's Save: writes tet.json, then removes every sandbox if sandboxing is off. If on, a
 * sandbox with another workspace is removed too (see ensureSandboxExists; rebuilt at its next tab),
 * and otherwise brought in line: grants narrowed (revokeMounts), ports applied (applyPortChanges),
 * hosts both ways (revokeStaleHosts, allowHosts) — no edit forces a rebuild. The hosts' "previous"
 * is the sandbox's own rules (the truth, readLiveSbxConfig), so a hand-set rule deleted as a row
 * goes too. Mounts and ports need it running, so it is started once, only when either has work; a
 * failed start is skipped. Returns the agents whose sandboxes were removed, for the caller to say
 * so: a running session of theirs just lost its sandbox.
 */
export async function saveSbxConfig(projectPath: string, projectId: string, request: SbxProjectConfig): Promise<SbxAgentId[]> {
  const previous = await readSbxConfig(projectPath);
  const config = { ...request, paths: request.paths.map((entry) => ({ ...entry, path: contractHome(entry.path) })) };
  await writeSbxConfig(projectPath, config);
  const sandboxes = (await listSandboxes()) ?? new Map();
  const liveHosts = await readSandboxHosts();
  const removed: SbxAgentId[] = [];
  for (const agentId of SBX_AGENT_IDS) {
    const name = sandboxName(projectId, agentId);
    const existing = sandboxes.get(name);
    if (existing === undefined) {
      continue;
    }
    if (!config.enabled || !sameWorkspaceSet(existing, [projectPath])) {
      if (await removeSandbox(name)) {
        removed.push(agentId);
      }
      continue;
    }
    const stale = staleMounts(grantedMounts(agentId, previous), grantedMounts(agentId, config));
    const ports = portDelta(previous.ports, config.ports);
    if ((stale.length > 0 || ports.removed.length > 0 || ports.added.length > 0) && (await ensureRunning(name))) {
      await revokeMounts(name, stale);
      await applyPortChanges(name, ports);
    }
    await revokeStaleHosts(name, liveHosts.get(name) ?? [], config.hosts);
    await allowHosts(name, config.hosts);
  }
  return removed;
}
