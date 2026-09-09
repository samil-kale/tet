import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { statSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONTROL_ENV } from "../shared/control";
import { SBX_AGENT_IDS } from "../shared/types";
import type { SbxAgentId, SbxKnowledgeConfig, SbxPath, SbxPort, SbxProjectConfig, SbxStatus } from "../shared/types";
import type { AgentPaths } from "./agents/agent";
import { readSbxConfig, writeSbxConfig } from "./git/commands";
import { augmentAgentPath } from "./terminals/agent-path";
import { SANDBOX_HOME, toContainerPath } from "./terminals/hook-target";
import { resolveCommand } from "./terminals/pty";
import { checkAgentInstalled } from "./terminals/terminal-session";

/**
 * The one `sbx` process the sbx-settings dialog is waiting on, for `cancelSbxSetup`. Only the
 * two slow steps register here (`login`, `policy init`, via `RunOptions.cancellable`): a spawn's
 * own `sbx ls` or `sbx create` must not die with the dialog's Cancel button.
 */
let currentChild: ChildProcess | undefined;

/** Set once from main.ts: the `tet-ctl` bundle (ensureSandboxLauncher) and the control server's
 *  port (ensureControlNetworkAllowed). Unset in a run without a control channel, and then
 *  nothing control-related reaches a sandbox. */
let control: { cliPath: string; port: number } | undefined;
export function configureSandboxes(cliPath: string, port: number): void {
  control = { cliPath, port };
}

interface RunOptions {
  /** Handed to the process's stdin and closed right after. Without it stdin is closed from the
   *  start, so a command that would wait on it fails instead. */
  stdin?: string;
  /** Whether `cancelSbxSetup` may kill this one — see `currentChild`. */
  cancellable?: boolean;
  /**
   * Forwards this call's console output live to the tab that is about to run in the sandbox
   * (through the same per-tab `onOutput` channel as pty output). With a callback stderr is
   * captured too, both streams in arrival order, `\n` turned into `\r\n`: sbx's output never
   * carries a bare `\r` (measured), and xterm has no `convertEol`.
   */
  onData?: (chunk: string) => void;
}

type OnData = RunOptions["onData"];

interface RunResult {
  /** Exited 0. */
  ok: boolean;
  stdout: string;
}

/** Every `sbx` invocation: a plain spawn through `resolveCommand`, no shell, from the temp
 *  directory so the working directory never reads as a workspace. stderr is dropped unless
 *  `onData` forwards it; callers decide by exit code or stdout's JSON. */
function runSbx(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const resolved = resolveCommand("sbx", args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", options.onData ? "pipe" : "ignore"]
    });
    if (options.cancellable) {
      currentChild = child;
    }
    let stdout = "";
    const forward = (chunk: Buffer): void => options.onData?.(chunk.toString().replace(/\n/g, "\r\n"));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      forward(chunk);
    });
    child.stderr?.on("data", forward);
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
    child.on("error", () => finish({ ok: false, stdout }));
    child.on("exit", (code) => finish({ ok: code === 0, stdout }));
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    }
  });
}

/**
 * One command run to completion inside a sandbox via `sbx exec`, no shell, from `cwd` as the
 * sandbox sees it (`-w`). Starts a stopped sandbox first, as every exec does. Resolves with
 * stdout on exit 0, rejects otherwise — for one-off agent actions whose session lives there.
 */
export async function execInSandbox(name: string, cwd: string, command: string[]): Promise<string> {
  const result = await runSbx(["exec", "-i", "-w", toContainerPath(cwd), name, ...command]);
  if (!result.ok) {
    throw new Error(`${command[0]} failed in sandbox ${name}`);
  }
  return result.stdout;
}

/**
 * Kills the running `login` or `policy init`, for the dialog's Cancel button. Plain `kill()`
 * suffices: `sbx.exe` is a native executable, no cmd.exe shim in between (unlike `ask.ts`).
 */
export function cancelSbxSetup(): void {
  currentChild?.kill();
  currentChild = undefined;
}

/** `version` is a subcommand; `sbx --version` fails with "unknown flag". */
function isSbxInstalled(): Promise<boolean> {
  return checkAgentInstalled("sbx", ["version"], os.tmpdir());
}

/**
 * sbx shows a one-time wizard on a machine's first interactive `sbx run` (a pty attach, which a
 * tet tab is; never from `create`/`exec`/`mount`). Any valid JSON at
 * `%LOCALAPPDATA%\DockerSandboxes\sandboxes\config\first-run-import.json` suppresses it
 * (measured). Never overwrites an existing file. Costs the wizard's MCP-server import, which
 * has no CLI equivalent (`sbx mcp add` by hand). Undocumented state, verified on Windows only;
 * a no-op elsewhere until the paths are known. Best-effort, run from `prepareSbxRun` right
 * before the one interactive `sbx run`.
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
    // Not there yet — fall through and create it.
  }
  try {
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await fs.writeFile(markerFile, "{}");
  } catch {
    // Best-effort: worst case the wizard still shows once, same as today.
  }
}

/** `sbx login` opens the OAuth page in the browser itself and waits on its own callback; no
 *  console needed. */
