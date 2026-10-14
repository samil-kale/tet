import { SBX_SKILLS_KINDS, addProblems, mergeProblems, problemOf, sbxPortKey, sbxProblemNotices } from "../../shared/sbx-rules";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type { SbxSkillsSettings, SbxPort, SbxProblems, SbxProjectSettings } from "../../shared/types/sbx";
import { getAgent, SANDBOXED_AGENTS } from "../agents";
import type { SandboxedAgent } from "../agents/agent";
import { readSbxSettings, writeSbxSettings } from "../store/tet-json";
import { listSandboxes, type SandboxList } from "./sbx-status";
import { contractHome, normalizeHostPath } from "../util/path-inside";
import { sameSet } from "../util/same-set";
import { grantsOf, revokeMounts } from "./sbx-mounts";
import { mcpNamesOf, planMcp } from "./sbx-mcp";
import {
  alignSandbox,
  applyProjectPorts,
  inSandboxTurns,
  markAligned,
  readSandboxReads,
  removeSandbox,
  sandboxName,
  type LiveSecret,
  type SandboxReads,
} from "./sbx";

/**
 * The agent of a sandbox TET made (sandboxName) for this workspace under another id, as for a
 * copied folder given a new one. Nothing reaches it, yet it keeps grants, rules and secrets of its
 * own; undefined for any other sandbox.
 */
function orphanAgent(name: string, workspaces: string[], target: SbxSaveTarget): AgentId | undefined {
  const agentId = SANDBOXED_AGENTS.find((candidate) => new RegExp(`^tet-${candidate.id}-[0-9a-f]{12}$`).test(name))?.id;
  return agentId !== undefined && name !== sandboxName(target.ref, agentId) && sameSet(workspaces, [target.path]) ? agentId : undefined;
}

/** A repository or worktree whose sandboxes a Save brings in line (saveSbxSettings), with its
 *  folder. */
export interface SbxSaveTarget {
  ref: ProjectRef;
  path: string;
}

/**
 * Rejects a Save sbx cannot answer for, before it changes anything (saveSbxSettings): what a kept
 * sandbox holds must be readable, or a row sbx merely could not list would go as refused — a
 * secret with its stored value, which sbx never gives back — and be taken back from every sandbox.
 * Ports are listed only by a running sandbox (readSandboxPorts), and only those are asked: a Save
 * starts none.
 */
function assertReadable(
  reads: SandboxReads,
  kept: boolean,
  { secrets, ports, hosts, mcp }: { secrets: boolean; ports: boolean; hosts: boolean; mcp: boolean },
): void {
  const unsaved = "Nothing was saved; try again.";
  // Registered at Save whether or not a sandbox exists yet.
  if (mcp && reads.mcp === undefined) {
    throw new Error(`SBX could not list its registered MCP servers. ${unsaved}`);
  }
  if (!kept) {
    return;
  }
  if (secrets && reads.secrets === undefined) {
    throw new Error(`SBX could not list the sandboxes' secrets. ${unsaved}`);
  }
  if (hosts && reads.hosts === undefined) {
    throw new Error(`SBX could not list the sandboxes' allowed hosts. ${unsaved}`);
  }
  if (ports && reads.ports === undefined) {
    throw new Error(`SBX could not list the sandboxes' ports. ${unsaved}`);
  }
}

/** A sandbox a Save removed, by the repository or worktree it was of. */
export interface SbxRemoved {
  ref: ProjectRef;
  agentId: AgentId;
}

/**
 * The dialog's Save of the rows readSbxProblems passed (saveProjectSbx): every sandbox goes if
 * SBX is disabled, one with another workspace too (see ensureSandboxExists; rebuilt at its next
 * tab), and one another id of the project left (orphanAgent). The others are brought in line as a
 * tab's start does it (alignSandbox, applyProjectPorts), each against the sandboxes' own
 * (readSandboxPorts, readSandboxHosts, readSandboxSecrets), so a hand-set rule deleted as a row
 * goes too and a port never published is tried again — but none is started for it: hosts and
 * secrets reach a stopped sandbox too, ports and MCP servers only one that runs, and a stopped one
 * takes them at its next tab's start (`markAligned`). A row sbx refuses in any sandbox is
 * `refused`, left out of tet.json and taken back where it went through — a port it would not
 * unpublish stays, as the sandbox still has it: tet.json holds what was applied. Grants are
 * narrowed last (revokeMounts), a mount cannot be given back at Save; one sbx would not take back
 * is `refused` too, its row and skills kind kept as they were. A sandbox that cannot be removed rejects,
 * tet.json left as it was; so does a Save sbx cannot read the sandboxes for (assertReadable),
 * before anything changed. The project's `worktrees` take its tet.json (tet-json.ts's
 * configRoot), so their sandboxes are brought in line too, all but the ports, which only the
 * repository's forward. Returns the sandboxes removed, for the caller to say so: a running session
 * of theirs just lost its sandbox; those of other ids; what sbx refused; what could not be taken
 * back; and what tet.json and the skills now hold.
 */
