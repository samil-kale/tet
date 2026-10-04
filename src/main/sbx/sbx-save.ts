import { SBX_KNOWLEDGE_KINDS, SBX_PROBLEM, addProblems, sbxPortKey, sbxProblemNotices } from "../../shared/sbx-rules";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type { SbxKnowledgeSettings, SbxOption, SbxPort, SbxProblems, SbxProjectSettings } from "../../shared/types/sbx";
import { getAgent, SANDBOXED_AGENTS } from "../agents";
import type { SandboxedAgent } from "../agents/agent";
import { readSbxSettings, writeSbxSettings } from "../store/tet-json";
import { runSbx, sbxJson } from "./sbx-cli";
import type { SandboxList } from "./sbx-status";
import { contractHome, normalizeHostPath } from "../util/path-inside";
import { sameSet } from "../util/same-set";
import { ensureRunning, grantsOf, revokeMounts } from "./sbx-mounts";
import { allowHosts, applyPortChanges, applySecrets, readSandboxPorts, removeSandbox, sandboxName, type LiveSecret } from "./sbx";

/**
 * The agent of a sandbox TET made (sandboxName) for this workspace under another id, as for a
 * copied folder given a new one. Nothing reaches it, yet it keeps grants, rules and secrets of its
 * own; undefined for any other sandbox.
 */
function orphanAgent(name: string, workspaces: string[], target: SbxSaveTarget): AgentId | undefined {
  const agentId = SANDBOXED_AGENTS.find((candidate) => new RegExp(`^tet-${candidate.id}-[0-9a-f]{12}$`).test(name))?.id;
  return agentId !== undefined && name !== sandboxName(target.ref, agentId) && sameSet(workspaces, [target.path]) ? agentId : undefined;
}

/**
 * Each sandbox's Allowed hosts as sbx has them, what saveSbxSettings brings in line with tet.json,
 * from one `policy ls`. A rule counts when an allow scoped `sandbox:<name>` and editable, as
 * `sbx policy allow network --sandbox` makes it; a kit's rule is not editable, a global one is the
 * machine's. One rule per resource, so the list is their union. Inactive rules count too:
 * governance hides them by default, and a Save without governance would then add them a second
 * time. Undefined when sbx does not answer: read as none, a host dropped as a row would stay
 * allowed.
 */