export async function runSbxLogin(): Promise<boolean> {
  return (await runSbx(["login"], { cancellable: true })).ok;
}

/**
 * Sets the machine-wide network policy to "balanced", Docker's recommended default. One-time
 * and machine-wide, so no per-project choice: changing it later needs `sbx policy reset`,
 * which stops every running sandbox.
 */
export async function initSbxPolicy(): Promise<boolean> {
  return (await runSbx(["policy", "init", "balanced"], { cancellable: true })).ok;
}

/** `sbx ls --json` as name → workspaces. */
type SandboxList = Map<string, string[]>;

/**
 * The first of the three preconditions not met, worded for a notice — or the sandbox listing,
 * which came out of the same `sbx ls` as the sign-in probe and is `prepareSbxRun`'s next
 * question. Asked before every sandboxed spawn (`resolveSbxRun`).
 */
export async function checkSbxReady(): Promise<{ notReady: string } | { sandboxes: SandboxList }> {
  // The spawn path, so no PATH re-read: on macOS/Linux that is a login shell per call.
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
  return { sandboxes };
}

/**
 * Everything the sbx-settings dialog asks before it shows its fields, in one call. PATH is
 * re-read first: "Check again" is pressed right after installing. Nothing here is cached —
 * sbx is installed, signed into and governed from outside tet at any time.
 */
export async function readSbxStatus(): Promise<SbxStatus> {
  return (await probeSbx(true)).status;
}

/**
 * The one implementation behind both. Probes in order and stops at the first "no", since each
 * question is only meaningful once the one before it is answered: `sbx policy ls` fails when
 * signed out too. Three processes at most, and `policy ls` answers two questions at once — its
 * exit code whether the policy is initialized, its output whether an organization manages it.
 *
 * `sbx ls` is the sign-in probe: side-effect-free, exits 1 with "Not authenticated to Docker"
 * when signed out, and its listing is what `prepareSbxRun` asks for next. Not `sbx policy ls`:
 * that also exits 1 on a signed-in account without a policy. Every other failure reads as "not
 * signed in" too — a needless login costs one glance at an "already signed in" message.
 *
 * `sbx policy ls`'s SOURCE column reads "local" or "kit" for an ungoverned account (measured,
 * 0.42.1); Docker's docs say a governed one reads "Managed by <org>". Unverified against a real
 * governed account, so governance is only detected: the dialog shows a wall instead of its
 * fields, a managed filesystem policy allowing no local mount.
 */
async function probeSbx(refreshPath: boolean): Promise<{ status: SbxStatus; sandboxes?: SandboxList }> {
  const status: SbxStatus = { installed: false, loggedIn: false, policyInitialized: false, governed: false };
  if (refreshPath) {
    await augmentAgentPath();
  }
  status.installed = await isSbxInstalled();
  if (!status.installed) {
    return { status };
  }
  const sandboxes = await listSandboxes();
  status.loggedIn = sandboxes !== undefined;
  if (!status.loggedIn) {
    return { status };
  }
  const policy = await runSbx(["policy", "ls"]);
  status.policyInitialized = policy.ok;
  status.governed = policy.ok && /managed by/i.test(policy.stdout);
  return { status, sandboxes };
}

/** Cached per app run: once the rule is there, it stays. */
let networkAllowed: Promise<void> | undefined;

/**
 * Allows the sandbox's egress to tet's control channel as `localhost:<port>`, not
 * `host.docker.internal`: sbx's proxy rewrites `host.docker.internal` to `localhost` before
 * checking the policy (measured; a `host.docker.internal` rule matches nothing and requests
 * connect but never arrive). False in a run without a control channel; `prepareSbxRun` then
 * leaves the TET_CONTROL_* env out so tet-ctl inside fails closed.
 */
async function ensureControlNetworkAllowed(): Promise<boolean> {
  if (!control) {
    return false;
  }
  const resource = `localhost:${control.port}`;
  networkAllowed ??= (async () => {
    const existing = (await runSbx(["policy", "ls", "--type", "network", "--json"])).stdout;
    const alreadyAllowed = (() => {
      try {
        const parsed = JSON.parse(existing) as { rules?: { resources?: string[] }[] };
        return (parsed.rules ?? []).some((rule) => rule.resources?.includes(resource));
      } catch {
        return false;
      }
    })();
    if (!alreadyAllowed) {
      await runSbx(["policy", "allow", "network", resource]);
    }
  })();
  await networkAllowed;
  return true;
}

