import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { statSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONTROL_ENV } from "../shared/control";
import { SBX_AGENT_IDS } from "../shared/types";
import type { SbxAgentId, SbxFolder, SbxKnowledgeConfig, SbxPort, SbxProjectConfig } from "../shared/types";
import { readSbxConfig, writeSbxConfig } from "./git/commands";
import { augmentAgentPath } from "./terminals/agent-path";
import { toContainerPath } from "./terminals/hook-target";
import { resolveCommand } from "./terminals/pty";
import { checkAgentInstalled } from "./terminals/terminal-session";

/**
 * The one `sbx` process the sbx-settings dialog is ever waiting on — `cancelSbxSetup` kills
 * whichever this is. Never more than one at a time: the dialog's own setup effect awaits each
 * step before starting the next. Only the two slow steps register here (`RunOptions.cancellable`
 * on `login` and `policy init`): a spawn's own `sbx ls` or `sbx create` running at the same
 * moment must not die with the dialog's Cancel button.
 */
let currentChild: ChildProcess | undefined;

/** Set once from main.ts, the moment it has both: the `tet-ctl` bundle it writes the host's own
 *  launcher from (see ensureSandboxLauncher for why a sandbox needs the file itself) and the
 *  control server's port (see ensureControlNetworkAllowed). Unset in a run without a control
 *  channel, and then nothing control-related reaches a sandbox. */
let control: { cliPath: string; port: number } | undefined;
export function configureSandboxes(cliPath: string, port: number): void {
  control = { cliPath, port };
}

interface RunOptions {
  /** Handed to the process's stdin and closed right after — a token, a file's contents. Without
   *  it stdin is closed from the start, so a command that would wait on it fails instead. */
  stdin?: string;
  /** Whether `cancelSbxSetup` may kill this one — see `currentChild`. */
  cancellable?: boolean;
  /**
   * Forwards this call's own console output live, as it arrives — `resolveSbxRun`'s setup
   * (create, mounts, launcher) runs several of these before the tab's own agent process exists,
   * yet the tab's terminal view is already attached and showing (TerminalHost attaches on first
   * sight, not on the pty's first byte), so this is forwarded straight to it exactly like real
   * pty output, through the same generic per-tab `onOutput` channel every other tab's output
   * already uses (`queueOutput` in main.ts takes only ids and a string, never a process). Given a
   * callback, stderr is captured too (normally dropped) and both streams are forwarded in arrival
   * order, `\n` turned into `\r\n` — sbx's own output never carries a bare `\r` (verified live,
   * 2026-09-08, byte for byte), so xterm (no `convertEol`) would otherwise stair-step every line
   * one column further than the last.
   */
  onData?: (chunk: string) => void;
}

type OnData = RunOptions["onData"];

interface RunResult {
  /** Exited 0. */
  ok: boolean;
  stdout: string;
}

/** Every `sbx` invocation: a plain program plus arguments through `resolveCommand`, no shell,
 *  run from the temp directory so the working directory never reads as a workspace. stderr is
 *  dropped unless `onData` wants it forwarded — every caller otherwise decides by exit code or by
 *  stdout's JSON. */
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
 * Kills whichever `sbx` step (`login` or `policy init`, the two slow ones) is currently running,
 * for the dialog's Cancel button. Plain `kill()`, not the `taskkill /T /F` some other spawns
 * need on win32 (see `ask.ts`) — that workaround is for an npm shim running under cmd.exe;
 * `resolveCommand` resolves `sbx.exe` as a native executable directly, no cmd.exe in between.
 */
export function cancelSbxSetup(): void {
  currentChild?.kill();
  currentChild = undefined;
}

