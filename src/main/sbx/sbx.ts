import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { CONTROL_ENV } from "../../shared/ctl";
import {
  SBX_SKILLS_KINDS,
  SBX_PROBLEM,
  addProblems,
  forbiddenBy,
  isPort,
  mergeProblems,
  sameMcpUrl,
  sbxPortKey,
  withoutProblems,
} from "../../shared/sbx-rules";
import { refKeyOf } from "../../shared/types/project";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type { SbxAccess, SbxSkillsSettings, SbxOption, SbxPort, SbxProblems, SbxProjectSettings, SbxSecret } from "../../shared/types/sbx";
import { SANDBOXED_AGENTS } from "../agents";
import { canBind } from "../util/can-bind";
import { inTurn } from "../util/async";
import type { SandboxedAgent } from "../agents/agent";
import { parseSbxJson, type FilesystemRule } from "./sbx-policy";
import { logError } from "../util/error-log";
import { runSbx, sbxError, sbxFailure, sbxJson, sbxRefusal, suppressSbxFirstRunWizard, writeIntoSandbox, type OnData } from "./sbx-cli";
import { listMcp, loadMcp, mcpNamesOf, planMcp, readRegisteredMcp, unloadMcp, type ListedMcp, type McpPlan } from "./sbx-mcp";
import { listSandboxes, mountableBy, readHostAllowed, readPolicy, sandboxControl, type SandboxList } from "./sbx-status";
import { normalizeHostPath } from "../util/path-inside";
import { sameSet } from "../util/same-set";
import { readSbxSettings } from "../store/tet-json";
import {
  droppedMountSpecs,
  fixedMountSpecs,
  grantsOf,
  mountAll,
  sandboxSkillsFor,
  sessionMountSpecs,
  worktreeMountSpecs,
  type SandboxPaths,
  type SbxSessionMount,
} from "./sbx-mounts";

/**
 * Stable per (repository or worktree, agent) so `sbx run --name` reattaches: a worktree's workspace
 * is its own, fixed at `sbx create`. Hashed: `sbx create --name` allows only letters, numbers,
 * hyphens and periods.
 */
export function sandboxName(ref: ProjectRef, agentId: AgentId): string {
  return `tet-${agentId}-${idHash(refKeyOf(ref))}`;
}

/** An id's share of a sandbox name (a repository's or worktree's) and of a secret placeholder (a
 *  project's); the setup script's mark in its sandbox (runSetup). */
function idHash(id: string): string {
  return crypto.createHash("sha1").update(id).digest("hex").slice(0, 12);
}

/** Sandboxes given the `tet-ctl` launcher this run; cleared in removeSandbox. */
const launcherWritten = new Set<string>();

/** The `sbx create` (or rebuild) or setup script underway per sandbox name — see
 *  ensureSandboxExists and runSetup. */
const sandboxSetups = new Map<string, Promise<unknown>>();

/** What alignSandbox and applyProjectPorts bring a sandbox to: tet.json's rows a running sandbox
 *  takes at once. */
type Aligned = Pick<SbxProjectSettings, "hosts" | "ports" | "secrets" | "mcp">;

/** Whether `a` and `b` hold the same rows a tab's start brings its sandbox to: what tells a Save
 *  that replaced them while the start ran (prepareSbxRun's `savedOver`). */
function sameAligned(a: Aligned, b: Aligned): boolean {
  const rows = ({ hosts, ports, secrets, mcp }: Aligned): string =>
    JSON.stringify([
      hosts,
      ports.map(sbxPortKey),
      secrets.map((secret) => [secret.env, secret.hosts]),
      mcp.map((server) => [server.name, server.url]),
    ]);
  return rows(a) === rows(b);
}

/**
 * Runs `action` holding the turn of every sandbox named (`sandboxSetups`), which a tab's start
 * takes to bring its own in line: a Save's rows and a start's never reach one sandbox interleaved.
 * Taken in one order, so two holders of several never wait on each other.
 */
export function inSandboxTurns<T>(names: readonly string[], action: () => Promise<T>): Promise<T> {
  const held = [...names].sort().reduceRight((inner, name) => () => inTurn(sandboxSetups, name, inner), action);
  return held();
}

export async function removeSandbox(name: string, onData?: OnData): Promise<boolean> {
  launcherWritten.delete(name);
  return (await runSbx(["rm", name, "--force"], { onData })).ok;
}

/**
 * The sandboxes of repositories and worktrees going away — a deleted worktree, a removed project:
 * their workspace is gone or no longer TET's. Nothing when sbx cannot list them.
 */
export async function removeRefSandboxes(refs: ProjectRef[]): Promise<void> {
  const sandboxes = await listSandboxes();
  for (const ref of refs) {
    for (const { id: agentId } of SANDBOXED_AGENTS) {
      const name = sandboxName(ref, agentId);
      if (sandboxes?.has(name)) {
        await removeSandbox(name);
      }
    }
  }
}

