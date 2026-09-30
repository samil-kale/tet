import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SBX_KNOWLEDGE_KINDS, addProblems, forbiddenBy } from "../../shared/sbx-rules";
import type { SbxKnowledgeConfig, SbxKnowledgeEntry, SbxKnowledgeKind, SbxKnowledgeSource, SbxPath, SbxProblems } from "../../shared/types/sbx";
import { agentInstalled, SANDBOXED_AGENTS } from "../agents";
import type { AgentPaths, SandboxedAgent } from "../agents/agent";
import { readLinkedGitDir } from "../util/linked-git-dir";
import { inTurn, mapLimited } from "../util/async";
import { assertInside, normalizeHostPath, openInside, relativeInside } from "../util/path-inside";
import { toContainerPath } from "../agents/hook-target";
import { runSbx, sbxJson, sbxRefusal, type OnData } from "./sbx-cli";
import { mountableBy, readPolicy } from "./sbx-status";
import { logError } from "../util/error-log";

/**
 * A live bind mount's `sbx mount` and `sbx umount` specs: `HOST:CTR_TARGET[:ro]` and
 * `HOST:CTR_TARGET`. `sbx mount` would parse `HOST:ro`'s "ro" as the target, so the target is
 * always spelled out — via `toContainerPath`, since the host path as target breaks on Windows (two
 * drive colons). Read-write is the same form without a suffix. `mount` carries the access, so equal
 * `mount`s are the same grant (saveSbxConfig narrows by it, mountAll compares by it). A single file
 * takes both forms.
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

export type SandboxPaths = Pick<AgentPaths, "agentDir">;

/**
 * tet's own mount for every sandboxed tab: its agent's sandbox folder rw (hook settings, agents'
 * records), and nothing else of `~/.tet`. A live mount, since a create positional cannot change
 * afterwards. The repository or worktree stays create-time: `sbx run` has no `--workdir`, and
 * without a positional the agent starts in an empty `/home/agent/workspace`. It lands at the host
 * path's container form, so `HookTarget` paths hold.
 *
 * Never the agent's config directory (`~/.claude`, `~/.codex`): pointed at by `CLAUDE_CONFIG_DIR`/
 * `CODEX_HOME`, the sandboxed CLI would be signed in as the host, and a `/login` inside would
 * replace the host's. Knowledge (AgentSandbox.knowledge) and sessions (sessionMountSpecs)
 * are curated subpaths, never the directory holding credentials.
 */
export function fixedMountSpecs(paths: SandboxPaths): MountSpec[] {
  return [pathMountSpecs({ path: paths.agentDir, access: "rw" })];
}

/**
 * A linked worktree's repository `.git`, rw: the worktree's own `.git` is a file pointing there, and
 * without it git fails in the sandbox ("not a git repository"). tet creates worktrees with relative
 * links (git.ts's worktreeAdd), which hold at the container paths. Live, like fixedMountSpecs.
 */
export function worktreeMountSpecs(projectRefPath: string): MountSpec[] {
  const commonDir = readLinkedGitDir(projectRefPath)?.commonDir;
  return commonDir === undefined ? [] : [pathMountSpecs({ path: commonDir, access: "rw" })];
}

/** An agent's host knowledge per kind, as sandboxKnowledgeFor resolves it. */
type KnowledgeEntries = Record<SbxKnowledgeKind, SbxKnowledgeEntry[]>;

/** Where the sandboxed CLI reads its own skills, whether or not it is installed here. */
function skillsTargets(agent: SandboxedAgent): string[] {
  return agent.sandbox.knowledge().skills.map((entry) => entry.target);
}

/**
 * What a sandboxed agent may bring from this host, per kind, only what exists: its own knowledge
 * only while it is installed here — a folder an uninstalled one left is not wanted — and
 * `~/.agents/skills` at its `sharedSkillsTarget` either way, unless its own skills sit there. An
 * agent without a `sharedSkillsTarget` (Claude) never gets it. A `skillsFolder` replaces both, at
 * the agent's own skills targets, installed or not: the user chose it.
 */