/**
 * Whether Docker Sandboxes' `sbx` CLI is on PATH — deliberately not part of `Requirements.met`:
 * sbx is opt-in per project, never a reason to block the workspace from opening. Never cached,
 * and PATH re-read first, the way `startup:check` does it: the dialog's "Check again" is pressed
 * right after installing, and the installer's directory (`win32AgentDirs`) was not on this
 * process's PATH a moment ago.
 *
 * `version` is a subcommand, not a `--version` flag (verified against a real install,
 * 2026-09-07: `sbx --version` fails with "unknown flag").
 */
export async function checkSbxInstalled(): Promise<boolean> {
  await augmentAgentPath();
  const installed = await checkAgentInstalled("sbx", ["version"], os.tmpdir());
  if (installed) {
    await suppressSbxFirstRunWizard();
  }
  return installed;
}

/**
 * sbx shows a one-time "detected configuration" wizard on the very first real interactive
 * `sbx run` a machine ever does — not from tet's own non-interactive `sbx create`/`exec`/`mount`
 * calls, only from a genuine pty attach, which is exactly what a tet terminal tab is. Found live,
 * 2026-09-08: it showed up unannounced inside a real tab, and its own skills-store import
 * (mistaken by the user for a Claude Code prompt) happened to coincide with the "already exists
 * and can't be given new workspaces" bug prepareSbxRun now avoids on its own — the two turned
 * out unrelated, but the wizard appearing inside a live agent tab at all is a surprise tet
 * should not hand the user.
 *
 * Gated by a plain marker file — verified live: once
 * `%LOCALAPPDATA%\DockerSandboxes\sandboxes\config\first-run-import.json` exists, the wizard
 * never shows again, and *any* valid JSON satisfies it (a bare `{}` suppressed it exactly like
 * sbx's own real `{"offeredAt": …}`). Never overwrites a file already there — a real offer the
 * user already answered stays exactly as sbx left it. Costs the wizard's own one-time offers:
 * agent secrets (each sandboxed agent signs in inside its sandbox, not missed), skills (tet's own
 * knowledge mounts are live and per-agent, better than the wizard's one-time, agent-agnostic
 * copy) — and MCP servers, which *is* a real loss: `sbx mcp` has no import command at all, so a
 * user who wants their host MCP servers in a sandbox now has to run `sbx setup` or `sbx mcp add`
 * by hand. Undocumented, private sbx state, Windows-only verified — macOS/Linux paths are
 * unknown, so this is a no-op there for now (TODO once verified); best-effort even on Windows,
 * since a failure to write it must not stop the installed-check it rides on.
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

/**
 * Whether the user is signed in to sbx — never cached either: signing in or out happens
 * outside tet at any time, so a stale answer would be actively wrong rather than merely late.
 * `sbx ls` is the probe: side-effect-free, no sandbox created, and it needs the same auth every
 * other sbx command does (verified against a real install, 2026-09-07: signed out,
 * `sbx ls`/`sbx create` exit 1 with "ERROR: Not authenticated to Docker").
 *
 * Not `sbx policy ls`, tried first and wrong: it exits 1 on a signed-in account too, with
 * "global network policy has not been initialized" — indistinguishable by exit code alone from
 * not being signed in at all, since a fresh account has no policy yet (measured live: this
 * false-negative fired for real). `sbx ls` never touches policy state, only auth.
 *
 * Treats every other failure as "not logged in" too, on purpose: attempting a login for nothing
 * costs one glance at an "already signed in" message, while showing the dialog's real content on
 * some other, unrecognized failure would look like it worked when it cannot.
 */
export async function checkSbxLoggedIn(): Promise<boolean> {
  return (await runSbx(["ls"])).ok;
}

/**
 * Runs `sbx login` with no terminal of its own — `sbx login` opens the OAuth page in the
 * user's browser itself and waits on its own local callback, so nothing here needs a console.
 */
export async function runSbxLogin(): Promise<boolean> {
  return (await runSbx(["login"], { cancellable: true })).ok;
}