/**
 * Ensures a sandbox whose one workspace is this repository or worktree — all else is mounted live,
 * so this is all `sbx create` is told. A different workspace means a rebuild: a repository moved
 * under the same id (`sandboxName` hashes the repository's or worktree's `refKey`, and `tet.id` travels
 * with the repository). Nothing open can be attached to such a sandbox, so it is removed outright.
 * Returns whether it created one, which no start underway answers for (prepareSbxRun's `warm`).
 *
 * `--skills=off`: sbx otherwise binds its own skills store read-only at the agent's skills
 * directory (`~/.claude/skills`), the very target of TET's skills mount, which would stack over
 * the store and leave it showing once unmounted. Create-time, so a sandbox keeps what it was made
 * with.
 *
 * A failed `create` is not best-effort: `sbx run --name` would create the sandbox without the
 * workspace, and the agent would start in an empty directory unannounced. Rejects, leaving the tab
 * in error; sbx's message reached it via `onData`.
 *
 * One setup per sandbox (`sandboxSetups`), listing again first: two tabs starting together both
 * find it missing, and a second `create` fails with "already exists" — or, rebuilding, removes the
 * one just made.
 */
function ensureSandboxExists(
  agent: SandboxedAgent,
  folder: string,
  name: string,
  sandboxes: SandboxList,
  onData?: OnData,
): Promise<boolean> {
  const listed = sandboxes.get(name);
  if (listed !== undefined && sameSet(listed.workspaces, [folder])) {
    return Promise.resolve(false);
  }
  return inTurn(sandboxSetups, name, async () => {
    const existing = ((await listSandboxes()) ?? sandboxes).get(name);
    if (existing !== undefined && sameSet(existing.workspaces, [folder])) {
      return false;
    }
    if (existing !== undefined) {
      await removeSandbox(name, onData);
    }
    const created = await runSbx(["create", agent.sandbox.kit ?? agent.id, folder, "--name", name, "--skills=off"], { onData });
    if (!created.ok) {
      throw new Error(`sbx could not create the ${agent.id} sandbox: ${sbxFailure(created, "sbx create")}`);
    }
    // A new sandbox holds nothing of the one that had this name — and one removed outside TET
    // (`sbx rm`, `prune`, `reset`) never passed removeSandbox, which is the other place this is
    // forgotten. Kept here, the launcher would be skipped and the agent would run without hooks.
    launcherWritten.delete(name);
    return true;
  });
}

/**
 * Writes `tet-ctl` into the sandbox's `~/.local/bin` — first on every template's PATH and writable
 * by the "agent" user, unlike `/usr/local/bin`. Not a mounted launcher: `sbx run -e PATH=...`
 * replaces PATH, never prepends. The bundle is piped in behind a `#!/usr/bin/env node` shebang;
 * every template has node. Runs after ensureSandboxExists.
 */
async function ensureSandboxLauncher(name: string, onData?: OnData): Promise<void> {
  const control = sandboxControl();
  if (!control || launcherWritten.has(name)) {
    return;
  }
  const bundle = await fs.readFile(control.cliPath, "utf8").catch((error: unknown) => {
    logError(`could not read tet-ctl for the ${name} sandbox`, error);
    return undefined;
  });
  if (bundle === undefined) {
    return;
  }
  const written = await writeIntoSandbox(name, "~/.local/bin/tet-ctl", `#!/usr/bin/env node\n${bundle}`, { executable: true, onData });
  if (written.ok) {
    launcherWritten.add(name);
  } else {
    sbxFailure(written, `writing tet-ctl into the ${name} sandbox`);
  }
}

/** The idHash of the setup script that last ran to its end in a sandbox: in its own filesystem, not
 *  a mount, so it goes with the sandbox, as does what the script installed. */
const SETUP_DONE = "/var/lib/tet/setup";

/**
 * Runs the setup script by `sh -e` as root, unless SETUP_DONE holds its hash already, and records
 * it once it ran to its end. A script that fails is not recorded, to be tried at the next start,
 * and comes back as the line it last printed to stderr, for the start's notice. What an earlier
 * version did is not undone: the sandbox keeps it until it is created anew. One turn per sandbox
 * (`sandboxSetups`): two tabs starting together would both run it. Script and hash go in as
 * arguments, so nothing of them is quoted into the command line. `DEBIAN_FRONTEND=noninteractive`:
 * there is no terminal to answer a package's question (tzdata's), so apt takes the defaults.
 */
async function runSetup(name: string, lines: readonly string[], onData?: OnData): Promise<Record<string, string>> {
  if (lines.length === 0) {
    return {};
  }
  const script = lines.join("\n");
  const ran = await inTurn(sandboxSetups, name, () =>
    runSbx(
      [
        "exec",
        "-u",
        "root",
        "-e",
        "DEBIAN_FRONTEND=noninteractive",
        name,
        "sh",
        "-c",
        `[ "$(cat ${SETUP_DONE} 2>/dev/null)" = "$2" ] || { sh -e -c "$1" && mkdir -p "$(dirname ${SETUP_DONE})" && echo "$2" > ${SETUP_DONE}; }`,
        "tet-setup",
        script,
        idHash(script),
      ],
      { onData },
    ),
  );
  return ran.ok ? {} : { [sbxError(ran) || `exit ${ran.code ?? "none"}`]: SBX_PROBLEM.failed };
}

/**
 * Each sandbox's Allowed hosts as sbx has them, what alignSandbox brings in line with tet.json,
 * from one `policy ls`. A rule counts when an allow scoped `sandbox:<name>` and editable, as
 * `sbx policy allow network --sandbox` makes it; a kit's rule is not editable, a global one is the
 * machine's. One rule per resource, so the list is their union. Inactive rules count too:
 * governance hides them by default, and a Save without governance would then add them a second
 * time. Undefined when sbx does not answer: read as none, a host dropped as a row would stay
 * allowed.
 */
