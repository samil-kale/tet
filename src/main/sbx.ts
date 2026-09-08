import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONTROL_ENV } from "../shared/control";
import { SBX_AGENT_IDS } from "../shared/types";
import type { SbxAgentId, SbxFolder, SbxProjectConfig, SbxSaveRequest } from "../shared/types";
import { writeSbxConfig } from "./git/commands";
import { augmentAgentPath } from "./terminals/agent-path";
import { toContainerPath } from "./terminals/os-notify";
import { checkAgentInstalled } from "./terminals/terminal-session";
import { resolveCommand } from "./terminals/pty";

/**
 * The one `sbx` process the enable-sbx dialog is ever waiting on — `cancelSbxSetup` kills
 * whichever this is. Never more than one at a time: the dialog's own setup effect awaits each
 * step before starting the next. Only the dialog's steps register here
 * (`RunOptions.cancellable`): a spawn's own `sbx ls` or `sbx create` running at the same moment
 * must not die with the dialog's Cancel button.
 */
let currentChild: ChildProcess | undefined;

interface RunOptions {
  /** Handed to the process's stdin and closed right after — a token, a file's contents. Without
   *  it stdin is closed from the start, so a command that would wait on it fails instead. */
  stdin?: string;
  /** Whether `cancelSbxSetup` may kill this one — see `currentChild`. */
  cancellable?: boolean;
}

interface RunResult {
  /** Exited 0. */
  ok: boolean;
  stdout: string;
}

/** Every `sbx` invocation: a plain program plus arguments through `resolveCommand`, no shell,
 *  run from the temp directory so the working directory never reads as a workspace. stderr is
 *  dropped — every caller decides by exit code or by stdout's JSON. */
function runSbx(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const resolved = resolveCommand("sbx", args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"]
    });
    if (options.cancellable) {
      currentChild = child;
    }
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
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
  return checkAgentInstalled("sbx", ["version"], os.tmpdir());
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
  return (await runSbx(["ls"], { cancellable: true })).ok;
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
  return (await runSbx(["policy", "ls"], { cancellable: true })).ok;
}

/**
 * Sets the machine-wide network policy to "balanced" — Docker's own recommended default to get
 * started, and a one-time, all-sandboxes setting (see "Der eigentliche Blocker" in the plan):
 * not something a per-project dialog should offer a choice for, changing it later needs
 * `sbx policy reset` first, which stops every running sandbox on the machine.
 */
export async function initSbxPolicy(): Promise<boolean> {
  return (await runSbx(["policy", "init", "balanced"], { cancellable: true })).ok;
}

/**
 * `sbx secret set`'s built-in service names (`sbx secret set --help`, 2026-09-08: "Available
 * services: anthropic, cursor, droid, github, google, groq, mistral, nebius, openai, openrouter,
 * xai") for the two agents the dialog has real fields for. Both verified live: a sandboxed
 * Claude/Codex started without credentials names exactly this service in its own prompt. Set
 * globally, not `--sandbox`-scoped: "Service secrets apply globally by default … available to
 * all sandboxes" (the same help text), and a per-project key was never asked for — scoping
 * would need the sandbox to exist at Save time, which is what made Save half a spawn.
 */
const SANDBOX_SERVICE: Record<SbxAgentId, string> = {
  claude: "anthropic",
  codex: "openai"
};

/**
 * Environment variable that redirects this agent's config/session directory — set to the same
 * path SbxFixedPaths.configDir mounts, so the sandboxed CLI
 * reads and writes the *same* files tet's own host-side session listing already watches, instead
 * of a fresh, invisible directory inside the container. Codex's `$CODEX_HOME` is verified live
 * (2026-09-08: `codex doctor` inside the sandbox reports the host's own auth file); Claude's
 * `CLAUDE_CONFIG_DIR` is documented but not verified against a real sbx sandbox — if session
 * listing/resume silently stops working for sandboxed Claude tabs, check this first.
 */