/**
 * Whether the machine-wide network policy has ever been set — a third precondition next to
 * installed/signed in, found by testing `sbx create` for real (2026-09-07): both it and
 * `sbx policy ls` fail with "global network policy has not been initialized" until
 * `sbx policy init` has run once. Safe to read `sbx policy ls` as "initialized?" here
 * specifically because this only ever runs after `checkSbxLoggedIn` already confirmed the user
 * is signed in, so the auth failure this probe could also produce is not a live confound.
 */
export async function checkSbxPolicyInitialized(): Promise<boolean> {
  return (await runSbx(["policy", "ls"])).ok;
}

/**
 * Sets the machine-wide network policy to "balanced" — Docker's own recommended default to get
 * started, and a one-time, all-sandboxes setting: not something a per-project dialog should
 * offer a choice for, changing it later needs `sbx policy reset` first, which stops every
 * running sandbox on the machine.
 */
export async function initSbxPolicy(): Promise<boolean> {
  return (await runSbx(["policy", "init", "balanced"], { cancellable: true })).ok;
}

/**
 * The first of the three preconditions above not met, worded for a notice — or undefined when
 * a sandbox can be run. The same checks in the same order the sbx-settings dialog walks before it
 * ever offers Save; session-manager.ts asks this once more before every sandboxed spawn, since
 * things may have changed since (see its resolveSbxRun for what it does with the answer).
 */
export async function sbxNotReady(): Promise<string | undefined> {
  if (!(await checkSbxInstalled())) {
    return "SBX is not installed (or no longer on PATH)";
  }
  if (!(await checkSbxLoggedIn())) {
    return "SBX is not signed in to Docker";
  }
  if (!(await checkSbxPolicyInitialized())) {
    return "SBX's network policy is not set up";
  }
  return undefined;
}

/** The two policy kinds tet has to know are org-managed or not — see checkSbxGoverned. */
type PolicyType = "filesystem" | "network";

/** Cached for the process's lifetime, per kind: whether org governance is active does not
 *  change while tet runs, and `sbx policy ls` is one more process to spawn on every sandboxed
 *  session start. */
const governed = new Map<PolicyType, Promise<boolean>>();

/**
 * Whether this account's policy of one kind is org-managed — `sbx policy ls`'s SOURCE column
 * reads "local" for an ungoverned account (verified live, 2026-09-08); Docker's own docs
 * (docker/docs) say a governed one reads "Managed by <org>" instead, and that an admin can
 * delegate a kind back to local control, which is why this asks per kind. Not verified against
 * an actual governed account — none was available to test with.
 *
 * "filesystem" governed means no local mount can be allowed — not the agent's own config
 * directory, not tet's data folders (see computeWorkspaces), let alone the user's — so sbx
 * sandboxing is off for tet as a whole: the dialog says so instead of its fields, and a project
 * that has it enabled in tet.json starts its agents on the host (session-manager.ts's
 * resolveSbxRun). "network" governed only costs the control channel inside a sandbox
 * (ensureControlNetworkAllowed).
 */
export function checkSbxGoverned(type: PolicyType): Promise<boolean> {
  let pending = governed.get(type);
  if (!pending) {
    pending = runSbx(["policy", "ls", "--type", type]).then((result) => /managed by/i.test(result.stdout));
    governed.set(type, pending);
  }
  return pending;
}

/** Cached per app run: once the rule is there, it stays there — no reason to ask `sbx` again. */
let networkAllowed: Promise<void> | undefined;

/**
 * Lets a sandboxed session reach tet's control channel: allows the sandbox's own egress to
 * `localhost:<port>` — **not** `host.docker.internal`, even though that is the hostname the
 * request itself is made to. Verified live, 2026-09-08, against docker/docs'
 * sandboxes/workflows/development.md: sbx's proxy translates `host.docker.internal` to
 * `localhost` before checking the policy and forwarding, so the allow rule has to name the
 * translated form and the exact port — a bare `host.docker.internal` rule (an earlier version of
 * this function) silently matched nothing, and every request from inside the sandbox connected
 * without error but never reached the control server at all. See tet-ctl.ts's `send` for why
 * this proxy being HTTP-only is also why the control server speaks HTTP rather than a raw
 * NDJSON socket. Skipped entirely under org governance — a local `sbx policy allow network` is
 * silently ignored there anyway, and the point of asking first is to not even try:
 * `prepareSbxRun` leaves TET_CONTROL_HOST/PORT/TOKEN out of the sandbox's env in that case, so
 * tet-ctl inside it fails closed instead of reaching for a host address nothing agreed to
 * expose.
 */