export async function readSandboxHosts(): Promise<Map<string, string[]> | undefined> {
  const parsed = await sbxJson<{ rules?: { scope?: string; decision?: string; editable?: boolean; resources?: string[] }[] }>([
    "policy",
    "ls",
    "--type",
    "network",
    "--include-inactive",
    "--json",
  ]);
  if (!parsed) {
    return undefined;
  }
  const hosts = new Map<string, string[]>();
  for (const rule of parsed.rules ?? []) {
    if (rule.decision !== "allow" || !rule.editable || !rule.scope?.startsWith("sandbox:")) {
      continue;
    }
    const name = rule.scope.slice("sandbox:".length);
    hosts.set(name, [...(hosts.get(name) ?? []), ...(rule.resources ?? [])]);
  }
  return hosts;
}

/**
 * Removes dropped hosts, ending the allowance *now* (as revokeMounts). One `rm` per host: the
 * comma-list form removes nothing if any entry is missing, and one removed by hand answers "rule
 * not found", exit 1, while the others still go. `--force`: `rm` asks first, which a closed stdin
 * (runSbx) would fail.
 */
async function revokeStaleHosts(name: string, previous: string[], current: string[], onData?: OnData): Promise<void> {
  for (const host of previous.filter((old) => !current.includes(old))) {
    await runSbx(["policy", "rm", "network", "--sandbox", name, "--resource", host, "--force"], { onData });
  }
}

/**
 * Allows the project's hosts scoped to this sandbox (`--sandbox`, as kits scope theirs). A policy
 * rule lives in sbx's policy store, not the sandbox:
 * - the sandbox must *exist* but need not run, so no ensureRunning; alignSandbox's callers know
 *   it exists.
 * - the rule survives a stop and dies with `sbx rm`; alignSandbox works against the sandbox's own
 *   (readSandboxHosts), a rule set by hand included.
 * - RESOURCES is comma-separated, one process, idempotent per scope. A host allowed globally still
 *   gets its entry, so the list equals the dialog's.
 * - a change reaches a *running* sandbox at once.
 * - on a governed account every local `policy allow` fails, so it is never asked there
 *   (readSbxProblems asks the organization's policy instead).
 * sbx refuses a URL or a space inside a name, which lands in `refused` like any refusal. Returns
 * what sbx refused, by host: the list in one go, and one by one only once that failed, to tell
 * which.
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
 * What the sandbox has published, what applyProjectPorts brings in line (as readSandboxHosts is
 * for hosts): a port sbx refused the last time is missing here and is tried again. A *stopped*
 * sandbox answers none though its ports survive the stop, so only a running one's count. `--json` is an array of `{host_ip, host_port, sandbox_port, protocol}`. Undefined when sbx
 * cannot say.
 */
export async function readSandboxPorts(name: string): Promise<SbxPort[] | undefined> {
  const listed = await runSbx(["ports", name, "--json"]);
  return listed.ok ? parsePublishedPorts(listed.stdout) : undefined;
}

/** Unreadable reads as none published: every configured port is then tried, and re-publishing one
 *  the sandbox has only answers "already published". */
export function parsePublishedPorts(stdout: string): SbxPort[] {
  try {
    const listed = parseSbxJson(stdout) as { host_port?: number; sandbox_port?: number }[];
    return listed
      .filter((entry) => typeof entry?.host_port === "number" && typeof entry.sandbox_port === "number")
      .map((entry) => ({ host: String(entry.host_port), container: String(entry.sandbox_port) }));
  } catch {
    return [];
  }
}

/**
 * Publishes and unpublishes the ports given: only what the sandbox does not have as asked, since
 * re-publishing errors ("already published") — applyProjectPorts works that out. Returns what sbx
 * refused, by `host:container`, with its last line (sbx's `ERROR: …`). Publishing starts a stopped
 * sandbox; `--unpublish` does not, and succeeds for a port never published.
 */
