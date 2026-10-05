import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { CONTROL_ENV } from "../../shared/control";
import {
  SBX_KNOWLEDGE_KINDS,
  SBX_PROBLEM,
  addProblems,
  forbiddenBy,
  isPort,
  sbxPortKey,
  withoutProblems
} from "../../shared/sbx-rules";
import { refKeyOf } from "../../shared/types/project";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type { SbxAccess, SbxKnowledgeSettings, SbxOption, SbxPort, SbxProblems, SbxProjectSettings, SbxSecret } from "../../shared/types/sbx";
import { SANDBOXED_AGENTS } from "../agents";
import { canBind } from "../util/can-bind";
import { inTurn } from "../util/async";
import type { SandboxedAgent } from "../agents/agent";
import { parseSbxJson, type FilesystemRule } from "./sbx-policy";
import { logError } from "../util/error-log";
import { runSbx, sbxFailure, sbxRefusal, suppressSbxFirstRunWizard, type OnData } from "./sbx-cli";
import { listSandboxes, mountableBy, readHostAllowed, readPolicy, sandboxControl, type SandboxList } from "./sbx-status";
import { normalizeHostPath } from "../util/path-inside";
import { sameSet } from "../util/same-set";
import {
  droppedMountSpecs,
  fixedMountSpecs,
  grantsOf,
  mountAll,
  sandboxKnowledgeFor,
  sessionMountSpecs,
  worktreeMountSpecs,
  type SandboxPaths,
  type SbxSessionMount
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
 *  project's). */
function idHash(id: string): string {
  return crypto.createHash("sha1").update(id).digest("hex").slice(0, 12);
}

/** Sandboxes given the `tet-ctl` launcher this run; cleared in removeSandbox. */
const launcherWritten = new Set<string>();

/** The `sbx create` (or rebuild) underway per sandbox name — see ensureSandboxExists. */
const sandboxSetups = new Map<string, Promise<unknown>>();

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
 * Returns whether it created one, which needs seeding from tet.json (prepareSbxRun's allowHosts).
 *
 * `--skills=off`: sbx otherwise binds its own skills store read-only at the agent's skills
 * directory (`~/.claude/skills`), the very target of TET's knowledge mount, which would stack over
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
  onData?: OnData
): Promise<boolean> {
  const listed = sandboxes.get(name);
  if (listed !== undefined && sameSet(listed, [folder])) {
    return Promise.resolve(false);
  }
  return inTurn(sandboxSetups, name, async () => {
    const existing = ((await listSandboxes()) ?? sandboxes).get(name);
    if (existing !== undefined && sameSet(existing, [folder])) {
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
 * every template has node. Runs after ensureSandboxExists. Written beside it and renamed into
 * place, as every file another process reads.
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
  const written = await runSbx(
    [
      "exec", "-i", name, "sh", "-c",
      "mkdir -p ~/.local/bin && t=~/.local/bin/.tet-ctl.$$ && cat > \"$t\" && chmod +x \"$t\" && mv -f \"$t\" ~/.local/bin/tet-ctl"
    ],
    { stdin: `#!/usr/bin/env node\n${bundle}`, onData }
  );
  if (written.ok) {
    launcherWritten.add(name);
  } else {
    sbxFailure(written, `writing tet-ctl into the ${name} sandbox`);
  }
}

/**
 * Allows the project's hosts scoped to this sandbox (`--sandbox`, as kits scope theirs). A policy
 * rule lives in sbx's policy store, not the sandbox:
 * - the sandbox must *exist* but need not run, so no ensureRunning; both callers know it exists.
 * - the rule survives a stop and dies with `sbx rm`, so only a *new* sandbox is given tet.json's
 *   (prepareSbxRun); Save brings an existing one in line (saveSbxSettings), a rule set by hand
 *   included.
 * - RESOURCES is comma-separated, one process, idempotent per scope. A host allowed globally still
 *   gets its entry, so the list equals the dialog's.
 * - a change reaches a *running* sandbox at once, so saveSbxSettings applies it too.
 * - on a governed account every local `policy allow` fails, so it is never asked there
 *   (readSbxProblems asks the organization's policy instead).
 * sbx refuses a URL or a space inside a name, which lands in `refused` like any refusal. Returns
 * what sbx refused, by host: the list in one go, and one by one only once that failed, to tell
 * which.
 */
export async function allowHosts(name: string, hosts: string[], onData?: OnData): Promise<Record<string, string>> {
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
 * for hosts): a port sbx refused at the last Save is missing here and is tried again. A *stopped*
 * sandbox answers "No published ports" though its ports survive the stop, so only ask a running
 * one. `--json` is an array of `{host_ip, host_port, sandbox_port, protocol}`. Undefined when sbx
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
 * re-publishing errors ("already published") — the callers work that out (applyProjectPorts,
 * prepareSbxRun). A published port survives a stop, so this runs at Save and at a sandbox's
 * creation, not per spawn. Returns what sbx refused, by `host:container`, with its last line
 * (sbx's `ERROR: …`). Publishing starts a stopped sandbox; `--unpublish` of a port never published
 * succeeds.
 */
export async function applyPortChanges(
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
export async function applySecrets(
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

interface SbxRunRequest {
  agent: SandboxedAgent;
  /** Its sandbox's name (SandboxPlace.name). */
  name: string;
  /** The repository or worktree the tab runs in; its sandbox is its own, its SBX settings the
   *  project's. */
  ref: ProjectRef;
  projectRefPath: string;
  settings: SbxProjectSettings;
  /** This machine's knowledge for the project (SbxLocalStore.knowledge). */
  knowledge: SbxKnowledgeSettings;
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
  variableValues
}: Pick<SbxRunRequest, "ref" | "settings" | "env" | "secretValues" | "variableValues">): {
  env: string[];
  passed: Record<string, string>;
} {
  const secrets = settings.secrets.filter((secret) => secretValues.has(secret.env));
  const taken = new Set([
    ...agentEnv.map((entry) => entry.slice(0, entry.indexOf("="))),
    ...Object.values(CONTROL_ENV),
    ...settings.secrets.map((secret) => secret.env)
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
    passed
  };
}

/**
 * Readies a tab's sandbox and returns the `sbx run` arguments: TET's mounts, knowledge and Allowed
 * paths, ports, secrets and variables (sandboxEnv: `env` for the caller to spawn `sbx run` with),
 * and with a control channel its env and the `tet-ctl` launcher. Creates the sandbox itself
 * (ensureSandboxExists), since the launcher must be written before `sbx run` starts the agent.
 * Applies tet.json as it stands and never writes it: what cannot be applied here
 * (readSbxProblems), or what sbx refuses, is skipped and returned as `problems` for the caller to
 * tell (sbxProblemNotices) — how a user learns that governance took over. Rejects when creating
 * fails, sbx cannot say what applies (readSbxProblems) or a folder of TET's own cannot be mounted.
 */
export async function prepareSbxRun(
  request: SbxRunRequest
): Promise<{ args: string[]; env: Record<string, string>; problems: SbxProblems }> {
  const { agent, name, onData } = request;
  const created = await ensureSandboxExists(agent, request.projectRefPath, name, request.sandboxes, onData);
  try {
    return await readySandboxRun(request, created);
  } catch (error) {
    // Only the start that created a sandbox seeds it: one left unseeded would be found by every
    // later start and run without its hosts, ports and secrets, so it goes, to be created anew.
    if (created && !(await removeSandbox(name, onData))) {
      logError(`could not remove the ${name} sandbox a failed first start left`);
    }
    throw error;
  }
}

/** prepareSbxRun past ensureSandboxExists, `created` telling whether this start made the sandbox. */
async function readySandboxRun(
  request: SbxRunRequest,
  created: boolean
): Promise<{ args: string[]; env: Record<string, string>; problems: SbxProblems }> {
  const { agent, onData, secretValues, variableValues } = request;
  const { projectId } = request.ref;
  const { name } = request;
  // Ports, hosts and secrets only reach a sandbox this call created: they survive a stop, and after
  // that a Save brings them in line (saveSbxSettings). A port another sandbox of the project forwards
  // is in place already (applyProjectPorts).
  const forwarded = created && request.settings.ports.length > 0 ? await readProjectPorts(projectId, request.sandboxes) : new Set<string>();
  const problems = await readSbxProblems({
    projectId,
    settings: request.settings,
    knowledge: request.knowledge,
    values: { secrets: new Set(secretValues.keys()), variables: new Set(variableValues.keys()) },
    agents: [agent],
    organization: request.organization,
    rules: request.rules,
    ports: created,
    published: forwarded
  });
  const { settings, knowledge } = withoutProblems(request.settings, request.knowledge, problems);
  const { env, passed } = sandboxEnv({ ...request, settings });
  // TET's own folders are not skipped: without them the agent has no hook settings or listable
  // sessions, silently. Everything else is in place by here, so a refusal is sbx's policy, and the
  // tab stops with sbx's reason in its output.
  const own = [
    ...fixedMountSpecs(request.paths),
    ...worktreeMountSpecs(request.projectRefPath),
    ...(await sessionMountSpecs(request.sessionMounts ?? []))
  ];
  const grants = await grantsOf(agent, knowledge, settings.paths);
  // A dropped path sbx refuses now is left out without a word: its drop said it was mounted.
  const refused = await mountAll(name, [...own, ...grants, ...droppedMountSpecs(name)], onData, created ? undefined : request.warm);
  const ownFailed = own.filter((spec) => refused.has(spec.mount)).map((spec) => spec.mount);
  if (ownFailed.length > 0) {
    throw new Error(`sbx did not mount TET's own ${ownFailed.length === 1 ? "folder" : "folders"} ${ownFailed.join(", ")} — see the tab's output`);
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
      addProblems(problems, "hosts", await allowHosts(name, settings.hosts, onData));
    }
    // Not `sbx run -p`: the sandbox always exists by here, and `run --name` drops `-p` on an
    // existing one.
    const added = settings.ports.filter((port) => !forwarded.has(sbxPortKey(port)));
    addProblems(problems, "ports", await applyPortChanges(name, { removed: [], added }, onData));
    // The sandbox's secrets went with any earlier one of its name.
    addProblems(problems, "secrets", await applySecrets(name, projectId, settings.secrets, secretValues, [], new Set(), onData));
  }
  // No workspace positionals, not even right after creating: the sandbox always exists by now, and
  // sbx run refuses them on an existing one even when unchanged. The agent positional is only
  // verified by sbx; `--name` finds the sandbox. The plain agent id even for a kit
  // (AgentSandbox.kit).
  const args = [
    "run",
    agent.id,
    "--name",
    name,
    ...env.flatMap((entry) => ["-e", entry]),
    ...Object.keys(passed).flatMap((variable) => ["-e", variable])
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
  return { args, env: passed, problems };
}

/** The ports the project's sandboxes publish — a stopped one lists none, and holds none. Rejects
 *  when sbx cannot say: read as none, a port a sandbox holds would read as in use here. */
async function readProjectPorts(projectId: string, listed?: SandboxList): Promise<Set<string>> {
  const sandboxes = listed ?? (await listSandboxes());
  if (!sandboxes) {
    throw new Error("SBX could not list the sandboxes.");
  }
  // A worktree forwards no ports (tet-json.ts's readSbxSettings): only the repository's sandboxes.
  const names = SANDBOXED_AGENTS.map((agent) => sandboxName({ projectId }, agent.id)).filter((name) => sandboxes.has(name));
  const published = await Promise.all(names.map(readSandboxPorts));
  if (published.includes(undefined)) {
    throw new Error("SBX could not list the sandboxes' ports.");
  }
  return new Set(published.flatMap((ports) => ports ?? []).map(sbxPortKey));
}

/** What readSbxProblems checks: the rows, and what this machine holds for them. */
interface SbxCheck {
  projectId: string;
  settings: SbxProjectSettings;
  knowledge: SbxKnowledgeSettings;
  /** The env names holding a value here: stored, or typed at this Save. */
  values: { secrets: ReadonlySet<string>; variables: ReadonlySet<string> };
  /** Whose knowledge is mounted: every agent at Save, the starting one at its spawn. */
  agents: readonly SandboxedAgent[];
  /** readPolicy's. */
  organization: string | undefined;
  /** readPolicy's rules, when the caller has them already. */
  rules?: FilesystemRule[];
  /** Whether the ports are applied now: at Save, and at the spawn creating a sandbox. */
  ports: boolean;
  /** readProjectPorts', when the caller has it already. */
  published?: ReadonlySet<string>;
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
 * - paths and knowledge: must exist, and sbx's filesystem rules allow the mount with its access
 *   (sbx-policy.ts's prediction: sbx has no `policy check` for them).
 * - ports: the host port is free, unless one of the project's sandboxes holds it.
 * - secrets: a value here, and every host reachable; an Allowed host counts without governance.
 * - variables: a value here.
 * The policy questions are sbx processes, asked together. Rejects where sbx cannot say: a row it
 * could not be asked about is no refusal.
 */
export async function readSbxProblems(check: SbxCheck): Promise<SbxProblems> {
  const { settings, knowledge, values, organization } = check;
  const forbidden = forbiddenBy(organization);
  const problems: SbxProblems = {};
  const add = (option: SbxOption, row: string, reason: string): void => addProblems(problems, option, { [row]: reason });
  const kinds = SBX_KNOWLEDGE_KINDS.filter((kind) => knowledge[kind] !== false);
  const secretHosts = [...new Set(settings.secrets.flatMap((secret) => secret.hosts))];
  // A host both allowed and a secret's is asked once.
  const asked = new Map<string, Promise<boolean>>();
  const allowed = (host: string): Promise<boolean> => {
    const pending = asked.get(host) ?? readHostAllowed(host);
    asked.set(host, pending);
    return pending;
  };
  const reachable = async (host: string): Promise<boolean> =>
    (!organization && settings.hosts.includes(host)) || (await allowed(host));
  const [rules, hostsAllowed, secretHostsAllowed, published, own] = await Promise.all([
    settings.paths.length > 0 || kinds.length > 0 ? (check.rules ?? readPolicy().then((policy) => policy?.rules)) : Promise.resolve([]),
    organization ? Promise.all(settings.hosts.map(allowed)) : Promise.resolve(settings.hosts.map(() => true)),
    Promise.all(secretHosts.map(reachable)),
    check.published ?? (check.ports && settings.ports.length > 0 ? readProjectPorts(check.projectId, check.sandboxes) : new Set<string>()),
    Promise.all(check.agents.map((agent) => sandboxKnowledgeFor(agent, knowledge.skillsFolder)))
  ]);
  if (rules === undefined) {
    throw new Error("SBX could not list its filesystem rules.");
  }
  const mountable = mountableBy(rules);

  for (const kind of kinds) {
    const access = knowledge[kind] as SbxAccess;
    if (kind === "skills" && knowledge.skillsFolder !== undefined && !existsSync(knowledge.skillsFolder)) {
      add("knowledge", kind, SBX_PROBLEM.missing);
    } else if (own.some((entries) => entries[kind].some((entry) => !mountable(entry.host, access)))) {
      add("knowledge", kind, forbidden);
    }
  }
  if (check.ports) {
    const free = await Promise.all(
      settings.ports.map(async (port) => !isPort(port.host) || published.has(sbxPortKey(port)) || canBind(Number(port.host)))
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
  return problems;
}