async function ensureControlNetworkAllowed(): Promise<boolean> {
  if (!control || (await checkSbxGoverned("network"))) {
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
 * A deterministic sandbox name per (project, agent) — `sbx create --name` only allows letters,
 * numbers, hyphens and periods, so the project id (a uuid on every platform) is hashed rather
 * than used as-is. Stable across restarts: the same pair always resolves to the same sandbox, so
 * `sbx run --name` reattaches instead of creating a second one.
 */
export function sandboxName(projectId: string, agentId: SbxAgentId): string {
  const hash = crypto.createHash("sha1").update(projectId).digest("hex").slice(0, 12);
  return `tet-${agentId}-${hash}`;
}

/** `~` the way tet.json holds a folder under the home (contractHome's `~` and `~/…`) — expanded
 *  before it ever reaches `sbx`, which is not a shell and would otherwise pass the tilde
 *  through literally. */
function expandHome(folderPath: string): string {
  if (folderPath === "~") {
    return os.homedir();
  }
  return folderPath.startsWith("~/") ? path.join(os.homedir(), folderPath.slice(2)) : folderPath;
}

/**
 * The inverse, for what goes into tet.json: a folder under this user's home is stored as `~/…`
 * with forward slashes, so the same row serves a colleague on the same OS under another user
 * name (`C:\Users\saka\data` and `C:\Users\anna\data` are one row, `~/data`). Anything
 * else — outside the home, or not absolute — is stored as typed. Case-insensitive on win32
 * through `path.relative` itself.
 */
export function contractHome(folderPath: string): string {
  const typed = folderPath.trim();
  const resolved = normalizeFolder(typed);
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

/** A typed folder path as sbx will list it back: `~` expanded, separators native, no trailing
 *  one. A relative path is left alone — it is meaningless here either way. */
function normalizeFolder(folderPath: string): string {
  const expanded = expandHome(folderPath.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
}

/**
 * The `sbx mount`/`sbx umount` MOUNT_SPEC for one allowed-folder row — a live bind mount, not a
 * `sbx create` workspace positional (see computeWorkspaces' own comment for why folders moved off
 * that list). `sbx mount`'s own spec grammar is `HOST[:CTR_TARGET[:ro|rw]]`, and a bare two-part
 * `HOST:ro` parses as `HOST:CTR_TARGET="ro"` there (verified live, 2026-09-08: "CTR_TARGET 'ro'
 * must be absolute") — unlike `sbx create`'s positional, where the same suffix means read-only at
 * the same path. So Read+Write, which needs no suffix at all, mounts with the bare host path
 * (sbx maps it to the same path inside on its own); Read needs the explicit three-part form, and
 * repeating the *host* path as CTR_TARGET breaks the parser on Windows (two drive-letter colons
 * in one spec) — `toContainerPath` gives the one form that works, matching what sbx itself
 * reported back for a real mount. `unmount` drops the `:ro`/`:rw` — `sbx umount`'s own syntax is
 * `HOST[:CTR_TARGET]`, and an explicit-target mount must be revoked with that same target.
 */
export function folderMountSpecs(folder: SbxFolder): { mount: string; unmount: string } {
  const host = normalizeFolder(folder.path);
  if (folder.access === "Read+Write") {
    return { mount: host, unmount: host };
  }
  const target = toContainerPath(host);
  return { mount: `${host}:${target}:ro`, unmount: `${host}:${target}` };
}

/** What is at a host path, or undefined for nothing — a folder to allow, a skills directory, an
 *  instructions file, each only mounted when it is actually there. */
function statOf(candidate: string): Stats | undefined {
  try {
    return statSync(candidate);
  } catch {
    return undefined;
  }
}

/** The terminal layer's two paths a sandbox is built around — `AgentPaths` fits, and so does a
 *  plain pair, so sbx.ts never has to import the agent layer's own type. */
export interface SandboxPaths {
  agentDir: string;
  contextFile: string;
}

/**
 * Every `sbx create` workspace positional for one agent tab — tet's own fixed paths only, never
 * the user's "Allowed folders": those are a live `sbx mount`/`umount` (see folderMountSpecs and
 * prepareSbxRun), not a create-time positional, because `sbx create`/`run` refuses to add a
 * workspace to a sandbox that already exists with a different set ("sandbox 'x' already exists
 * and can't be given new workspaces" — verified live, 2026-09-08), which used to mean any
 * Allowed-folders edit had to destroy and rebuild the whole sandbox. The two fixed paths still go
 * through this list — they never change once a project's sandbox exists, so the mismatch this
 * guards against in practice never fires for them: `agentDir` (tet's own generated hook
 * settings and markers, read-write) and the directory holding the shell-context file
 * (read-only, only ever `cat`).
 *
 * Deliberately *not* the agent's own config directory (`~/.claude`, `~/.codex`): mounted with
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME` pointed at it, the sandboxed CLI is signed in as the host —
 * measured live, 2026-09-08: Claude answered over the host's OAuth credentials at once, and a
 * `/login` inside would replace the host's — so the sandbox keeps its own config directory and
 * its own sign-in. Its skills, plugins and instructions file come in as separate live mounts
 * instead (knowledgePaths); its sessions stay out.
 */
export function computeWorkspaces(projectPath: string, paths: SandboxPaths): string[] {
  return [projectPath, paths.agentDir, `${path.dirname(paths.contextFile)}:ro`];
}

/** Every sandbox template's non-root user, and its home — verified live, 2026-09-08, for both
 *  a Claude and a Codex sandbox (`$HOME` and `whoami`). `sbx mount`'s target must be an absolute
 *  path (its own `--help`): it is not passed through a shell, so `~` never expands there. */
const SANDBOX_HOME = "/home/agent";

interface KnowledgeEntry {
  host: string;
  target: string;
}

/**
 * This agent's shareable, non-identity knowledge on the host — skills, plugins, and its own
 * instructions file — one list per `SbxKnowledgeConfig` kind (see its own comment in
 * shared/types.ts for why each is its own switch). Never the config directory itself or anything
 * beyond this fixed list — see computeWorkspaces for why identity (auth, sessions) stays out
 * regardless. A host path that does not exist yet (no skills installed, no instructions file
 * written) is simply left out by the caller.
 *
 * All paths measured live, 2026-09-08, against a real install. Claude: `~/.claude/skills`,
 * `~/.claude/plugins` (its actual plugin code, not just metadata) and `~/.claude/CLAUDE.md`.
 * Codex's skills come from *two* real, independent locations it both actually reads — verified
 * via Codex's own "failed to load skill" log lines naming both paths for two deliberately-broken
 * test skills, one at each: `~/.codex/skills` (what a live folder listing on a real install
 * showed populated) and `~/.agents/skills` (what OpenAI's own docs call the "personal skills
 * folder") — both real, neither alone is the whole story. `~/.codex/plugins` was confirmed by
 * installing and removing a real plugin: its code lands under
 * `plugins/cache/<marketplace>/<plugin>/<hash>`, so the whole directory is the unit to mount,
 * same as Claude's. Codex's own instructions file is `~/.codex/AGENTS.md` — preferring
 * `AGENTS.override.md` when present is Codex's own documented load order (OpenAI's docs), not
 * itself verified live here, since neither file exists on the machine this was measured on.
 */
function knowledgePaths(agentId: SbxAgentId): Record<keyof SbxKnowledgeConfig, KnowledgeEntry[]> {
  const home = os.homedir();
  if (agentId === "claude") {
    return {
      skills: [{ host: path.join(home, ".claude", "skills"), target: `${SANDBOX_HOME}/.claude/skills` }],
      plugins: [{ host: path.join(home, ".claude", "plugins"), target: `${SANDBOX_HOME}/.claude/plugins` }],
      instructions: [{ host: path.join(home, ".claude", "CLAUDE.md"), target: `${SANDBOX_HOME}/.claude/CLAUDE.md` }]
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
 * The `sbx mount` specs for this agent's enabled knowledge kinds that exist on this host —
 * `HOST:TARGET[:ro]` (v0.39.0, verified live 2026-09-08): a real runtime bind mount at an
 * arbitrary container path, not a symlink, since sbx cannot follow one that points outside its
 * own workspace (Docker's own sbx-quickstart guide) — this is what makes a single, curated path
 * (a folder or a plain file, both measured working) land exactly where the agent looks for it,
 * without copying anything. `:ro`/no suffix — the same sbx default (`:rw` when omitted),
 * verified in `sbx mount --help`.
 */
function knowledgeMountSpecs(agentId: SbxAgentId, knowledge: SbxKnowledgeConfig): string[] {
  const paths = knowledgePaths(agentId);
  return (Object.keys(knowledge) as (keyof SbxKnowledgeConfig)[]).flatMap((kind) => {
    const access = knowledge[kind];
    if (!access) {
      return [];
    }
    const suffix = access === "Read" ? ":ro" : "";
    return paths[kind].filter((entry) => statOf(entry.host)).map((entry) => `${entry.host}:${entry.target}${suffix}`);
  });
}

/** Which sandboxes already got the `tet-ctl` launcher written this run — the file is small
 *  (~10 KB) but there is still no reason to `sbx exec` it in again on every single tab spawn.
 *  Forgotten along with the sandbox in removeSandbox. */
const launcherWritten = new Set<string>();

/** `sbx ls --json`'s workspaces for one sandbox, or undefined if it does not exist. */
async function getSandboxWorkspaces(name: string): Promise<string[] | undefined> {
  try {
    const parsed = JSON.parse((await runSbx(["ls", "--json"])).stdout) as {
      sandboxes?: { name?: string; workspaces?: string[] }[];
    };
    return parsed.sandboxes?.find((sandbox) => sandbox.name === name)?.workspaces;
  } catch {
    return undefined;
  }
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
 * Makes sure a sandbox exists with exactly `workspaces` — tet's own fixed paths only now that
 * Allowed folders are a live mount (see computeWorkspaces), so this practically never disagrees
 * once a project's sandbox exists. One that exists with a *different* set is rebuilt rather than
 * reused: `computeWorkspaces` cannot change within one running instance of tet (its inputs —
 * project id, agent id, storageRoot — are all already fixed), so a mismatch can only mean this
 * sandbox is left over from a *previous* run (an older tet version's path scheme, or one this
 * session's own bug produced) — nothing currently open in this process is actually attached to
 * it, since attaching to it is exactly what this same check would have refused. Safe to remove
 * outright.
 */
async function ensureSandboxExists(agentId: SbxAgentId, workspaces: string[], name: string, onData?: OnData): Promise<void> {
  const existing = await getSandboxWorkspaces(name);
  if (existing !== undefined && sameWorkspaceSet(existing, workspaces)) {
    return;
  }
  if (existing !== undefined) {
    await removeSandbox(name, onData);
  }
  await runSbx(["create", agentId, ...workspaces, "--name", name], { onData });
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
 * Applies live bind mounts — knowledge and Allowed folders alike — to a sandbox that already
 * exists (ensureSandboxExists ran first). Re-applied on *every* start rather than once per
 * sandbox: unlike a file written into the sandbox's own disk (ensureSandboxLauncher's tet-ctl),
 * a runtime bind mount does not survive a stop/restart — measured live, the target was empty
 * again afterward — and a sandbox can be stopped from outside tet (a plain `sbx stop`), so there
 * is no reliable moment to cache "already mounted" against. The command is its own idempotency
 * check when it is not needed again (sbx's own guarantee); an access change or a removed folder
 * is narrowed immediately at Save instead (see revokeStaleFolders) — so by the time this runs,
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
 * Narrows a running sandbox's folder grants the moment the user changes them, rather than
 * leaving the old one in force until whoever has that tab open next restarts it: a folder
 * dropped from Allowed folders, or downgraded from Read+Write to Read, must stop being
 * (over-)accessible *now*. Needed because the grant a `sbx mount` makes survives a sandbox
 * stop/restart even though the live bind does not (verified live, 2026-09-08: mounting the same
 * host path again with a different access after a restart still hit the "already mounted"
 * conflict) — so nothing here can rely on a later mount to self-correct it. Best-effort: a
 * sandbox that was never created, or is not currently running, has no live grant to narrow, and
 * the failed `exec` is the same signal either way.
 */
async function revokeStaleFolders(name: string, previous: SbxFolder[], current: SbxFolder[]): Promise<void> {
  const stale = previous.filter((old) => {
    const match = current.find((next) => normalizeFolder(next.path) === normalizeFolder(old.path));
    return !match || match.access !== old.access;
  });
  if (stale.length === 0 || !(await ensureRunning(name))) {
    return;
  }
  for (const folder of stale) {
    await runSbx(["umount", name, folderMountSpecs(folder).unmount]);
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
 * — so only the actual delta may be sent, never the whole current list.
 */
async function applyPortChanges(name: string, previous: SbxPort[], current: SbxPort[]): Promise<void> {
  const previousKeys = new Set(previous.map(portKey));
  const currentKeys = new Set(current.map(portKey));
  const removed = previous.filter((port) => !currentKeys.has(portKey(port)));
  const added = current.filter((port) => !previousKeys.has(portKey(port)));
  if ((removed.length === 0 && added.length === 0) || !(await ensureRunning(name))) {
    return;
  }
  for (const port of removed) {
    await runSbx(["ports", name, "--unpublish", portKey(port)]);
  }
  for (const port of added) {
    await runSbx(["ports", name, "--publish", portKey(port)]);
  }
}

export interface SbxRunRequest {
  agentId: SbxAgentId;
  projectId: string;
  projectPath: string;
  config: SbxProjectConfig;
  paths: SandboxPaths;
  /** The agent's own command line inside the sandbox — hook and resume arguments, after `sbx
   *  run`'s own "--". */
  agentArgs: string[];
  /** Every setup step's own console output, forwarded live to the tab that is about to run in
   *  this sandbox — see `RunOptions.onData` for why this needs no pty of its own to reach it. */
  onData?: OnData;
}

/**
 * Readies one agent tab's sandbox and returns the full `sbx run` argument list for it — fixed
 * workspaces (computeWorkspaces), live-mounted knowledge and Allowed folders (whose `missing` is
 * passed on for the caller to say), published ports, and (when network policy allows it, see
 * ensureControlNetworkAllowed) the control-channel env and `tet-ctl` launcher. Creates the
 * sandbox first if it is missing (ensureSandboxExists) — `sbx run` would too, but the launcher
 * has to be written into it before `sbx run` starts the agent.
 */
export async function prepareSbxRun(request: SbxRunRequest): Promise<{ args: string[]; missing: string[] }> {
  const { agentId, config, onData } = request;
  const name = sandboxName(request.projectId, agentId);
  await ensureSandboxExists(agentId, computeWorkspaces(request.projectPath, request.paths), name, onData);
  // Best-effort, same reasoning as the launcher below: no skills or folders in the sandbox is no
  // worse than today, so a failure here must not block the agent itself from starting. A no-op
  // when nothing is enabled or nothing enabled exists on this host.
  const missing: string[] = [];
  const specs = knowledgeMountSpecs(agentId, config.knowledge);
  for (const folder of config.folders) {
    if (statOf(normalizeFolder(folder.path))?.isDirectory()) {
      specs.push(folderMountSpecs(folder).mount);
    } else {
      missing.push(folder.path);
    }
  }
  await mountAll(name, specs, onData);
  // sbx run refuses explicit workspace positionals on a sandbox that already exists — even when
  // they are exactly what it already has (verified live, 2026-09-08: "sandbox 'x' already
  // exists and can't be given new workspaces"). ensureSandboxExists above is always its own,
  // separate `sbx create` call, so by the time this `sbx run` executes the sandbox always
  // already exists — whether it did before this function ran or was just created a moment ago —
  // and workspaces are therefore never passed here, not even right after creating it (a real
  // reproduction, not a hypothetical: the "just created" case hit this exact error before this
  // comment was written to say so). The agent positional is for sbx's own verification, per its
  // --help; `--name` is what actually finds the sandbox.
  const args = ["run", agentId, "--name", name, ...config.ports.flatMap((port) => ["-p", portKey(port)])];
  if (await ensureControlNetworkAllowed()) {
    const passThrough = [CONTROL_ENV.port, CONTROL_ENV.token, CONTROL_ENV.projectId, CONTROL_ENV.tabId];
    args.push(...passThrough.flatMap((variable) => ["-e", variable]), "-e", `${CONTROL_ENV.host}=host.docker.internal`);
    // Best-effort: the launcher missing is no worse than today (no tet-ctl in the sandbox at
    // all), so a failure here must not block the agent itself from starting.
    await ensureSandboxLauncher(name, onData);
  }
  args.push("--", ...request.agentArgs);
  return { args, missing };
}

/**
 * The dialog's Save button: writes tet.json (ports/folders), then, if sandboxing is off now,
 * removes every sandbox the project has — there is no more "off but still there" for a sandbox
 * once its agent can't be sent to it again. If it's still on, every existing sandbox either gets
 * removed too (its *fixed* paths no longer match — never actually seen in practice, see
 * computeWorkspaces — and is rebuilt when its next tab starts) or, the normal case, has its live
 * folder grants narrowed to match (revokeStaleFolders) and whatever ports changed applied
 * (applyPortChanges) — neither is a create-time workspace or `-p` any more, so an edit no longer
 * forces a rebuild. Returns which agents' sandboxes were removed, for the caller to say so: a
 * session of that agent still running in a tab just lost its sandbox under it. `getPaths` is
 * session-manager.ts's own per-agent paths, handed in rather than imported so sbx.ts never
 * reaches into the terminal layer's state directly.
 */
export async function saveSbxConfig(
  projectPath: string,
  projectId: string,
  request: SbxProjectConfig,
  getPaths: (agentId: SbxAgentId) => SandboxPaths
): Promise<SbxAgentId[]> {
  const previous = await readSbxConfig(projectPath);
  const config = { ...request, folders: request.folders.map((folder) => ({ ...folder, path: contractHome(folder.path) })) };
  await writeSbxConfig(projectPath, config);
  const removed: SbxAgentId[] = [];
  for (const agentId of SBX_AGENT_IDS) {
    const name = sandboxName(projectId, agentId);
    const existing = await getSandboxWorkspaces(name);
    if (existing === undefined) {
      continue;
    }
    if (!config.enabled || !sameWorkspaceSet(existing, computeWorkspaces(projectPath, getPaths(agentId)))) {
      if (await removeSandbox(name)) {
        removed.push(agentId);
      }
      continue;
    }
    await revokeStaleFolders(name, previous.folders, config.folders);
    await applyPortChanges(name, previous.ports, config.ports);
  }
  return removed;
}