/**
 * A deterministic sandbox name per (project, agent), stable across restarts so `sbx run --name`
 * reattaches. `sbx create --name` allows only letters, numbers, hyphens and periods, so the
 * project id is hashed.
 */
export function sandboxName(projectId: string, agentId: SbxAgentId): string {
  const hash = crypto.createHash("sha1").update(projectId).digest("hex").slice(0, 12);
  return `tet-${agentId}-${hash}`;
}

/** Expands tet.json's `~` and `~/…` (contractHome) before the path reaches `sbx`, which is not
 *  a shell and would pass the tilde through literally. */
function expandHome(hostPath: string): string {
  if (hostPath === "~") {
    return os.homedir();
  }
  return hostPath.startsWith("~/") ? path.join(os.homedir(), hostPath.slice(2)) : hostPath;
}

/**
 * The inverse, for tet.json: a path under the home is stored as `~/…` with forward slashes so
 * one row serves another user on the same OS. Anything else is stored as typed.
 * Case-insensitive on win32 through `path.relative`.
 */
export function contractHome(hostPath: string): string {
  const typed = hostPath.trim();
  const resolved = normalizeHostPath(typed);
  if (!path.isAbsolute(resolved)) {
    return typed;
  }
  const relative = path.relative(os.homedir(), resolved);
  if (relative === "") {
    return "~";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return typed;
  }
  return `~/${relative.split(path.sep).join("/")}`;
}

/** A typed host path as sbx will list it back: `~` expanded, separators native, no trailing
 *  one. A relative path is left alone. */