export async function saveSbxSettings(
  project: SbxSaveTarget,
  worktrees: readonly SbxSaveTarget[],
  request: SbxProjectSettings,
  skills: { previous: SbxSkillsSettings; current: SbxSkillsSettings },
  secretValues: ReadonlyMap<string, string>,
  changedSecrets: ReadonlySet<string>,
  organization: string | undefined,
  /** listSandboxes', which the caller took for its check. */
  sandboxes: SandboxList,
): Promise<{
  removed: SbxRemoved[];
  orphans: SbxRemoved[];
  refused: SbxProblems;
  failures: string[];
  settings: SbxProjectSettings;
  skills: SbxSkillsSettings;
}> {
  const previous = await readSbxSettings(project.path);
  const settings = { ...request, paths: request.paths.map((entry) => ({ ...entry, path: contractHome(entry.path) })) };
  const targets = [project, ...worktrees];
  const removed: SbxRemoved[] = [];
  const orphans: SbxRemoved[] = [];
  // Sorted out first, removed only once `assertReadable` passed: a Save that stops changes nothing.
  const orphaned: (SbxRemoved & { name: string })[] = [];
  for (const [name, { workspaces }] of sandboxes) {
    for (const target of targets) {
      const agentId = orphanAgent(name, workspaces, target);
      if (agentId !== undefined) {
        orphaned.push({ name, ref: target.ref, agentId });
        break;
      }
    }
  }
  const kept: { agent: SandboxedAgent; name: string; projectId: string; ports: boolean; running: boolean }[] = [];
  const dropped: (SbxRemoved & { name: string })[] = [];
  for (const target of targets) {
    for (const agent of SANDBOXED_AGENTS) {
      const agentId = agent.id;
      const name = sandboxName(target.ref, agentId);
      const existing = sandboxes.get(name);
      if (existing === undefined) {
        continue;
      }
      if (settings.enabled && sameSet(existing.workspaces, [target.path])) {
        kept.push({ agent, name, projectId: target.ref.projectId, ports: target === project, running: existing.running });
      } else {
        dropped.push({ name, ref: target.ref, agentId });
      }
    }
  }
  const anyPorts = settings.ports.length > 0 || previous.ports.length > 0;
  const anyMcp = settings.enabled && (settings.mcp.length > 0 || previous.mcp.length > 0);
  // Holding the kept sandboxes' turns, so a tab starting in one meanwhile waits, and finds what
  // this Save left it.
  return inSandboxTurns(
    kept.map(({ name }) => name),
    async () => {
      // Ports and MCP servers go by which sandbox runs, so that is asked again within the turns: one
      // a tab was starting when the caller listed them runs by now.
      if (kept.length > 0 && (anyPorts || anyMcp)) {
        const listed = await listSandboxes();
        for (const entry of kept) {
          entry.running = listed?.get(entry.name)?.running ?? entry.running;
        }
      }
      // Only the repository's running sandboxes list their ports (readSandboxPorts).
      const portsOf = anyPorts ? kept.filter(({ ports, running }) => ports && running).map(({ name }) => name) : [];
      const reads = await readSandboxReads(portsOf);
      assertReadable(reads, kept.length > 0, {
        secrets: settings.secrets.length > 0 || previous.secrets.length > 0,
        ports: anyPorts,
        hosts: !organization,
        mcp: anyMcp,
      });
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
      // Brings every kept sandbox to `target`, against what was read for it (readSandboxReads).
      const apply = async (target: SbxProjectSettings, live: SandboxReads): Promise<SbxProblems> => {
        const refused: SbxProblems = {};
        // Registered whether or not a sandbox exists yet; a refusal (a policy without a rule for it) is
        // told at Save, as a row sbx would not take.
        const mcpRows = [...previous.mcp, ...settings.mcp];
        const plan = anyMcp ? await planMcp(target.mcp, live.mcp && mcpNamesOf(live.mcp)) : undefined;
        addProblems(refused, "mcp", plan?.refused ?? {});
        if (kept.length === 0) {
          return refused;
        }
        const secrets = target.secrets.length > 0 || previous.secrets.length > 0;
        const liveSecrets = secrets ? live.secrets : new Map<string, LiveSecret[]>();
        // Whenever any are configured or were: the rows may match tet.json and still be unpublished
        // (ports written before the sandbox existed).
        if (target.ports.length > 0 || previous.ports.length > 0) {
          const forwarding = kept.filter(({ ports }) => ports);
          addProblems(
            refused,
            "ports",
            await applyProjectPorts(
              {
                running: forwarding.filter(({ running }) => running).map(({ name }) => name),
                stopped: forwarding.filter(({ running }) => !running).map(({ name }) => name),
              },
              target.ports,
              { dropped: [...previous.ports, ...settings.ports], read: live.ports },
            ),
          );
        }
        const told = new Set(mcpRows.map((server) => server.name));
        // One by one: sbx's own lock queues them anyway.
        for (const { name, projectId, running } of kept) {
          mergeProblems(
            refused,
            await alignSandbox(name, {
              projectId,
              settings: target,
              organization,
              secretValues,
              changedSecrets,
              live: { ...live, secrets: liveSecrets },
              mcp: running && plan ? { load: plan.load, unload: plan.unload, told } : undefined,
            }),
          );
        }
        return refused;
      };
      const refused = await apply(settings, reads);
      const refusedPort = (port: SbxPort): boolean => problemOf(refused, "ports", sbxPortKey(port)) !== undefined;
      const applied: SbxProjectSettings = {
        ...settings,
        ports: [
          ...settings.ports.filter((port) => !refusedPort(port)),
          ...previous.ports.filter((port) => refusedPort(port) && !settings.ports.some((next) => sbxPortKey(next) === sbxPortKey(port))),
        ],
        hosts: settings.hosts.filter((host) => problemOf(refused, "hosts", host) === undefined),
        secrets: settings.secrets.filter((secret) => problemOf(refused, "secrets", secret.env) === undefined),
        mcp: [
          ...settings.mcp.filter((server) => problemOf(refused, "mcp", server.name) === undefined),
          // One sbx would not unload is still loaded: its row stays, as a port it would not unpublish.
          ...previous.mcp.filter(
            (server) => problemOf(refused, "mcp", server.name) !== undefined && !settings.mcp.some((next) => next.name === server.name),
          ),
        ],
      };
      const failures =
        Object.keys(refused).length > 0
          ? sbxProblemNotices(await apply(applied, await readSandboxReads(portsOf))).map((notice) => `Not taken back: ${notice}`)
          : [];
      const unrevoked: SbxProblems = {};
      for (const { agent, name } of kept) {
        const current = new Set((await grantsOf(agent, skills.current, applied.paths)).map((grant) => grant.mount));
        const stale = (await grantsOf(agent, skills.previous, previous.paths)).filter((grant) => !current.has(grant.mount));
        if (stale.length > 0) {
          await revokeMounts(name, stale, unrevoked);
        }
      }
      // A grant sbx would not take back is still there: its row stays as it was.
      const stays = new Set(Object.keys(unrevoked.paths ?? {}).map(normalizeHostPath));
      applied.paths = [
        ...applied.paths.filter((entry) => !stays.has(normalizeHostPath(entry.path))),
        ...previous.paths
          .filter((entry) => stays.has(normalizeHostPath(entry.path)))
          .map((entry) => ({ ...entry, path: contractHome(entry.path) })),
      ];
      const appliedSkills = { ...skills.current };
      for (const kind of SBX_SKILLS_KINDS.filter((candidate) => unrevoked.skills?.[candidate] !== undefined)) {
        appliedSkills[kind] = skills.previous[kind];
        if (kind === "skills") {
          appliedSkills.skillsFolder = skills.previous.skillsFolder;
        }
      }
      // A running sandbox now holds the rows; a stopped one, or one sbx refused a row of, takes them
      // at its next tab's start (prepareSbxRun). A worktree's holds no ports (readSbxSettings).
      const inLine = Object.keys(refused).length === 0;
      for (const { name, ports, running } of kept) {
        markAligned(name, running && inLine ? { ...applied, ports: ports ? applied.ports : [] } : undefined);
      }
      mergeProblems(refused, unrevoked);
      await writeSbxSettings(project.path, applied);
      return { removed, orphans, refused, failures, settings: applied, skills: appliedSkills };
    },
  );
}