const CONFIG_DIR_ENV: Record<SbxAgentId, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME"
};

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

/**
 * One `sbx create`/`sbx run` positional for an allowed-folder row — `:ro` is sbx's own suffix
 * for read-only, the only mode it has besides read-write. Normalized the way sbx stores it
 * (verified live, 2026-09-08: `C:/x/` is listed back as `C:\x`, case kept) — the typed form
 * has to compare equal to `sbx ls`'s, or ensureSandboxExists would see a changed set and refuse
 * every single spawn.
 */
export function folderArg(folder: SbxFolder): string {
  const normalized = normalizeFolder(folder.path);
  return folder.access === "Read" ? `${normalized}:ro` : normalized;
}

/** A typed folder path as sbx will list it back: `~` expanded, separators native, no trailing
 *  one. A relative path is left alone — it is meaningless here either way. */
function normalizeFolder(folderPath: string): string {
  const expanded = expandHome(folderPath.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
}

/** Cached for the process's lifetime: whether org governance is active does not change while
 *  tet runs, and `sbx policy ls` is one more process to spawn on every sandboxed session start. */
let governanceChecked: Promise<boolean> | undefined;

/**
 * Whether this account is under org-managed governance — `sbx policy ls`'s SOURCE column reads
 * "local" for an ungoverned account (verified live, 2026-09-08); the plan's earlier research
 * (docker/docs) says a governed one reads "Managed by <org>" instead. Not verified against an
 * actual governed account in this session — no such account was available to test with.
 */
function checkSbxGovernance(): Promise<boolean> {
  governanceChecked ??= runSbx(["policy", "ls"]).then((result) => /managed by/i.test(result.stdout));
  return governanceChecked;
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
 * silently ignored there anyway (see the plan's "Der eigentliche Blocker"), and the point of
 * asking first is to not even try: `prepareSbxRun` leaves TET_CONTROL_HOST/PORT/TOKEN out of
 * the sandbox's env in that case, so tet-ctl inside it fails closed instead of reaching for a
 * host address nothing agreed to expose.
 */
async function ensureControlNetworkAllowed(): Promise<boolean> {
  if (!control || (await checkSbxGovernance())) {
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
 * The three host paths every sandbox of this agent mounts whatever tet.json holds — never
 * through the dialog's "Allowed folders", which is the user's own list and shows none of them:
 * the agent's own config directory (`~/.claude`, `~/.codex` — read-write, what its
 * CONFIG_DIR_ENV points at), `agentDir` (tet's own generated hook settings and markers,
 * read-write) and the directory holding the shell-context file (read-only, only ever `cat`).
 */
export interface SbxFixedPaths {
  configDir: string;
  agentDir: string;
  contextDir: string;
}

/**
 * The fixed paths above from the terminal layer's own paths for this agent. Structural input
 * rather than `AgentPaths` itself so sbx.ts stays agent-layer-agnostic, the way it already is
 * about SANDBOX_SERVICE.
 */
export function sandboxPaths(agentId: SbxAgentId, paths: { agentDir: string; contextFile: string }): SbxFixedPaths {
  return {
    configDir: path.join(os.homedir(), `.${agentId}`),
    agentDir: paths.agentDir,
    contextDir: path.dirname(paths.contextFile)
  };
}

export interface Workspaces {
  /** Every `sbx create`/`sbx run` workspace positional, in order. */
  workspaces: string[];
  /** The configured folders left out for not being a directory on this machine, as typed. */
  missing: string[];
}

function isDirectory(folderPath: string): boolean {
  try {
    return statSync(folderPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `sbx create`/`sbx run` workspace positional for one agent tab, computed once and shared
 * by both callers: `sbx create`/`run` refuses to add a workspace to a sandbox that already
 * exists with a different set ("sandbox 'x' already exists and can't be given new workspaces" —
 * verified live, 2026-09-08), so what `saveSbxConfig` compares an existing sandbox against and
 * what `prepareSbxRun` then runs with must be the exact same list — which is also why a folder
 * that does not exist is left out *here*, for both, rather than at the spawn alone: handed to
 * sbx it asks "The selected workspace does not exist. Would you like to create it? (y/N)"
 * (measured live, 2026-09-08) — `sbx create` with no stdin cancels on that, `sbx run` in the tab
 * blocks the agent's start on it. Left out, the sandbox comes up without it; the spawn says so.
 *
 * The three `fixed` paths are mounted unconditionally — never through `folders`, which is the
 * user's own list and must not be able to break any of them. A row for the config
 * directory (read-only, even) may still be typed into the dialog or written into tet.json by
 * hand, so it is dropped by path rather than mounted twice; every other exact duplicate is
 * dropped too, since sbx lists a repeated workspace once and sending it twice would read as a
 * changed set on every spawn.
 */
export function computeWorkspaces(projectPath: string, folders: SbxFolder[], fixed: SbxFixedPaths): Workspaces {
  const userFolders: string[] = [];
  const missing: string[] = [];
  for (const folder of folders) {
    const normalized = normalizeFolder(folder.path);
    if (normalized === fixed.configDir) {
      continue;
    }
    if (!isDirectory(normalized)) {
      missing.push(folder.path);
      continue;
    }
    userFolders.push(folderArg(folder));
  }
  return {
    workspaces: [...new Set([projectPath, fixed.configDir, ...userFolders, fixed.agentDir, `${fixed.contextDir}:ro`])],
    missing
  };
}

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

/** Which sandboxes already got the `tet-ctl` launcher written this run — the file is small
 *  (~10 KB) but there is still no reason to `sbx exec` it in again on every single tab spawn.
 *  Forgotten along with the sandbox when saveSbxConfig removes it. */
const launcherWritten = new Set<string>();

/**
 * Makes sure a sandbox exists with exactly `workspaces`, creating it if it is not there yet.
 * One that exists with a *different* set is an error, not a rebuild: sbx itself refuses to add
 * or change workspaces on an existing sandbox (see computeWorkspaces), and rebuilding here —
 * `sbx rm` under a session of the same project and agent that may be mid-turn in another tab —
 * is what saveSbxConfig does instead, at the one moment the user changed the folders and
 * expects it. The message reaches the user as the tab's "could not be started" notice.
 */
async function ensureSandboxExists(agentId: SbxAgentId, workspaces: string[], name: string): Promise<void> {
  const existing = await getSandboxWorkspaces(name);
  if (existing === undefined) {
    await runSbx(["create", agentId, ...workspaces, "--name", name]);
  } else if (!sameWorkspaceSet(existing, workspaces)) {
    throw new Error("its SBX sandbox has other folders than the configuration — save the SBX configuration again to rebuild it");
  }
}

/** Set once from main.ts, the moment it has both: the `tet-ctl` bundle it writes the host's own
 *  launcher from (see ensureSandboxLauncher for why a sandbox needs the file itself) and the
 *  control server's port (see ensureControlNetworkAllowed). Unset in a run without a control
 *  channel, and then nothing control-related reaches a sandbox. */
let control: { cliPath: string; port: number } | undefined;
export function configureSandboxes(cliPath: string, port: number): void {
  control = { cliPath, port };
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
async function ensureSandboxLauncher(name: string): Promise<void> {
  if (!control || launcherWritten.has(name)) {
    return;
  }
  const bundle = await fs.readFile(control.cliPath, "utf8").catch(() => undefined);
  if (bundle === undefined) {
    return;
  }
  const written = await runSbx(
    ["exec", "-i", name, "sh", "-c", "mkdir -p ~/.local/bin && cat > ~/.local/bin/tet-ctl && chmod +x ~/.local/bin/tet-ctl"],
    { stdin: `#!/usr/bin/env node\n${bundle}` }
  );
  if (written.ok) {
    launcherWritten.add(name);
  }
}

/**
 * Readies one agent tab's sandbox and returns the full `sbx run` argument list for it —
 * workspaces (see computeWorkspaces, whose `missing` is passed on for the caller to say),
 * published ports, and (when network policy allows it, see ensureControlNetworkAllowed) the
 * control-channel env and `tet-ctl` launcher. Creates the sandbox first if it is missing
 * (ensureSandboxExists) — `sbx run` would too, but the launcher has to be written into it
 * before `sbx run` starts the agent.
 */
export async function prepareSbxRun(
  agentId: SbxAgentId,
  projectPath: string,
  config: SbxProjectConfig,
  name: string,
  fixed: SbxFixedPaths,
  agentArgs: string[]
): Promise<{ args: string[]; missing: string[] }> {
  const { workspaces, missing } = computeWorkspaces(projectPath, config.folders, fixed);
  await ensureSandboxExists(agentId, workspaces, name);
  const args = ["run", agentId, ...workspaces, "--name", name];
  for (const port of config.ports) {
    args.push("-p", `${port.host}:${port.container}`);
  }
  args.push("-e", `${CONFIG_DIR_ENV[agentId]}=${toContainerPath(fixed.configDir)}`);
  if (await ensureControlNetworkAllowed()) {
    args.push(
      "-e",
      CONTROL_ENV.port,
      "-e",
      CONTROL_ENV.token,
      "-e",
      CONTROL_ENV.projectId,
      "-e",
      CONTROL_ENV.tabId,
      "-e",
      `${CONTROL_ENV.host}=host.docker.internal`
    );
    // Best-effort: the launcher missing is no worse than today (no tet-ctl in the sandbox at
    // all), so a failure here must not block the agent itself from starting.
    await ensureSandboxLauncher(name);
  }
  args.push("--", ...agentArgs);
  return { args, missing };
}

/**
 * The dialog's Save button: writes tet.json (ports/folders, never a token — see SbxSaveRequest),
 * removes every existing sandbox of the project whose folders no longer match when sandboxing is
 * on — sbx refuses to change an existing sandbox's workspaces (see computeWorkspaces), so the
 * next tab of that agent creates it afresh; only the sandbox's own container state (installed
 * packages, running processes) is lost, the project and the allowed folders are bind mounts —
 * and stores every non-blank token as that agent's global service secret. Returns which agents'
 * sandboxes were removed, for the caller to say so: a session of that agent still running in a
 * tab just lost its sandbox under it, at the one moment the user changed the folders. `getPaths`
 * is session-manager.ts's own `sandboxPaths`, handed in rather than imported so sbx.ts never
 * reaches into the terminal layer's state directly.
 */
export async function saveSbxConfig(
  projectPath: string,
  projectId: string,
  request: SbxSaveRequest,
  getPaths: (agentId: SbxAgentId) => SbxFixedPaths
): Promise<SbxAgentId[]> {
  const { tokens, ...config } = request;
  config.folders = config.folders.map((folder) => ({ ...folder, path: contractHome(folder.path) }));
  await writeSbxConfig(projectPath, config);
  const removed: SbxAgentId[] = [];
  for (const agentId of SBX_AGENT_IDS) {
    const name = sandboxName(projectId, agentId);
    if (config.enabled) {
      const existing = await getSandboxWorkspaces(name);
      if (existing !== undefined && !sameWorkspaceSet(existing, computeWorkspaces(projectPath, config.folders, getPaths(agentId)).workspaces)) {
        await runSbx(["rm", name, "--force"]);
        launcherWritten.delete(name);
        removed.push(agentId);
      }
    }
    if (tokens[agentId].trim()) {
      await runSbx(["secret", "set", SANDBOX_SERVICE[agentId]], { stdin: `${tokens[agentId]}\n` });
    }
  }
  return removed;
}