export async function sandboxKnowledgeFor(agent: SandboxedAgent, skillsFolder?: string): Promise<KnowledgeEntries> {
  const own = (await agentInstalled(agent, os.tmpdir())) ? agent.sandbox.knowledge() : undefined;
  const existing = (entries: SbxKnowledgeEntry[] = []): SbxKnowledgeEntry[] => entries.filter((entry) => existsSync(entry.host));
  const rest = { plugins: existing(own?.plugins), instructions: existing(own?.instructions) };
  if (skillsFolder !== undefined) {
    const skills = existsSync(skillsFolder) ? skillsTargets(agent).map((target) => ({ host: skillsFolder, target })) : [];
    return { skills, ...rest };
  }
  const skills = existing(own?.skills);
  const target = agent.sandbox.sharedSkillsTarget;
  const shared = path.join(os.homedir(), ".agents", "skills");
  if (target !== undefined && !skills.some((entry) => entry.target === target) && existsSync(shared)) {
    skills.push({ host: shared, target });
  }
  return { skills, ...rest };
}

/** The Knowledge tab's agents: those installed here, with what each brings of its own. */
export async function readKnowledgeSources(): Promise<SbxKnowledgeSource[]> {
  const sources = await Promise.all(
    SANDBOXED_AGENTS.map(async (agent): Promise<SbxKnowledgeSource | undefined> =>
      (await agentInstalled(agent, os.tmpdir()))
        ? {
            agentId: agent.id,
            displayName: agent.displayName,
            own: await sandboxKnowledgeFor(agent),
            skillsTargets: skillsTargets(agent)
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
 * its workspace.
 */
export async function grantsOf(agent: SandboxedAgent, knowledge: SbxKnowledgeConfig, paths: SbxPath[]): Promise<Grant[]> {
  const entries = await sandboxKnowledgeFor(agent, knowledge.skillsFolder);
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
      .filter((entry) => existsSync(normalizeHostPath(entry.path)))
      .map((entry) => ({ ...pathMountSpecs(entry), option: "paths" as const, row: entry.path }))
  ];
}

/**
 * Starts a stopped sandbox with a cheap `exec`: `sbx mount` and `ports` refuse one ("409
 * Conflict"). False also when it does not exist — the same to its best-effort callers.
 *
 * A spawn starts it before it knows it may (`SbxRunRequest.warm`), since this is the slowest step.
 * Safe that early because it creates nothing: for a sandbox that does not exist it fails with
 * "sandbox '<name>' not found", and a rebuild removing the sandbox under a start still in flight
 * leaves the `create` after it working.
 */
export async function ensureRunning(name: string, onData?: OnData): Promise<boolean> {
  return (await runSbx(["exec", "-i", name, "true"], { onData })).ok;
}

const MOUNT_CONCURRENCY = 6;

/** One live mount as `sbx inspect` lists it. */
interface RuntimeBind {
  host: string;
  target: string;
  readOnly: boolean;
}

/**
 * The live mounts a sandbox holds, from one `sbx inspect --json` (`runtime_mounts[]`: `host_path`
 * as given, `container_target`, `read_only` only when true). Answers for a stopped sandbox too.
 * Undefined when sbx cannot say, as for a sandbox that does not exist.
 */
async function readRuntimeBinds(name: string): Promise<RuntimeBind[] | undefined> {
  const parsed = await sbxJson<{ runtime_mounts?: { host_path?: string; container_target?: string; read_only?: boolean }[] }>([
    "inspect", name, "--json"
  ]);
  return parsed?.runtime_mounts?.flatMap(({ host_path, container_target, read_only }) =>
    host_path && container_target ? [{ host: host_path, target: container_target, readOnly: read_only === true }] : []
  );
}

/** readRuntimeBinds' as MountSpecs. */
async function readRuntimeMounts(name: string): Promise<MountSpec[] | undefined> {
  return (await readRuntimeBinds(name))?.map((bind) => mountSpec(bind.host, bind.target, bind.readOnly));
}

/** The mountAll underway per sandbox name (inTurn). */
const mountSetups = new Map<string, Promise<unknown>>();

/**
 * The paths dropped into a sandbox's tabs (mountDropped), by sandbox name: the user's, never in
 * tet.json, held until tet quits — every start's mountAll is handed them, or it would take them out
 * again. The first start after tet quits does.
 */
const droppedMounts = new Map<string, string[]>();

/** A sandbox's dropped paths as mounts, those still here: mountAll must not be handed one whose
 *  host path is gone. */
export function droppedMountSpecs(name: string): MountSpec[] {
  return (droppedMounts.get(name) ?? []).filter((host) => existsSync(host)).map((host) => pathMountSpecs({ path: host, access: "rw" }));
}

/**
 * Takes every dropped path in or under `folder` out of every sandbox holding it, before `folder`
 * goes: a mount whose host path is gone keeps a stopped sandbox from starting. Each `umount` in turn
 * with that sandbox's mountAll; one sbx refuses is gone with the sandbox, or taken out at its next
 * start, which is handed the path no more.
 */
export async function releaseDropped(folder: string): Promise<void> {
  const root = normalizeHostPath(folder);
  const inside = (host: string): boolean => host === root || relativeInside(root, host) !== undefined;
  for (const [name, hosts] of droppedMounts) {
    const released = hosts.filter(inside);
    if (released.length === 0) {
      continue;
    }
    droppedMounts.set(name, hosts.filter((host) => !inside(host)));
    await inTurn(mountSetups, name, async () => {
      for (const host of released) {
        await runSbx(["umount", name, pathMountSpecs({ path: host, access: "rw" }).unmount]);
      }
    });
  }
}

/** What mountDropped did: the sandbox saw the path already, mounted it, or could not. */
export type DropMount = { seen: true } | { mounted: true } | { refused: string };

/**
 * Makes paths dropped into a sandboxed tab visible at their container path (toContainerPath),
 * answering for each in order: one of the folders the caller knows the sandbox sees (`seen`: its
 * workspace, its agent folder), or a live mount at the same path (an Allowed path, an earlier
 * drop), holds it already, or it is mounted rw. The policy is asked first, as for an Allowed path
 * (readSbxProblems). The mounts and rules are read once for all of them, in turn with the
 * sandbox's mountAll (`mountSetups`), which would otherwise mount twice or take one out.
 */
export async function mountDropped(name: string, seen: string[], hostPaths: string[]): Promise<DropMount[]> {
  const hosts = hostPaths.map(normalizeHostPath);
  const within = (host: string, root: string): boolean => host === path.resolve(root) || relativeInside(root, host) !== undefined;
  if (hosts.every((host) => seen.some((root) => within(host, root)))) {
    return hosts.map(() => ({ seen: true }));
  }
  return inTurn(mountSetups, name, async (): Promise<DropMount[]> => {
    const [binds, policy] = await Promise.all([readRuntimeBinds(name), readPolicy()]);
    const answers: DropMount[] = [];
    // One by one: sbx's own lock refuses mounts side by side.
    for (const host of hosts) {
      const mountedAt = (root: string): boolean => within(host, root);
      if (seen.some(mountedAt) || binds?.some((bind) => bind.target === toContainerPath(bind.host) && mountedAt(bind.host))) {
        answers.push({ seen: true });
      } else if (binds === undefined || policy === undefined) {
        answers.push({ refused: "SBX could not say whether it may be mounted" });
      } else if (!mountableBy(policy.rules)(host, "rw")) {
        answers.push({ refused: forbiddenBy(policy.organization) });
      } else {
        const result = await runSbx(["mount", name, pathMountSpecs({ path: host, access: "rw" }).mount]);
        if (result.ok) {
          droppedMounts.set(name, [...(droppedMounts.get(name) ?? []), host]);
          binds.push({ host, target: toContainerPath(host), readOnly: false });
        }
        answers.push(result.ok ? { mounted: true } : { refused: sbxRefusal(result) });
      }
    }
    return answers;
  });
}

/**
 * Brings a sandbox's live mounts to `specs` at every start, against what it holds
 * (readRuntimeMounts): a mount it lacks is mounted, one it holds that `specs` has not — another
 * access included — unmounted.
 * - mounts survive a stop, access included. `sbx stop` can happen outside tet, so the sandbox is
 *   asked each time rather than tet remembering.
 * - mounting what is mounted is not idempotent (a read-only file fails, a folder is bound twice),
 *   hence only what is missing.
 * - a mount whose host path is gone keeps the sandbox from starting; `sbx umount` takes it out of a
 *   stopped sandbox too. `specs` holds only what exists, so it goes with the rest, before the
 *   start.
 * - another access is refused while one is held, so the unmounts run first.
 *
 * Concurrent up to MOUNT_CONCURRENCY, as sbx's own lock refuses more. One sandbox's tabs take turns
 * (`mountSetups`): two tabs starting together would both mount what is missing, the second failing
 * on a read-only file; in turn, the second finds it all there.
 *
 * `started` is a start already underway (`SbxRunRequest.warm`), waited for before unmounting and
 * joined instead of started again — but only its *success* counts: it may have run before the
 * sandbox existed (two tabs of one agent starting together, the second one seeing the first
 * one's), or failed on a mount whose host path is gone. Returns what sbx refused, by `mount`, with
 * its reason (sbxRefusal).
 */
export function mountAll(name: string, specs: MountSpec[], onData?: OnData, started?: Promise<boolean>): Promise<Map<string, string>> {
  return inTurn(mountSetups, name, async () => {
    // Where sbx cannot say, none counts as held: Save's revokeMounts narrowed the grants already, so
    // only this backstop is lost, and mounting all of `specs` at worst binds a folder twice or is
    // refused, which the caller tells.
    const [live = [], running] = await Promise.all([readRuntimeMounts(name), started]);
    const wanted = new Set(specs.map((spec) => spec.mount));
    // One by one: rare (a change since the last start).
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
 * does not hold is gone already. A stopped sandbox takes the `umount`. Adds what sbx would not take
 * back to `refused`.
 */
export async function revokeMounts(name: string, grants: Grant[], refused: SbxProblems): Promise<void> {
  const live = (await readRuntimeMounts(name))?.map((mount) => mount.mount);
  for (const grant of grants.filter((grant) => live?.includes(grant.mount) ?? true)) {
    const result = await runSbx(["umount", name, grant.unmount]);
    if (!result.ok) {
      addProblems(refused, grant.option, { [grant.row]: sbxRefusal(result) });
    }
  }
}

/** A `SandboxSessionMount` with an absolute host side, for `sessionMountSpecs`. */
export interface SbxSessionMount {
  host: string;
  target: string;
  file?: boolean;
  /** The sandbox's agent folder, which `host` must not lead out of: the sandbox sees it whole and
   *  could put a link there, which sbx would mount as the folder it points to. */
  within: string;
}

/**
 * Mounts putting a sandboxed agent's sessions on the host (why: AgentSandbox.sessions), rw.
 *
 * The host side is created first (directory or empty file) — `sbx mount` needs it. The container
 * side need not exist, and a mount wins over a template's volume there (Claude's
 * `~/.claude/projects`). A host side that cannot be created is left out; one sbx refuses stops the
 * tab like tet's own mounts (prepareSbxRun).
 */
export async function sessionMountSpecs(mounts: SbxSessionMount[]): Promise<MountSpec[]> {
  const specs: MountSpec[] = [];
  for (const mount of mounts) {
    try {
      if (mount.file) {
        await fs.mkdir(path.dirname(mount.host), { recursive: true });
        // Never truncate: it is the session index the sandbox appends to.
        await (await openInside(mount.within, mount.host, "a")).close();
      } else {
        await fs.mkdir(mount.host, { recursive: true });
        await assertInside(mount.within, mount.host);
      }
      specs.push(mountSpec(mount.host, mount.target, false));
    } catch (error) {
      logError("could not prepare sandbox session mount", error);
    }
  }
  return specs;
}