async function readSandboxHosts(): Promise<Map<string, string[]> | undefined> {
  const parsed = await sbxJson<{ rules?: { scope?: string; decision?: string; editable?: boolean; resources?: string[] }[] }>([
    "policy", "ls", "--type", "network", "--include-inactive", "--json"
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
 * Removes dropped hosts at Save, ending the allowance *now* (as revokeMounts). One `rm` per host:
 * the comma-list form removes nothing if any entry is missing, and one removed by hand answers
 * "rule not found", exit 1, while the others still go. `--force`: `rm` asks first, which a closed
 * stdin (runSbx) would fail.
 */
async function revokeStaleHosts(name: string, previous: string[], current: string[]): Promise<void> {
  for (const host of previous.filter((old) => !current.includes(old))) {
    await runSbx(["policy", "rm", "network", "--sandbox", name, "--resource", host, "--force"]);
  }
}

/**
 * Each sandbox's custom secrets — the truth applySecrets works against, as readSandboxHosts is for
 * hosts — from one `sbx secret ls --json` (`custom_secrets`: `{scope, targets, env, placeholder,
 * secret}`, scope the sandbox's name or "global"). Never the value: sbx lists only its first
 * characters. Undefined when sbx does not answer: read as none, every secret set would fail as
 * "already exists", and a changed one would never arrive.
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
 * Brings the project's forwarded ports to `ports`. A host port is forwarded by one sandbox only —
 * another's publish of it is refused — so a port is in place once any of the project's sandboxes
 * has it: one it is dropped from is unpublished there, a missing one published by the first
 * sandbox that takes it. Each sandbox is started first, as only a running one lists its ports
 * (readSandboxPorts). Returns what no sandbox took, by `host:container`, and a port it would not
 * unpublish.
 */
async function applyProjectPorts(names: string[], ports: SbxPort[], read?: Map<string, SbxPort[]>): Promise<Record<string, string>> {
  // Read already (assertReadable): each of them running.
  const started = read ? names.map(() => true) : await Promise.all(names.map((name) => ensureRunning(name)));
  const running = names.filter((_, index) => started[index]);
  // Unreadable as none published (parsePublishedPorts).
  const published = read
    ? running.map((name) => read.get(name) ?? [])
    : await Promise.all(running.map(async (name) => (await readSandboxPorts(name)) ?? []));
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

/** A repository or worktree whose sandboxes a Save brings in line (saveSbxSettings), with its
 *  folder. */
export interface SbxSaveTarget {
  ref: ProjectRef;
  path: string;
}

/** What a Save read of the kept sandboxes before changing anything (assertReadable), for its
 *  first pass to work against rather than ask again. */
interface SaveReads {
  secrets?: Map<string, LiveSecret[]>;
  /** Without governance: each sandbox's Allowed hosts. */
  hosts?: Map<string, string[]>;
  /** By sandbox, each running: what it published. */
  ports?: Map<string, SbxPort[]>;
}

/**
 * Rejects a Save sbx cannot answer for, before it changes anything (saveSbxSettings): what a kept
 * sandbox holds must be readable, or a row sbx merely could not list would go as refused — a
 * secret with its stored value, which sbx never gives back — and be taken back from every sandbox.
 * Ports are listed only by a running sandbox (readSandboxPorts), so theirs are started here.
 */
async function assertReadable(
  kept: readonly { agent: SandboxedAgent; name: string; ports: boolean }[],
  secrets: boolean,
  ports: boolean,
  hosts: boolean
): Promise<SaveReads> {
  const unsaved = "Nothing was saved; try again.";
  const reads: SaveReads = {};
  if (kept.length === 0) {
    return reads;
  }
  if (secrets) {
    reads.secrets = await readSandboxSecrets();
    if (reads.secrets === undefined) {
      throw new Error(`SBX could not list the sandboxes' secrets. ${unsaved}`);
    }
  }
  if (hosts) {
    reads.hosts = await readSandboxHosts();
    if (reads.hosts === undefined) {
      throw new Error(`SBX could not list the sandboxes' allowed hosts. ${unsaved}`);
    }
  }
  if (ports) {
    // All at once, as applyProjectPorts does: each sandbox is its own start and listing.
    const portsOf = async ({ agent, name }: (typeof kept)[number]): Promise<[string, SbxPort[]]> => {
      const sandbox = `the ${agent.displayName} sandbox`;
      if (!(await ensureRunning(name))) {
        throw new Error(`SBX could not start ${sandbox} to bring its ports in line. ${unsaved}`);
      }
      const listed = await readSandboxPorts(name);
      if (!listed) {
        throw new Error(`SBX could not list the ports of ${sandbox}. ${unsaved}`);
      }
      return [name, listed];
    };
    reads.ports = new Map(await Promise.all(kept.filter((entry) => entry.ports).map(portsOf)));
  }
  return reads;
}

/** A sandbox a Save removed, by the repository or worktree it was of. */
export interface SbxRemoved {
  ref: ProjectRef;
  agentId: AgentId;
}

/**
 * The dialog's Save of the rows readSbxProblems passed (saveProjectSbx): every sandbox goes if
 * SBX is disabled, one with another workspace too (see ensureSandboxExists; rebuilt at its next
 * tab), and one another id of the project left (orphanAgent). The others are brought in line:
 * ports (applyProjectPorts), hosts both ways without governance (revokeStaleHosts, allowHosts) and
 * secrets (applySecrets), each against the sandboxes' own (readSandboxPorts, readSandboxHosts,
 * readSandboxSecrets), so a hand-set rule deleted as a row goes too and a port never published is
 * tried again. A row sbx refuses in any sandbox is `refused`, left out of tet.json and taken back
 * where it went through — a port it would not unpublish stays, as the sandbox still has it:
 * tet.json holds what was applied. Grants are narrowed last (revokeMounts), a mount cannot be
 * given back at Save; one sbx would not take back is `refused` too, its row and knowledge kind
 * kept as they were. Ports need the sandbox running. A sandbox that cannot be removed rejects,
 * tet.json left as it was; so does a Save sbx cannot read the sandboxes for (assertReadable),
 * before anything changed. The project's `worktrees` take its tet.json (tet-json.ts's
 * configRoot), so their sandboxes are brought in line too, all but the ports, which only the
 * repository's forward. Returns the sandboxes removed, for the caller to say so: a running session
 * of theirs just lost its sandbox; those of other ids; what sbx refused; what could not be taken
 * back; and what tet.json and the knowledge now hold.
 */
export async function saveSbxSettings(
  project: SbxSaveTarget,
  worktrees: readonly SbxSaveTarget[],
  request: SbxProjectSettings,
  knowledge: { previous: SbxKnowledgeSettings; current: SbxKnowledgeSettings },
  secretValues: ReadonlyMap<string, string>,
  changedSecrets: ReadonlySet<string>,
  organization: string | undefined,
  /** listSandboxes', which the caller took for its check. */
  sandboxes: SandboxList
): Promise<{
  removed: SbxRemoved[];
  orphans: SbxRemoved[];
  refused: SbxProblems;
  failures: string[];
  settings: SbxProjectSettings;
  knowledge: SbxKnowledgeSettings;
}> {
  const previous = await readSbxSettings(project.path);
  const settings = { ...request, paths: request.paths.map((entry) => ({ ...entry, path: contractHome(entry.path) })) };
  const targets = [project, ...worktrees];
  const removed: SbxRemoved[] = [];
  const orphans: SbxRemoved[] = [];
  // Sorted out first, removed only once `assertReadable` passed: a Save that stops changes nothing.
  const orphaned: (SbxRemoved & { name: string })[] = [];
  for (const [name, workspaces] of sandboxes) {
    const target = targets.find((candidate) => orphanAgent(name, workspaces, candidate) !== undefined);
    if (target !== undefined) {
      orphaned.push({ name, ref: target.ref, agentId: orphanAgent(name, workspaces, target)! });
    }
  }
  const kept: { agent: SandboxedAgent; name: string; projectId: string; ports: boolean }[] = [];
  const dropped: (SbxRemoved & { name: string })[] = [];
  for (const target of targets) {
    for (const agent of SANDBOXED_AGENTS) {
      const agentId = agent.id;
      const name = sandboxName(target.ref, agentId);
      const existing = sandboxes.get(name);
      if (existing === undefined) {
        continue;
      }
      if (settings.enabled && sameSet(existing, [target.path])) {
        kept.push({ agent, name, projectId: target.ref.projectId, ports: target === project });
      } else {
        dropped.push({ name, ref: target.ref, agentId });
      }
    }
  }
  const reads = await assertReadable(
    kept,
    settings.secrets.length > 0 || previous.secrets.length > 0,
    settings.ports.length > 0 || previous.ports.length > 0,
    !organization
  );
  for (const { name, ref, agentId } of orphaned) {
    if (!(await removeSandbox(name))) {
      throw new Error(`An earlier ${getAgent(agentId).displayName} sandbox (${name}) could not be removed.`);
    }
    orphans.push({ ref, agentId });
  }
  for (const { name, ref, agentId } of dropped) {
    if (!(await removeSandbox(name))) {
      throw new Error(`The ${getAgent(agentId).displayName} sandbox could not be removed.`);
    }
    removed.push({ ref, agentId });
  }
  // Brings every kept sandbox to `target`. The listings answer for every sandbox at once, so they
  // are asked together, and only when the project has one: each is an sbx process.
  const apply = async (target: SbxProjectSettings, first?: SaveReads): Promise<SbxProblems> => {
    const refused: SbxProblems = {};
    if (kept.length === 0) {
      return refused;
    }
    const secrets = target.secrets.length > 0 || previous.secrets.length > 0;
    const [liveHosts, liveSecrets] = await Promise.all([
      organization ? new Map<string, string[]>() : (first?.hosts ?? readSandboxHosts()),
      secrets ? (first?.secrets ?? readSandboxSecrets()) : new Map<string, LiveSecret[]>()
    ]);
    // Whenever any are configured or were, since what a sandbox published is only readable while it
    // runs: the rows may match tet.json and still be unpublished (ports written before the sandbox
    // existed).
    if (target.ports.length > 0 || previous.ports.length > 0) {
      addProblems(refused, "ports", await applyProjectPorts(kept.filter(({ ports }) => ports).map(({ name }) => name), target.ports, first?.ports));
    }
    for (const { name, projectId } of kept) {
      if (!organization && liveHosts) {
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
      } else if (!organization) {
        // Unread only by the second pass: the first has them (assertReadable).
        addProblems(refused, "hosts", Object.fromEntries(target.hosts.map((host) => [host, SBX_PROBLEM.hostsUnlisted])));
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
  const refused = await apply(settings, reads);
  const refusedPort = (port: SbxPort): boolean => refused.ports?.[sbxPortKey(port)] !== undefined;
  const applied: SbxProjectSettings = {
    ...settings,
    ports: [
      ...settings.ports.filter((port) => !refusedPort(port)),
      ...previous.ports.filter((port) => refusedPort(port) && !settings.ports.some((next) => sbxPortKey(next) === sbxPortKey(port)))
    ],
    hosts: settings.hosts.filter((host) => refused.hosts?.[host] === undefined),
    secrets: settings.secrets.filter((secret) => refused.secrets?.[secret.env] === undefined)
  };
  const failures =
    Object.keys(refused).length > 0 ? sbxProblemNotices(await apply(applied)).map((notice) => `Not taken back: ${notice}`) : [];
  const unrevoked: SbxProblems = {};
  for (const { agent, name } of kept) {
    const current = new Set((await grantsOf(agent, knowledge.current, applied.paths)).map((grant) => grant.mount));
    const stale = (await grantsOf(agent, knowledge.previous, previous.paths)).filter((grant) => !current.has(grant.mount));
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
  await writeSbxSettings(project.path, applied);
  return { removed, orphans, refused, failures, settings: applied, knowledge: appliedKnowledge };
}