function normalizeHostPath(hostPath: string): string {
  const expanded = expandHome(hostPath.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
}

/**
 * One live bind mount both ways: the `sbx mount` spec and the `sbx umount` spec that takes it
 * back. `mount` carries the access, so two specs with the same `mount` are the same grant
 * (`staleMounts` compares by it).
 */
export interface MountSpec {
  mount: string;
  unmount: string;
}

/**
 * The `sbx mount`/`sbx umount` specs for one allowed-path row — a live bind mount, not a
 * `sbx create` positional (see fixedMountSpecs). `sbx mount`'s grammar is
 * `HOST[:CTR_TARGET[:ro|rw]]`, and a two-part `HOST:ro` parses as CTR_TARGET="ro" ("must be
 * absolute"), unlike `sbx create`'s positional. So `rw` is the bare host path (sbx maps it to
 * the same path inside); `ro` needs the three-part form, and repeating the host path as
 * CTR_TARGET breaks the parser on Windows (two drive-letter colons) — `toContainerPath` is the
 * form that works. `unmount` drops the suffix: `sbx umount` takes `HOST[:CTR_TARGET]`, and an
 * explicit-target mount must be revoked with that target.
 *
 * A single file takes both forms unchanged (measured, 0.42.1: bare path mounts read-write,
 * three-part `:ro` read-only, `umount` takes it back either way).
 */
export function pathMountSpecs(entry: SbxPath): MountSpec {
  const host = normalizeHostPath(entry.path);
  if (entry.access === "rw") {
    return { mount: host, unmount: host };
  }
  const target = toContainerPath(host);
  return { mount: `${host}:${target}:ro`, unmount: `${host}:${target}` };
}

/** What is at a host path, or undefined for nothing — only what exists is mounted. */
function statOf(candidate: string): Stats | undefined {
  try {
    return statSync(candidate);
  } catch {
    return undefined;
  }
}

/** The two of an agent's paths a sandbox is built around. */
export type SandboxPaths = Pick<AgentPaths, "agentDir" | "contextFile">;

/**
 * The two paths of tet's own that every sandboxed tab needs, as `sbx mount` specs: `agentDir`
 * (hook settings and marker files, read-write) and the shell-context file's directory
 * (read-only). Live mounts, not `sbx create` positionals: a create-time positional cannot be
 * changed afterwards ("already exists and can't be given new workspaces"), so anything on that
 * list turns every change into a rebuild. The project itself stays create-time: `sbx run` has
 * no `--workdir` (docker/sbx-releases#394), and a sandbox created without a positional starts
 * its agent in an empty `/home/agent/workspace` (measured, 0.42.1). Both mounts land at the
 * same container path a positional would give (`sbx mount`'s documented convention), so the
 * hook paths written through `HookTarget` are unaffected.
 *
 * Never the agent's own config directory (`~/.claude`, `~/.codex`): mounted with
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME` pointed at it, the sandboxed CLI is signed in as the host
 * (measured), and a `/login` inside would replace the host's. Skills, plugins and instructions
 * come in as separate mounts (knowledgePaths), as do the sessions (sessionMountSpecs): curated
 * subpaths only, never the directory holding the credentials.
 */
export function fixedMountSpecs(paths: SandboxPaths): string[] {
  return [
    pathMountSpecs({ path: paths.agentDir, access: "rw" }).mount,
    pathMountSpecs({ path: path.dirname(paths.contextFile), access: "ro" }).mount
  ];
}

interface KnowledgeEntry {
  host: string;
  target: string;
}

/**
 * This agent's shareable, non-identity knowledge on the host — skills, plugins, instructions
 * file — one list per `SbxKnowledgeConfig` kind. Never the config directory itself
 * (fixedMountSpecs). A host path that does not exist is left out by the caller.
 *
 * Claude (measured): `~/.claude/skills`, `~/.claude/plugins` (the plugin code itself),
 * `~/.claude/CLAUDE.md`. Codex (measured): skills from both `~/.codex/skills` and
 * `~/.agents/skills` (its own "failed to load skill" log names both); `~/.codex/plugins`
 * (code under `plugins/cache/…`, so the whole directory is the unit); instructions
 * `~/.codex/AGENTS.md`, `AGENTS.override.md` preferred per its documented load order.
 * opencode (documented, not verified live): skills from `~/.config/opencode/skills`,
 * `~/.claude/skills` and `~/.agents/skills`; plugins from `~/.config/opencode/plugins`; rules
 * from `~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md`. Its config directory holds
 * `opencode.json` with the user's providers and stays out; its auth is under
 * `~/.local/share/opencode`.
 */
function knowledgePaths(agentId: SbxAgentId): Record<keyof SbxKnowledgeConfig, KnowledgeEntry[]> {
  const home = os.homedir();
  if (agentId === "pi") {
    // From the installed package's bundled docs (0.85.1): skills from `~/.pi/agent/skills` and
    // `~/.agents/skills`; extensions (pi's plugins) from `~/.pi/agent/extensions`; instructions
    // from `~/.pi/agent/AGENTS.md`, `AGENTS.override.md` preferred. `PI_CODING_AGENT_DIR` is
    // never set for a sandboxed tab, so the sandbox's pi finds these at their defaults.
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
 * The `sbx mount` specs (`HOST:TARGET[:ro]`) for this agent's enabled knowledge kinds that
 * exist on this host. A bind mount at an arbitrary container path, not a symlink: sbx cannot
 * follow one that points outside its workspace. A folder or a plain file both work (measured).
 * No suffix means `rw`. The unmount form drops the suffix, like pathMountSpecs'.
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
 * Every live grant the user can change from the dialog — Allowed paths and knowledge — as this
 * agent's sandbox is to have it. One list, because Save narrows and every spawn re-applies the
 * same set (mountAll, staleMounts). Only what exists on this host; a user's row that does not
 * is reported by prepareSbxRun (`missing`).
 */
function grantedMounts(agentId: SbxAgentId, config: SbxProjectConfig): MountSpec[] {
  return [
    ...knowledgeMountSpecs(agentId, config.knowledge),
    ...config.paths.filter((entry) => statOf(normalizeHostPath(entry.path))).map(pathMountSpecs)
  ];
}

/**
 * The `sbx umount` specs for grants of `previous` that `current` no longer makes. Compared by
 * `mount`, so an access change (rw→ro) is a different grant, not the same one narrower.
 */
function staleMounts(previous: MountSpec[], current: MountSpec[]): string[] {
  return previous.filter((old) => !current.some((next) => next.mount === old.mount)).map((old) => old.unmount);
}

/** Sandboxes that already got the `tet-ctl` launcher written this run. Forgotten along with the
 *  sandbox in removeSandbox. */
const launcherWritten = new Set<string>();

/**
 * `sbx ls --json` as name → workspaces, or undefined when sbx could not answer — signed out,
 * `sbx ls` exits 1 (see probeSbx). One process for every sandbox at once.
 */
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
    // Unreadable is the same as none — callers treat a missing name as "does not exist".
  }
  return sandboxes;
}

/**
 * The Allowed hosts attached to each sandbox, by name — the truth for that list (tet.json only
 * seeds a new sandbox, see readLiveSbxConfig). One `policy ls` for every sandbox. A rule counts
 * when scoped `sandbox:<name>`, an allow, and editable — what `sbx policy allow network
 * --sandbox` produces (measured, 0.42.1: `origin: "scoped", editable: true`); a kit's rule is
 * `editable: false`, a global one is the machine's. One rule per resource, so a sandbox's list
 * is the union over its rules.
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
    // Unreadable reads as no rules — the same shape a sandbox with none has.
  }
  return hosts;
}

/**
 * What the dialog opens with: tet.json, except that Allowed hosts come from the sandboxes
 * themselves when the project has any (a rule changed by hand with `--sandbox` shows as it
 * stands; Save writes it back). Several sandboxes read as one union; Save makes them equal.
 *
 * Hosts are the only setting read back this way (measured, 0.42.1): a policy rule lives in
 * sbx's policy store, so `sbx policy ls --json` answers for a stopped sandbox too. `sbx ports`
 * lists nothing for a stopped sandbox (reading them would start every sandbox of the project).
 * Mounts have no listing at all, and a bind mount does not survive a stop. So for paths,
 * knowledge and ports tet.json is the truth, applied whole at every spawn and narrowed by
 * delta at Save. The sbx CLI has no watch mode, so a live read is a snapshot.
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
 * Starts a stopped sandbox: `sbx mount`, `umount` and `ports` all refuse one ("409 Conflict"),
 * and this cheap `exec` is the auto-start every one of them relies on. False when the sandbox
 * does not exist at all — for the best-effort callers, the same signal either way.
 */
async function ensureRunning(name: string, onData?: OnData): Promise<boolean> {
  return (await runSbx(["exec", "-i", name, "true"], { onData })).ok;
}

/**
 * What goes where `sbx create` wants its agent, per agent — the agent's own id for the three
 * Docker ships a built-in kit for, and a *kit reference* for pi, which it does not
 * (`sbx create --help` lists the built-ins; pi is not among them, still true at 0.42.1).
 * `docker.io/sbx/pi-kit` is the community kit from docker/sbx-kits-contrib: a `kind: sandbox`
 * kit whose own image (`docker.io/sbx/pi-image`, the shell-docker template plus a global npm
 * install of pi, rebuilt nightly) sbx pulls itself on the first create — nothing is installed
 * here, and the sandbox's user and home are the same `/home/agent` every built-in template has.
 *
 * Three things verified live against a real install, 2026-09-09, sbx 0.42.1 (0.39.0 could not
 * read the kit's v2 manifest at all — "no v2 kit layer found in manifest" — so this needs that
 * version or newer):
 * - the reference is the *first positional*, in the agent's place. Passing it as `--kit` warns
 *   that doing so is deprecated: at 0.42.1 `--kit` means an additional *mixin* layered onto a
 *   built-in agent, which is not what this is.
 * - only `create` needs it. `sbx run` reattaches by `--name` and reads the agent back from the
 *   sandbox's own spec, so `prepareSbxRun` keeps passing the plain agent id there for sbx's own
 *   verification — `sbx run pi --name …` is accepted even though `pi` is no built-in, because
 *   that is the name the kit itself declares (and what `sbx ls --json` reports as its `agent`).
 * - authentication is the one place pi differs from the other three, and it is not tet's to
 *   arrange: pi has no `/login` of its own, so its kit takes an Anthropic credential from sbx's
 *   own store (`sbx secret set anthropic`, an OAuth login shared from a `claude` sandbox, or a
 *   `claude setup-token`). With no binding the sandbox starts fine and every model call is a 401.
 */
const SBX_CREATE_TARGET: Partial<Record<SbxAgentId, string>> = { pi: "docker.io/sbx/pi-kit:latest" };

/**
 * Makes sure a sandbox exists whose one workspace is this project — everything else tet mounts
 * is live (fixedMountSpecs, knowledgeMountSpecs, pathMountSpecs), so this is the whole of what
 * `sbx create` is told. One that exists with a *different* workspace is rebuilt rather than
 * reused, and there are two ways to get there: a sandbox left over from an older tet, whose
 * fixed paths were still create-time positionals (the rebuild is that migration), and a project
 * whose path moved while keeping its id — `sandboxName` hashes the id alone, and `projects.json`
 * is a plain file, so a path corrected there reaches the same sandbox still pointing at the old
 * location. Nothing currently open in this process is attached to a sandbox that fails this
 * check, since attaching to it is exactly what the check would have refused. Safe to remove
 * outright. Returns whether it created one — a new sandbox is the one that still needs seeding
 * with what tet.json holds (prepareSbxRun's allowHosts).
 *
 * A `create` that fails is the one setup step that is not best-effort: `sbx run --name` would
 * create the sandbox itself, without the workspace positional it refuses on an existing one,
 * and the agent would start in an empty in-container directory with nothing saying so. A kit
 * that could not be pulled (pi's, on a first start without network) is exactly this. Rejects,
 * for the caller to leave the tab in error; sbx's own message has already reached the tab
 * through `onData`.
 */
async function ensureSandboxExists(
  agentId: SbxAgentId,
  projectPath: string,
  name: string,
  sandboxes: SandboxList,
  onData?: OnData
): Promise<boolean> {
  const existing = sandboxes.get(name);
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
  return true;
}

/**
 * Writes `tet-ctl` directly into the sandbox's own `~/.local/bin` — verified live, 2026-09-08,
 * to be first on every sandbox template's PATH and writable by the non-root "agent" user, unlike
 * `/usr/local/bin` (root-owned). Rather than mounting a launcher script plus the bundle as two
 * files under `agentDir` and fighting PATH (`sbx run -e PATH=...` replaces the sandbox's PATH
 * outright rather than prepending to it, since env values are literal, not shell-expanded), the
 * whole ~9 KB bundle is piped in as the file's own content, with a plain `#!/usr/bin/env node`
 * shebang — node is already on every template's PATH (bundled for the agent CLIs themselves).
 * Assumes the sandbox already exists — callers run this after ensureSandboxExists.
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

/**
 * Applies live bind mounts — knowledge and Allowed paths alike — to a sandbox that already
 * exists (ensureSandboxExists ran first). Re-applied on *every* start rather than once per
 * sandbox: unlike a file written into the sandbox's own disk (ensureSandboxLauncher's tet-ctl),
 * a runtime bind mount does not survive a stop/restart — measured live, the target was empty
 * again afterward — and a sandbox can be stopped from outside tet (a plain `sbx stop`), so there
 * is no reliable moment to cache "already mounted" against. The command is its own idempotency
 * check when it is not needed again (sbx's own guarantee); an access change or a removed path
 * is narrowed immediately at Save instead (see revokeMounts) — so by the time this runs,
 * the previous mount of that path either matches or is already gone, and a plain re-mount here
 * never hits sbx's "already mounted read-write; cannot also mount read-only" conflict (verified
 * live, 2026-09-08).
 */
async function mountAll(name: string, specs: string[], onData?: OnData): Promise<void> {
  if (specs.length === 0) {
    return;
  }
  await ensureRunning(name, onData);
  for (const spec of specs) {
    await runSbx(["mount", name, spec], { onData });
  }
}

/**
 * Narrows a running sandbox's grants the moment the user changes them, rather than leaving
 * the old one in force until whoever has that tab open next restarts it: a path dropped from
 * Allowed paths or a knowledge kind switched off, or either downgraded from rw to ro, must
 * stop being (over-)accessible *now*. Needed because the grant a `sbx mount` makes survives a
 * sandbox stop/restart even though the live bind does not (verified live, 2026-09-08: mounting
 * the same host path again with a different access after a restart still hit the "already
 * mounted" conflict) — so nothing here can rely on a later mount to self-correct it. The
 * caller has started the sandbox (`sbx umount` refuses a stopped one, see ensureRunning).
 */
async function revokeMounts(name: string, unmountSpecs: string[]): Promise<void> {
  for (const spec of unmountSpecs) {
    await runSbx(["umount", name, spec]);
  }
}

/**
 * Adds the project's Allowed hosts to sbx's network policy, scoped to this one sandbox
 * (`--sandbox`, the way the kits scope their own rules). Unlike a mount or a port, a policy
 * rule lives in sbx's policy store rather than in the sandbox, which changes every rule the
 * other two follow — each measured live, 2026-09-09, sbx 0.42.1:
 * - the sandbox has to *exist* (`sandbox "x" not found` otherwise) but need not be running: a
 *   stopped one takes the rule without being started, so there is no ensureRunning here. Both
 *   callers already know it exists — prepareSbxRun runs after ensureSandboxExists,
 *   saveSbxConfig's loop skips a name the listing does not know.
 * - the rule survives a stop/restart and dies with `sbx rm` — so a disabled or rebuilt sandbox
 *   leaves nothing behind, and only a *newly created* one needs seeding from tet.json
 *   (prepareSbxRun). After that the sandbox's own rules are the truth (readSandboxHosts): an
 *   existing sandbox is never re-seeded on start, or a host removed by hand would come back.
 * - RESOURCES is a comma-separated list, so the whole list is one process (~0.5 s), and it is
 *   idempotent per scope: an entry already there answers "Already covered", a new one is added,
 *   exit 0 either way. A host a global rule already allows still gets its sandbox entry — the
 *   sandbox's list is exactly the dialog's, and revokeStaleHosts finds what was set here.
 * - a change applies to a *running* sandbox at once (403 → 200 with no restart), which is why
 *   saveSbxConfig applies the list too, not just the removals.
 * Best-effort like the mounts: no host allowed is no worse than today, and sbx validates
 * nothing (see SbxProjectConfig.hosts).
 */
async function allowHosts(name: string, hosts: string[], onData?: OnData): Promise<void> {
  if (hosts.length === 0) {
    return;
  }
  await runSbx(["policy", "allow", "network", "--sandbox", name, hosts.join(",")], { onData });
}

/**
 * Removes the hosts dropped since the last save, right at Save — the same reasoning as
 * revokeMounts: an allowance must end *now*, not when the tab is next restarted, and a
 * policy change reaches a running sandbox immediately (see allowHosts). One `rm` per host: the
 * comma-list form is atomic and removes nothing if any one entry is missing (measured), and an
 * entry the user already removed by hand answers "rule not found", exit 1 — best-effort, the
 * others still go.
 */
async function revokeStaleHosts(name: string, previous: string[], current: string[]): Promise<void> {
  for (const host of previous.filter((old) => !current.includes(old))) {
    await runSbx(["policy", "rm", "network", "--sandbox", name, "--resource", host]);
  }
}

function portKey(port: SbxPort): string {
  return `${port.host}:${port.container}`;
}

/**
 * Publishes/unpublishes exactly the ports that changed since the last save, on a sandbox that
 * already exists. Unlike a folder's bind mount, a published port survives a sandbox stop/restart
 * (verified live, 2026-09-08: still listed after `sbx stop` + a fresh start) — `sbx run`'s own
 * `-p` still handles a *newly created* sandbox's first port set (prepareSbxRun), and this only
 * has to run once, here, rather than on every spawn. And unlike a mount, re-publishing an
 * already-published port is not a no-op — it errors outright ("already published", verified live)
 * — so only the actual delta may be sent, never the whole current list. The caller has
 * started the sandbox (`sbx ports` refuses a stopped one, see ensureRunning).
 */
function portDelta(previous: SbxPort[], current: SbxPort[]): { removed: SbxPort[]; added: SbxPort[] } {
  const previousKeys = new Set(previous.map(portKey));
  const currentKeys = new Set(current.map(portKey));
  return {
    removed: previous.filter((port) => !currentKeys.has(portKey(port))),
    added: current.filter((port) => !previousKeys.has(portKey(port)))
  };
}

async function applyPortChanges(name: string, delta: { removed: SbxPort[]; added: SbxPort[] }): Promise<void> {
  for (const port of delta.removed) {
    await runSbx(["ports", name, "--unpublish", portKey(port)]);
  }
  for (const port of delta.added) {
    await runSbx(["ports", name, "--publish", portKey(port)]);
  }
}

/** One `SandboxSessionMount` with its host side resolved to an absolute path — what the
 *  session manager hands over for `sessionMountSpecs` to mount. */
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
  /** What `checkSbxReady` listed a moment ago — the sandbox is looked up there rather than
   *  listed again. */
  sandboxes: SandboxList;
  paths: SandboxPaths;
  /** The agent's own command line inside the sandbox — hook and resume arguments, after `sbx
   *  run`'s own "--". */
  agentArgs: string[];
  /** `AgentDefinition.sandboxEnv` — "KEY=VALUE" entries for `sbx run -e`, ahead of "--". */
  env?: string[];
  /**
   * Where this agent's sessions are to land on the host — its `SandboxSessionMount`s with the
   * host side already resolved. Created here if missing (sbx has nothing to mount otherwise),
   * read-write, and re-applied on every spawn like every other live mount.
   */
  sessionMounts?: SbxSessionMount[];
  /** Every setup step's own console output, forwarded live to the tab that is about to run in
   *  this sandbox — see `RunOptions.onData` for why this needs no pty of its own to reach it. */
  onData?: OnData;
}