async function applyPortChanges(
  name: string,
  delta: { removed: SbxPort[]; added: SbxPort[] },
  onData?: OnData,
): Promise<Record<string, string>> {
  const changes = [
    ...delta.removed.map((port) => ["--unpublish", sbxPortKey(port)]),
    ...delta.added.map((port) => ["--publish", sbxPortKey(port)]),
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
 * The placeholder a project's secret goes by in its sandboxes: fixed by TET (`--placeholder`), not
 * sbx's random one, so it outlives a changed value and a rebuild, and `sbx run -e` can name it
 * without asking sbx. The prefix tells TET's secrets from ones set in the sandbox's scope by hand.
 */
export function secretPlaceholder(projectId: string, env: string): string {
  return `${secretPrefix(projectId)}${env}`;
}

function secretPrefix(projectId: string): string {
  return `tet-${idHash(projectId)}-`;
}

/** A custom secret as `sbx secret ls --json` lists it. */
export interface LiveSecret {
  placeholder: string;
  hosts: string[];
}

/**
 * Brings a sandbox's custom secrets in line with the rows that have a value here. Scoped to the
 * sandbox (`--sandbox`), as its hosts are.
 * - the proxy swaps the placeholder for the value in any request header to a listed host, Basic
 *   auth's base64 included (so git over HTTPS works), never in the URL or body, never for another
 *   host; the swap reaches a *running* sandbox at once.
 * - sbx sets `--env` in the sandbox only at `sbx create`, so TET leaves it out and passes the
 *   placeholder itself with `sbx run -e` (prepareSbxRun), which reaches an existing sandbox too.
 * - `sbx rm` removes the sandbox's secrets with it, and sbx never gives a value back: a new sandbox
 *   is seeded from this machine's store (sbx-local.ts).
 * - no update: a second secret for one placeholder or env fails ("already exists"), so a changed
 *   one is removed and set again. `rm` without `-f` asks and cancels on a closed stdin.
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
  onData?: OnData,
): Promise<Record<string, string>> {
  const wanted = secrets.filter((secret) => values.has(secret.env));
  const ours = live.filter((secret) => secret.placeholder.startsWith(secretPrefix(projectId)));
  const kept = wanted.filter(
    (secret) =>
      !changed.has(secret.env) &&
      ours.some((old) => old.placeholder === secretPlaceholder(projectId, secret.env) && sameSet(old.hosts, secret.hosts)),
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
      onData,
    });
    if (!result.ok) {
      refused[secret.env] = sbxRefusal(result);
    }
  }
  return refused;
}

/**
 * Each sandbox's custom secrets — the truth applySecrets works against, as readSandboxHosts is for
 * hosts — from one `sbx secret ls --json` (`custom_secrets`: `{scope, targets, env, placeholder,
 * secret}`, scope the sandbox's name or "global"). Never the value: sbx lists only its first
 * characters. Undefined when sbx does not answer: read as none, every secret set would fail as
 * "already exists", and a changed one would never arrive.
 */
export async function readSandboxSecrets(): Promise<Map<string, LiveSecret[]> | undefined> {
  const parsed = await sbxJson<{ custom_secrets?: { scope?: string; targets?: string[]; placeholder?: string }[] }>([
    "secret",
    "ls",
    "--json",
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
 * Brings the project's forwarded ports to `ports`, across the repository's sandboxes — a worktree's
 * forward none — for a tab's start and a Save alike. A host port is forwarded by one sandbox only,
 * another's publish of it is refused, so a port is in place once any running one has it: one it is
 * dropped from is unpublished there, a missing one published by the first of `running` that takes
 * it. Never starts one: a stopped sandbox lists no ports yet keeps them, and would not start again
 * while another holds one of them, so every port of `ports` and `dropped` is unpublished there
 * unseen — it takes its own at its next tab. With none running nothing is published, and nothing
 * refused: the next tab's start does. Returns what no sandbox took, by `host:container`, and a
 * port a running one would not unpublish.
 */
export async function applyProjectPorts(
  sandboxes: { running: string[]; stopped: string[] },
  ports: SbxPort[],
  options: { dropped?: SbxPort[]; read?: Map<string, SbxPort[]>; onData?: OnData } = {},
): Promise<Record<string, string>> {
  const { running, stopped } = sandboxes;
  const { dropped = [], read, onData } = options;
  const wanted = new Set(ports.map(sbxPortKey));
  const unseen = [...ports, ...dropped.filter((port) => !wanted.has(sbxPortKey(port)))];
  for (const name of stopped) {
    await applyPortChanges(name, { removed: unseen, added: [] });
  }
  if (running.length === 0) {
    return {};
  }
  // Unreadable as none published (parsePublishedPorts).
  const published = read
    ? running.map((name) => read.get(name) ?? [])
    : await Promise.all(running.map(async (name) => (await readSandboxPorts(name)) ?? []));
  const refused: Record<string, string> = {};
  for (const [index, name] of running.entries()) {
    Object.assign(
      refused,
      await applyPortChanges(name, { removed: published[index].filter((port) => !wanted.has(sbxPortKey(port))), added: [] }, onData),
    );
  }
  const forwarded = new Set(published.flat().map(sbxPortKey));
  // The first sandbox that takes it; sbx's last refusal otherwise.
  const publish = async (port: SbxPort): Promise<string | undefined> => {
    let reason: string = SBX_PROBLEM.notStarted;
    for (const name of running) {
      const refusal = (await applyPortChanges(name, { removed: [], added: [port] }, onData))[sbxPortKey(port)];
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

/** What bringing sandboxes in line works against, as sbx lists it (readSandboxReads), each
 *  undefined where sbx could not say. */
export interface SandboxReads {
  hosts: Map<string, string[]> | undefined;
  secrets: Map<string, LiveSecret[]> | undefined;
  mcp: ListedMcp[] | undefined;
  /** By sandbox, of those asked; undefined when one could not be listed. */
  ports: Map<string, SbxPort[]> | undefined;
}

/**
 * What a tab's start and a Save bring sandboxes in line against, in one round: each listing is an
 * sbx process, the hosts, secrets and MCP servers answer for every sandbox, and the ports for
 * `portsOf`. All are asked, needed or not, rather than waited on in turn; what a listing sbx could
 * not answer means is the caller's — a Save stops (assertReadable), a start tells its rows.
 */
export async function readSandboxReads(portsOf: readonly string[]): Promise<SandboxReads> {
  const [hosts, secrets, mcp, ports] = await Promise.all([readSandboxHosts(), readSandboxSecrets(), listMcp(), readPorts(portsOf)]);
  return { hosts, secrets, mcp, ports };
}

/** What each sandbox named has published (readSandboxPorts); undefined when one could not say. */
async function readPorts(names: readonly string[]): Promise<Map<string, SbxPort[]> | undefined> {
  const published = await Promise.all(names.map(readSandboxPorts));
  return published.includes(undefined) ? undefined : new Map(names.map((name, index) => [name, published[index] ?? []]));
}

/** The repository's sandboxes of the project sbx lists: a worktree forwards no ports
 *  (tet-json.ts's readSbxSettings), so only these do. */
function projectSandboxes(projectId: string, sandboxes: SandboxList): string[] {
  return SANDBOXED_AGENTS.map((agent) => sandboxName({ projectId }, agent.id)).filter((name) => sandboxes.has(name));
}

/** What alignSandbox brings one sandbox to. */
interface SandboxAlignment {
  projectId: string;
  settings: Pick<SbxProjectSettings, "hosts" | "secrets">;
  /** The organization managing sbx's policy: no local host rule applies under one (allowHosts). */
  organization: string | undefined;
  secretValues: ReadonlyMap<string, string>;
  /** The env names whose value was just replaced (applySecrets). */
  changedSecrets: ReadonlySet<string>;
  live: SandboxReads;
  /** Only for a running sandbox (loadMcp). With `told`, only a server in it that sbx would not
   *  unload is refused: a Save leaves a refused row out of tet.json, and any other never was one. */
  mcp?: Pick<McpPlan, "load" | "unload"> & { told?: ReadonlySet<string> };
}

/**
 * Brings one sandbox's hosts, secrets and MCP servers in line with tet.json's rows, both ways and
 * against the sandbox's own (`live`), so a rule set by hand and deleted as a row goes too: the one
 * way they reach a sandbox, at its tab's start (prepareSbxRun) and at a Save (saveSbxSettings).
 * Hosts and secrets live in sbx's stores, so a stopped sandbox takes them; MCP servers and the
 * ports (applyProjectPorts) need it running. Returns what sbx refused, or could not list.
 */
export async function alignSandbox(name: string, to: SandboxAlignment, onData?: OnData): Promise<SbxProblems> {
  const { settings, live, mcp } = to;
  const refused: SbxProblems = {};
  if (!to.organization) {
    const held = live.hosts?.get(name) ?? [];
    const missing = settings.hosts.filter((host) => !held.includes(host));
    if (live.hosts) {
      await revokeStaleHosts(name, held, settings.hosts, onData);
    }
    addProblems(
      refused,
      "hosts",
      live.hosts ? await allowHosts(name, missing, onData) : Object.fromEntries(missing.map((host) => [host, SBX_PROBLEM.hostsUnlisted])),
    );
  }
  addProblems(
    refused,
    "secrets",
    live.secrets
      ? await applySecrets(name, to.projectId, settings.secrets, to.secretValues, live.secrets.get(name) ?? [], to.changedSecrets, onData)
      : Object.fromEntries(settings.secrets.map((secret) => [secret.env, SBX_PROBLEM.secretsUnlisted])),
  );
  if (mcp) {
    const loaded = await loadMcp(name, mcp.load, onData);
    // Silent: a server that was never loaded answers an error, which is no news to the tab; what
    // sbx would not unload comes back as refused instead.
    const unloaded = await unloadMcp(name, mcp.unload);
    addProblems(refused, "mcp", {
      ...loaded,
      ...Object.fromEntries(Object.entries(unloaded).filter(([server]) => mcp.told?.has(server) ?? true)),
    });
  }
  return refused;
}

interface SbxRunRequest {
  agent: SandboxedAgent;
  /** Its sandbox's name (SandboxPlace.name). */
  name: string;
  /** The repository or worktree the tab runs in; its sandbox is its own, its SBX settings the
   *  project's. */
  ref: ProjectRef;
  projectRefPath: string;
  settings: SbxProjectSettings;
  /** This machine's skills for the project (SbxLocalStore.skills). */
  skills: SbxSkillsSettings;
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
  /** `AgentSandbox.env` — "KEY=VALUE" entries for `sbx run -e`. */
  env?: string[];
  /** This machine's values of `settings.secrets`, by env name (SbxLocalStore.values). */
  secretValues: ReadonlyMap<string, string>;
  /** This machine's values of `settings.variables`, likewise. */
  variableValues: ReadonlyMap<string, string>;
  /** Where this agent's sessions land on the host; created if missing, rw, re-applied per spawn. */
  sessionMounts?: SbxSessionMount[];
  /** Setup output, forwarded live to the tab (see `RunOptions.onData`). */
  onData?: OnData;
}

/**
 * A sandboxed tab's variables for `sbx run -e`: the agent's own and each secret's placeholder as
 * `NAME=value` (`env`), each variable only by name (`passed`, its value for the environment the
 * caller spawns `sbx run` with, as the control channel's are), since the process list shows a
 * command line and a variable's value is real. A variable a name of TET's own or a secret already
 * holds is left out — tet.json and the dialog refuse one, a hand-edited file may not — as is a
 * secret or variable without a value on this machine (a problem, readSbxProblems).
 */
export function sandboxEnv({
  ref,
  settings,
  env: agentEnv = [],
  secretValues,
  variableValues,
}: Pick<SbxRunRequest, "ref" | "settings" | "env" | "secretValues" | "variableValues">): {
  env: string[];
  passed: Record<string, string>;
} {
  const secrets = settings.secrets.filter((secret) => secretValues.has(secret.env));
  const taken = new Set([
    ...agentEnv.map((entry) => entry.slice(0, entry.indexOf("="))),
    ...Object.values(CONTROL_ENV),
    ...settings.secrets.map((secret) => secret.env),
  ]);
  const passed: Record<string, string> = {};
  for (const { env: name } of settings.variables.filter((variable) => !taken.has(variable.env))) {
    const value = variableValues.get(name);
    if (value !== undefined) {
      passed[name] = value;
    }
  }
  return {
    env: [...agentEnv, ...secrets.map((secret) => `${secret.env}=${secretPlaceholder(ref.projectId, secret.env)}`)],
    passed,
  };
}

/**
 * Readies a tab's sandbox and returns the `sbx run` arguments: TET's mounts, skills and Allowed
 * paths, ports, secrets and variables (sandboxEnv: `env` for the caller to spawn `sbx run` with),
 * and with a control channel its env and the `tet-ctl` launcher. Creates the sandbox itself
 * (ensureSandboxExists), since the launcher must be written before `sbx run` starts the agent, and
 * `sbx create` is told its workspace alone: every start, the creating one too, brings the sandbox
 * in line with tet.json the same way, each time: the mounts (mountAll), hosts, ports, secrets and
 * MCP servers (alignAtStart), against what sbx lists (readSandboxReads).
 * Applies tet.json as it stands and never writes it: what cannot be applied here
 * (readSbxProblems), or what sbx refuses, is skipped and returned as `problems` for the caller to
 * tell (sbxProblemNotices) — how a user learns that governance took over. `savedOver` says a Save
 * replaced tet.json's rows while this start ran, which then applied none of its own. Rejects when
 * creating fails, sbx cannot say what applies (readSbxProblems) or a folder of TET's own cannot be
 * mounted.
 */
export async function prepareSbxRun(
  request: SbxRunRequest,
): Promise<{ args: string[]; env: Record<string, string>; problems: SbxProblems; savedOver: boolean }> {
  const { agent, name, onData, secretValues, variableValues } = request;
  const { projectId } = request.ref;
  const created = await ensureSandboxExists(agent, request.projectRefPath, name, request.sandboxes, onData);
  // One turn per sandbox, which a Save holds too (inSandboxTurns): what is read is what is applied,
  // with no Save or other start of the sandbox in between — two tabs starting together would both
  // apply, the second against what the first changed.
  const { problems, settings, savedOver } = await inTurn(sandboxSetups, name, async () => {
    // Saved over since this start read it: its rows are tet.json's no more, and applying them would
    // take back what that Save set. Left to the next start, and told.
    const savedOver = !sameAligned(await readSbxSettings(request.projectRefPath), request.settings);
    // The start underway decides what the sandbox lists as published (readSandboxPorts): only once
    // it ran are the ports read the ones alignAtStart works against.
    const warmed = created || (!savedOver && (await request.warm) === true);
    // The repository's sandboxes, ports configured or not: one may still publish a port dropped since.
    const forwarding = request.ref.worktree === undefined ? projectSandboxes(projectId, request.sandboxes) : [];
    const reads = savedOver ? undefined : await readSandboxReads(forwarding);
    const ports = request.settings.ports.length > 0;
    const problems = await readSbxProblems({
      projectId,
      settings: request.settings,
      skills: request.skills,
      values: { secrets: new Set(secretValues.keys()), variables: new Set(variableValues.keys()) },
      agents: [agent],
      organization: request.organization,
      rules: request.rules,
      ports: !savedOver,
      // A port a sandbox of the project forwards is in place already (applyProjectPorts).
      published: portKeys(reads && ports ? portsListed(reads.ports) : undefined),
      listedMcp: reads?.mcp,
    });
    const { settings, skills } = withoutProblems(request.settings, request.skills, problems);
    // TET's own folders are not skipped: without them the agent has no hook settings or listable
    // sessions, silently. Everything else is in place by here, so a refusal is sbx's policy, and the
    // tab stops with sbx's reason in its output.
    const own = [
      ...fixedMountSpecs(request.paths),
      ...worktreeMountSpecs(request.projectRefPath),
      ...(await sessionMountSpecs(request.sessionMounts ?? [])),
    ];
    const grants = await grantsOf(agent, skills, settings.paths);
    // A dropped path sbx refuses now is left out without a word: its drop said it was mounted.
    const refused = await mountAll(name, [...own, ...grants, ...droppedMountSpecs(name)], onData, created ? undefined : request.warm);
    const ownFailed = own.filter((spec) => refused.has(spec.mount)).map((spec) => spec.mount);
    if (ownFailed.length > 0) {
      throw new Error(
        `sbx did not mount TET's own ${ownFailed.length === 1 ? "folder" : "folders"} ${ownFailed.join(", ")} — see the tab's output`,
      );
    }
    for (const grant of grants) {
      const reason = refused.get(grant.mount);
      if (reason !== undefined) {
        addProblems(problems, grant.option, { [grant.row]: reason });
      }
    }
    if (reads) {
      mergeProblems(problems, await alignAtStart(request, settings, reads, warmed));
    }
    return { problems, settings, savedOver };
  });
  const { env, passed } = sandboxEnv({ ...request, settings });
  addProblems(problems, "setup", await runSetup(name, settings.setup, onData));
  // No workspace positionals, not even right after creating: the sandbox always exists by now, and
  // sbx run refuses them on an existing one even when unchanged. No agent positional either: sbx
  // reads it from the sandbox `--name` finds, and refuses one that differs from it — a kit's own
  // name (AgentSandbox.kit) is not the agent's id.
  const args = [
    "run",
    "--name",
    name,
    ...env.flatMap((entry) => ["-e", entry]),
    ...Object.keys(passed).flatMap((variable) => ["-e", variable]),
  ];
  if (sandboxControl()) {
    // The tab id too: a hook reports for the tab it runs in (TabSessionManager.hookEvent).
    const passThrough = [CONTROL_ENV.port, CONTROL_ENV.token, CONTROL_ENV.projectId, CONTROL_ENV.tabId];
    const worktree = request.ref.worktree === undefined ? [] : ["-e", `${CONTROL_ENV.worktree}=${request.ref.worktree}`];
    args.push(...passThrough.flatMap((variable) => ["-e", variable]), ...worktree, "-e", `${CONTROL_ENV.host}=host.docker.internal`);
    // Best-effort: a missing launcher must not keep the agent from starting.
    await ensureSandboxLauncher(name, onData);
  }
  args.push("--", ...request.agentArgs);
  await suppressSbxFirstRunWizard();
  return { args, env: passed, problems, savedOver };
}

/**
 * A start's share of bringing its sandbox in line, the sandbox running by now (mountAll): hosts,
 * secrets and MCP servers (alignSandbox), and from the repository's sandbox the project's ports
 * (applyProjectPorts), this one first to take a missing one — all against what the start read
 * (readSandboxReads); the ports only where the sandbox ran when they were read (`warmed`), since a
 * stopped one lists none. Not `sbx run -p` for the ports: `run --name` drops `-p` on an existing
 * sandbox.
 */
async function alignAtStart(
  request: SbxRunRequest,
  settings: SbxProjectSettings,
  reads: SandboxReads,
  warmed: boolean,
): Promise<SbxProblems> {
  const { name, onData, organization } = request;
  const { projectId } = request.ref;
  const plan = await planMcp(settings.mcp, reads.mcp && mcpNamesOf(reads.mcp), onData);
  const refused = await alignSandbox(
    name,
    {
      projectId,
      settings,
      organization,
      secretValues: request.secretValues,
      changedSecrets: new Set(),
      live: reads,
      mcp: { load: plan.load, unload: plan.unload },
    },
    onData,
  );
  addProblems(refused, "mcp", plan.refused);
  if (request.ref.worktree === undefined) {
    const others = projectSandboxes(projectId, request.sandboxes).filter((other) => other !== name);
    const running = [name, ...others.filter((other) => request.sandboxes.get(other)?.running)];
    const stopped = others.filter((other) => !running.includes(other));
    const read = warmed ? reads.ports : undefined;
    addProblems(refused, "ports", await applyProjectPorts({ running, stopped }, settings.ports, { read, onData }));
  }
  return refused;
}

/** readProjectPorts' as the keys readSbxProblems checks against; none where it was not read. */
function portKeys(published: Map<string, SbxPort[]> | undefined): Set<string> {
  return new Set([...(published?.values() ?? [])].flat().map(sbxPortKey));
}

/** The ports the project's sandboxes publish, by sandbox — a stopped one lists none, and binds
 *  none. Rejects when sbx cannot say: read as none, a port a sandbox holds would read as in use here. */
async function readProjectPorts(projectId: string, listed?: SandboxList): Promise<Map<string, SbxPort[]>> {
  const sandboxes = listed ?? (await listSandboxes());
  if (!sandboxes) {
    throw new Error("SBX could not list the sandboxes.");
  }
  return portsListed(await readPorts(projectSandboxes(projectId, sandboxes)));
}

/** The ports read, or a rejection where sbx could not list them (readProjectPorts). */
function portsListed(ports: Map<string, SbxPort[]> | undefined): Map<string, SbxPort[]> {
  if (!ports) {
    throw new Error("SBX could not list the sandboxes' ports.");
  }
  return ports;
}

/** What readSbxProblems checks: the rows, and what this machine holds for them. */
interface SbxCheck {
  projectId: string;
  settings: SbxProjectSettings;
  skills: SbxSkillsSettings;
  /** The env names holding a value here: stored, or typed at this Save. */
  values: { secrets: ReadonlySet<string>; variables: ReadonlySet<string> };
  /** Whose skills is mounted: every agent at Save, the starting one at its spawn. */
  agents: readonly SandboxedAgent[];
  /** readPolicy's. */
  organization: string | undefined;
  /** readPolicy's rules, when the caller has them already. */
  rules?: FilesystemRule[];
  /** Whether the ports and MCP servers are applied now: at Save, and at a spawn bringing its
   *  sandbox in line (prepareSbxRun). */
  ports: boolean;
  /** readProjectPorts', when the caller has it already. */
  published?: ReadonlySet<string>;
  /** listMcp's, when the caller has it already. */
  listedMcp?: ListedMcp[];
  /** listSandboxes', when the caller has it already. */
  sandboxes?: SandboxList;
}

/**
 * Every row of the SBX Settings that cannot be applied here, with what is wrong: one check for the
 * dialog's live marks, a Save (which saves and applies the rest, saveProjectSbx) and a sandboxed
 * session's start (which skips them and tells, prepareSbxRun). As far as it can be known before
 * applying; what sbx refuses then is a problem too.
 * - hosts: only under governance, asked of the organization's policy (readHostAllowed), as no
 *   local rule applies there (allowHosts). Without it TET adds the rule.
 * - paths and skills: must exist, and sbx's filesystem rules allow the mount with its access
 *   (sbx-policy.ts's prediction: sbx has no `policy check` for them).
 * - ports: the host port is free, unless one of the project's sandboxes holds it.
 * - secrets: a value here, and every host reachable; an Allowed host counts without governance.
 * - variables: a value here.
 * - mcp: a server sbx has registered is the row's, by its URL; one it has not needs a URL to be
 *   registered from (registerMcp). What sbx then refuses is told when it is.
 * The policy questions are sbx processes, asked together. Rejects where sbx cannot say: a row it
 * could not be asked about is no refusal.
 */
export async function readSbxProblems(check: SbxCheck): Promise<SbxProblems> {
  const { settings, skills, values, organization } = check;
  const forbidden = forbiddenBy(organization);
  const problems: SbxProblems = {};
  const add = (option: SbxOption, row: string, reason: string): void => addProblems(problems, option, { [row]: reason });
  const kinds = SBX_SKILLS_KINDS.filter((kind) => skills[kind] !== false);
  const secretHosts = [...new Set(settings.secrets.flatMap((secret) => secret.hosts))];
  // A host both allowed and a secret's is asked once.
  const asked = new Map<string, Promise<boolean>>();
  const allowed = (host: string): Promise<boolean> => {
    const pending = asked.get(host) ?? readHostAllowed(host);
    asked.set(host, pending);
    return pending;
  };
  const reachable = async (host: string): Promise<boolean> => (!organization && settings.hosts.includes(host)) || (await allowed(host));
  const [rules, hostsAllowed, secretHostsAllowed, published, own] = await Promise.all([
    settings.paths.length > 0 || kinds.length > 0 ? (check.rules ?? readPolicy().then((policy) => policy?.rules)) : Promise.resolve([]),
    organization ? Promise.all(settings.hosts.map(allowed)) : Promise.resolve(settings.hosts.map(() => true)),
    Promise.all(secretHosts.map(reachable)),
    check.published ??
      (check.ports && settings.ports.length > 0 ? readProjectPorts(check.projectId, check.sandboxes).then(portKeys) : new Set<string>()),
    Promise.all(check.agents.map((agent) => sandboxSkillsFor(agent, skills.skillsFolder))),
  ]);
  if (rules === undefined) {
    throw new Error("SBX could not list its filesystem rules.");
  }
  const mountable = mountableBy(rules);

  for (const kind of kinds) {
    const access = skills[kind] as SbxAccess;
    if (kind === "skills" && skills.skillsFolder !== undefined && !existsSync(skills.skillsFolder)) {
      add("skills", kind, SBX_PROBLEM.missing);
    } else if (own.some((entries) => entries[kind].some((entry) => !mountable(entry.host, access)))) {
      add("skills", kind, forbidden);
    }
  }
  if (check.ports) {
    const free = await Promise.all(
      settings.ports.map(async (port) => !isPort(port.host) || published.has(sbxPortKey(port)) || canBind(Number(port.host))),
    );
    settings.ports.forEach((port, index) => free[index] || add("ports", sbxPortKey(port), SBX_PROBLEM.portInUse));
  }
  for (const entry of settings.paths) {
    if (!existsSync(normalizeHostPath(entry.path))) {
      add("paths", entry.path, SBX_PROBLEM.missing);
    } else if (!mountable(entry.path, entry.access)) {
      add("paths", entry.path, forbidden);
    }
  }
  settings.hosts.forEach((host, index) => hostsAllowed[index] || add("hosts", host, forbidden));
  for (const secret of settings.secrets) {
    if (!values.secrets.has(secret.env)) {
      add("secrets", secret.env, SBX_PROBLEM.noValue);
    } else if (secret.hosts.some((host) => !secretHostsAllowed[secretHosts.indexOf(host)])) {
      add("secrets", secret.env, forbidden);
    }
  }
  for (const variable of settings.variables) {
    if (!values.variables.has(variable.env)) {
      add("variables", variable.env, SBX_PROBLEM.noValue);
    }
  }
  if (check.ports && settings.mcp.length > 0) {
    const registered = await readRegisteredMcp(
      settings.mcp.map((server) => server.name),
      check.listedMcp,
    );
    if (registered === undefined) {
      throw new Error("SBX could not list its registered MCP servers.");
    }
    for (const server of settings.mcp) {
      const known = registered.find((entry) => entry.name === server.name);
      if (known === undefined && !server.url) {
        add("mcp", server.name, SBX_PROBLEM.mcpUnregistered);
      } else if (known?.url && server.url && !sameMcpUrl(known.url, server.url)) {
        add("mcp", server.name, SBX_PROBLEM.mcpOtherUrl);
      }
    }
  }
  return problems;
}