/**
 * The `sbx mount` specs that put a sandboxed agent's own sessions on the host — see
 * SessionProvider.sandbox for why they are read through a mount rather than out of the
 * container. Read-write (no suffix, sbx's own default): the CLI inside writes them.
 *
 * The host side is created first, as a directory or an empty file, because `sbx mount` has
 * nothing to mount otherwise. The container side needs no such care — verified live,
 * 2026-09-09: sbx creates a missing target for either kind, and a mount even stacks over a
 * volume the template already put there (Claude's `~/.claude/projects`), the mount winning.
 * Best-effort per entry, like the knowledge mounts: no sessions on the host is no worse than
 * before, and must not keep the agent itself from starting.
 */
async function sessionMountSpecs(mounts: SbxSessionMount[]): Promise<string[]> {
  const specs: string[] = [];
  for (const mount of mounts) {
    try {
      if (mount.file) {
        await fs.mkdir(path.dirname(mount.host), { recursive: true });
        // Never truncating one that is already there: it is the session index the sandbox has
        // been appending to.
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
 * Readies one agent tab's sandbox and returns the full `sbx run` argument list for it — the
 * project as its one workspace, live-mounted tet paths (fixedMountSpecs), knowledge and Allowed
 * paths (whose `missing` is passed on for the caller to say), published ports, and (when network
 * policy allows it, see ensureControlNetworkAllowed) the control-channel env and `tet-ctl`
 * launcher. Creates the sandbox first if it is missing (ensureSandboxExists) — `sbx run` would
 * too, but the launcher has to be written into it before `sbx run` starts the agent. Rejects
 * only when that creation failed (see there); everything after it is best-effort.
 */
export async function prepareSbxRun(request: SbxRunRequest): Promise<{ args: string[]; missing: string[] }> {
  const { agentId, config, onData } = request;
  const env = request.env ?? [];
  const name = sandboxName(request.projectId, agentId);
  const created = await ensureSandboxExists(agentId, request.projectPath, name, request.sandboxes, onData);
  // Best-effort, same reasoning as the launcher below: no skills or allowed paths in the sandbox
  // is no worse than today, so a failure here must not block the agent itself from starting. A
  // row is mounted for merely *being there* — a folder and a plain file mount the same way
  // (pathMountSpecs); only a path that is gone from this host is reported back as missing.
  // fixedMountSpecs leads the list as the one part of it that is not optional: without it the
  // agent still starts and still works on the project, but with no hook settings, no turn
  // markers and no shell transcript. Best-effort all the same — by here everything it needs is
  // in place (a directory tet created itself, a sandbox mountAll is about to start), so a
  // failure means something is wrong that refusing to start the tab would not fix. The Allowed
  // hosts follow the mounts for the same reason, but only into a sandbox this call created:
  // from then on the sandbox's own rules are the truth, not tet.json (allowHosts).
  const missing = config.paths.map((entry) => entry.path).filter((entry) => !statOf(normalizeHostPath(entry)));
  const specs = [
    ...fixedMountSpecs(request.paths),
    ...(await sessionMountSpecs(request.sessionMounts ?? [])),
    ...grantedMounts(agentId, config).map((spec) => spec.mount)
  ];
  await mountAll(name, specs, onData);
  if (created) {
    await allowHosts(name, config.hosts, onData);
  }
  // sbx run refuses explicit workspace positionals on a sandbox that already exists — even when
  // they are exactly what it already has (verified live, 2026-09-08: "sandbox 'x' already
  // exists and can't be given new workspaces"). ensureSandboxExists above is always its own,
  // separate `sbx create` call, so by the time this `sbx run` executes the sandbox always
  // already exists — whether it did before this function ran or was just created a moment ago —
  // and workspaces are therefore never passed here, not even right after creating it (a real
  // reproduction, not a hypothetical: the "just created" case hit this exact error before this
  // comment was written to say so). The agent positional is for sbx's own verification, per its
  // --help; `--name` is what actually finds the sandbox. It stays the plain agent id even for an
  // agent created from a kit reference — see SBX_CREATE_TARGET.
  const args = [
    "run",
    agentId,
    "--name",
    name,
    ...config.ports.flatMap((port) => ["-p", portKey(port)]),
    ...env.flatMap((entry) => ["-e", entry])
  ];
  if (await ensureControlNetworkAllowed()) {
    const passThrough = [CONTROL_ENV.port, CONTROL_ENV.token, CONTROL_ENV.projectId, CONTROL_ENV.tabId];
    args.push(...passThrough.flatMap((variable) => ["-e", variable]), "-e", `${CONTROL_ENV.host}=host.docker.internal`);
    // Best-effort: the launcher missing is no worse than today (no tet-ctl in the sandbox at
    // all), so a failure here must not block the agent itself from starting.
    await ensureSandboxLauncher(name, onData);
  }
  args.push("--", ...request.agentArgs);
  await suppressSbxFirstRunWizard();
  return { args, missing };
}

/**
 * The dialog's Save button: writes tet.json (ports/paths/hosts), then, if sandboxing is off now,
 * removes every sandbox the project has — there is no more "off but still there" for a sandbox
 * once its agent can't be sent to it again. If it's still on, every existing sandbox either gets
 * removed too (its workspace is no longer this project's path — see ensureSandboxExists for the
 * two ways that happens — and is rebuilt when its next tab starts) or, the normal case, has its
 * live grants narrowed to match (revokeMounts, paths and knowledge alike), whatever ports
 * changed applied (applyPortChanges) and its allowed hosts brought in line both ways
 * (revokeStaleHosts, allowHosts) — none is a create-time workspace or `-p` any more, so an edit
 * no longer forces a rebuild. The hosts' "previous" is each sandbox's own rule list, not
 * tet.json's: the sandbox is the truth for that list (readLiveSbxConfig), so a rule set by hand
 * and now deleted as a row has to go too. Mounts and ports need the sandbox running (each
 * refuses a stopped one), so it is started once for both, and only when either has something
 * to do — a sandbox that is not running has no live grant to narrow, and one whose start fails
 * is skipped, the failed `exec` being the same signal either way. Returns which agents'
 * sandboxes were removed, for the caller to say so: a session of that agent still running in a
 * tab just lost its sandbox under it.
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
