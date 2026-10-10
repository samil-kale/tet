import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  AgentDefinition,
  AgentPaths,
  AgentSessionInfo,
  SandboxedAgent,
  SandboxSessionStore,
  SessionWatch,
  SpawnPreparation,
} from "../agents/agent";
import { sbxProblemNotices } from "../../shared/sbx-rules";
import type { AgentId } from "../../shared/types/agents";
import type { NoticeSeverity } from "../../shared/types/app";
import type { SbxKnowledgeSettings, SbxProjectSettings } from "../../shared/types/sbx";
import { dropsDir, sandboxDir, sandboxDropsDir, sandboxHandoverDir, sandboxSessionDir } from "../store/project-dirs";
import type { ResolvedRef } from "../store/resolved-ref";
import { prepareSbxRun, sandboxName } from "../sbx/sbx";
import { mountDropped, type SbxSessionMount } from "../sbx/sbx-mounts";
import type { checkSbxReady } from "../sbx/sbx-status";
import { openInside, removeInside } from "../util/path-inside";
import { toContainerPath } from "../agents/hook-target";
import { HOST_TAB, SANDBOX_TAB, type TabSide } from "./tab-side";

/** A tab's session operations, bound to where its session lives. */
export interface SessionActions {
  remove(sessionId: string): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  files(sessionId: string): Promise<string[]>;
  /** The sandbox's mounted agent folder, which a file named here must not lead out of
   *  (openInside); none on this machine. */
  root?: string;
}

/** Another agent's session a new tab takes over: its transcript on the host (SessionProvider.files). */
export interface HandoverFiles {
  from: AgentId;
  sessionId: string;
  files: string[];
  /** SessionActions.root of the session's place: a copy reads the files only inside it. */
  within?: string;
}

/** What a start hands its place. */
export interface LaunchInput {
  /** The agent's arguments after its setup's: resume and the first prompt, the prompt naming a
   *  handover's files as `files` gives them. */
  agentArgs(files: string[] | undefined): string[];
  handover?: HandoverFiles;
  /** Setup output, forwarded live to the tab. */
  onData: (data: string) => void;
}

/** What a tab's process is started with (TerminalSession). */
export interface Launch {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  /** Over the machine's variables. */
  envOverride?: Record<string, string>;
  /** A handover's copy this start made for the tab alone, deleted with it. */
  handoverDir?: string;
}

/**
 * Where a tab's process runs — this machine, or the repository's or worktree's sandbox — and
 * everything that differs between the two. Per agent and repository or worktree a host place, and
 * a sandbox place where the agent has the sandbox group (the session manager's AgentRuntime); a
 * tab's is where its latest start ran it (resolvePlace), until then where its session lives.
 * Nothing outside a place asks which one it is: a new difference is a member here, implemented by
 * both (HostPlace, SandboxPlace).
 */
export interface TabPlace {
  /** What the tab's process may do through the control channel and gets at its start (pty.ts). */
  readonly side: TabSide;
  /** The sandbox its sessions are listed as (AgentSessionInfo.sandbox); none on this machine. */
  readonly sandbox?: string;
  /** Where the tab's pasted or dropped content without a path is written. */
  dropsDir(): string;
  /** Pasted or dropped paths of this machine as the tab types them; a refused one is left out. */
  handPaths(hostPaths: string[]): Promise<string[]>;
  /** The agent's sessions living here, oldest first; none where it keeps none here. */
  listSessions(): Promise<AgentSessionInfo[]>;
  /** Calls `onChange` when they change, so they are listed again without waiting for output;
   *  returns the stop. Undefined where nothing is watched. */
  watchSessions(onChange: () => void): (() => void) | undefined;
  /** Whether a watch started here is armed now; where not, the tab's output schedules the listing. */
  sessionsWatched(): boolean;
  /** The operations on a session living here; undefined where the agent keeps none here. */
  sessionActions(): SessionActions | undefined;
}

/** A place a start resolved, which can start the tab's process. */
export interface StartingPlace extends TabPlace {
  launch(input: LaunchInput): Promise<Launch>;
}

/** What both places are built from: one agent's tabs in one repository or worktree. */
export interface PlaceContext<A extends AgentDefinition = AgentDefinition> {
  at: ResolvedRef;
  dataRoot: string;
  agent: A;
  /** The agent's host executable (AgentDefinition.executable), for its session operations too. */
  executable: string;
  onNotice: (severity: NoticeSeverity, message: string) => void;
}

/** This machine: paths as they are, the host setup's spawn (HostSetups). */
export class HostPlace implements StartingPlace {
  readonly side = HOST_TAB;
  private watch?: SessionWatch;

  constructor(
    protected readonly context: PlaceContext,
    /** HostSetups.preparation, read at launch: a setup may be redone meanwhile. */
    private readonly preparation: () => SpawnPreparation | undefined,
  ) {}

  dropsDir(): string {
    return dropsDir(this.context.dataRoot, this.context.at.ref.projectId);
  }

  handPaths(hostPaths: string[]): Promise<string[]> {
    return Promise.resolve(hostPaths);
  }

  listSessions(): Promise<AgentSessionInfo[]> {
    const { agent, at } = this.context;
    return agent.sessions?.list(at.path) ?? Promise.resolve([]);
  }

  watchSessions(onChange: () => void): (() => void) | undefined {
    const { agent, at } = this.context;
    const watch = agent.sessions?.watch?.(at.path, onChange);
    if (!watch) {
      return undefined;
    }
    this.watch = watch;
    return () => {
      watch.stop();
      this.watch = undefined;
    };
  }

  sessionsWatched(): boolean {
    return this.watch?.watching() ?? false;
  }

  sessionActions(): SessionActions | undefined {
    const { executable, at, agent } = this.context;
    const sessions = agent.sessions;
    if (!sessions) {
      return undefined;
    }
    return {
      remove: (sessionId) => sessions.remove(executable, at.path, sessionId),
      rename: (sessionId, title) => sessions.rename(executable, at.path, sessionId, title),
      files: (sessionId) => sessions.files(at.path, sessionId),
    };
  }

  /** A handover's files are read where the other agent keeps them. */
  launch(input: LaunchInput): Promise<Launch> {
    const preparation = this.preparation();
    return Promise.resolve({
      executable: this.context.executable,
      args: [...(preparation?.args ?? []), ...input.agentArgs(input.handover?.files)],
      env: preparation?.env,
    });
  }
}

/**
 * A saved command resolved to the program, arguments and variables a tab starts (the session
 * manager's createCommandTab); `ProjectCommand` (shared/types/project.ts) is the tet.json entry it
 * comes from.
 */
export interface SavedCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * A saved command: always this machine, started as it is — its own program, arguments and
 * variables over the machine's, no agent setup. Only the launch differs from HostPlace.
 */
export class CommandPlace extends HostPlace {
  constructor(
    context: PlaceContext,
    private readonly command: SavedCommand,
  ) {
    super(context, () => undefined);
  }

  override launch(): Promise<Launch> {
    const { executable, args, env } = this.command;
    return Promise.resolve({ executable, args, envOverride: env });
  }
}

/** What the session manager's resolvePlace read before choosing the sandbox, so the launch does not
 *  read it again. */
export interface SbxStart {
  settings: SbxProjectSettings;
  ready: Exclude<Awaited<ReturnType<typeof checkSbxReady>>, { notReady: string }>;
  /** The `ensureRunning` begun alongside the readiness check (SbxRunRequest.warm). */
  warm?: Promise<boolean>;
  /** The window's settings the sandbox setup takes (AgentPaths). */
  idleReminder: boolean;
  theme: AgentPaths["theme"];
  /** This machine's SBX settings for the project (SbxLocalStore). */
  knowledge: SbxKnowledgeSettings;
  secretValues: ReadonlyMap<string, string>;
  variableValues: ReadonlyMap<string, string>;
}

/**
 * The agent's sandbox of the repository or worktree: its name, its folder in `~/.tet` (sandboxDir,
 * the one TET folder it mounts), and its sessions as the host reads them through their mounts —
 * the one place these are derived. Paths are handed at their container path, what lies outside
 * its sight mounted (mountDropped).
 */
export class SandboxPlace implements TabPlace {
  readonly side = SANDBOX_TAB;
  readonly name: string;
  protected readonly agentDir: string;
  /** Undefined where the agent keeps no sessions in a sandbox. */
  private readonly sessions?: SandboxSessionStore;

  constructor(protected readonly context: PlaceContext<SandboxedAgent>) {
    this.name = sandboxName(context.at.ref, context.agent.id);
    this.agentDir = sandboxDir(context.dataRoot, context.at.ref, context.agent.id);
    this.sessions = context.agent.sandbox.sessions?.at(sandboxSessionDir(this.agentDir), toContainerPath(context.at.path), this.agentDir);
  }

  get sandbox(): string {
    return this.name;
  }

  dropsDir(): string {
    return sandboxDropsDir(this.agentDir);
  }

  /** The workspace and the agent folder need no asking; each mount and each refusal is said. */
  async handPaths(hostPaths: string[]): Promise<string[]> {
    const { at, onNotice } = this.context;
    const mounts = await mountDropped(this.name, [at.path, this.agentDir], hostPaths);
    const handed: string[] = [];
    for (const [index, hostPath] of hostPaths.entries()) {
      const mount = mounts[index];
      if ("refused" in mount) {
        onNotice("warning", `${hostPath} was not mounted into ${at.name()}'s SBX sandbox: ${mount.refused}.`);
        continue;
      }
      if ("mounted" in mount) {
        onNotice("info", `${hostPath} is mounted into ${at.name()}'s SBX sandbox, read and write, until TET quits.`);
      }
      handed.push(toContainerPath(hostPath));
    }
    return handed;
  }

  sessionActions(): SessionActions | undefined {
    const { sessions } = this;
    return (
      sessions && {
        remove: (sessionId) => sessions.remove(sessionId),
        rename: (sessionId, title) => sessions.rename(sessionId, title),
        files: (sessionId) => sessions.files(sessionId),
        root: this.agentDir,
      }
    );
  }

  /** Nothing: a sandboxed tab's own output schedules the listing (AgentSandbox.sessions). */
  watchSessions(): undefined {
    return undefined;
  }

  sessionsWatched(): boolean {
    return false;
  }

  /** Its sessions, each named with this sandbox (AgentSessionInfo.sandbox); none where the agent
   *  keeps none in a sandbox. Listed whether or not SBX is enabled: they stay resumable there. */
  async listSessions(): Promise<AgentSessionInfo[]> {
    if (!this.sessions) {
      return [];
    }
    const listed = await this.sessions.list();
    return listed.map((info) => ({ ...info, sandbox: this.name }));
  }

  /** This place for a start that chose it, with what that start read. */
  starting(start: SbxStart): StartingPlace {
    return new SandboxStart(this.context, start);
  }

  /** What AgentSandbox.prepare is handed; the folder is created only when asked for. */
  protected paths(idleReminder: boolean, theme: AgentPaths["theme"]): AgentPaths {
    fs.mkdirSync(this.agentDir, { recursive: true });
    return { agentDir: this.agentDir, idleReminder, theme };
  }

  /** Where the agent's sessions land on the host (AgentSandbox.sessions' mounts). */
  protected sessionMounts(): SbxSessionMount[] {
    const root = sandboxSessionDir(this.agentDir);
    return (this.context.agent.sandbox.sessions?.mounts ?? []).map((mount) => ({
      host: path.join(root, mount.sub),
      target: mount.target,
      file: mount.file,
      within: this.agentDir,
    }));
  }
}

/** The sandbox a start chose (SandboxPlace.starting). */
class SandboxStart extends SandboxPlace implements StartingPlace {
  constructor(
    context: PlaceContext<SandboxedAgent>,
    private readonly start: SbxStart,
  ) {
    super(context);
  }

  /**
   * `sbx run` (prepareSbxRun), tet.json as it stands: what could not be applied is said, one
   * notice per option and reason (sbxProblemNotices). A handover's files are copied into the agent
   * folder, since the other agent's store is out of the sandbox's sight.
   */
  async launch(input: LaunchInput): Promise<Launch> {
    const { at, onNotice, agent } = this.context;
    const { start } = this;
    const paths = this.paths(start.idleReminder, start.theme);
    const hooks = agent.sandbox.prepare(paths);
    const handoverDir = input.handover && sandboxHandoverDir(this.agentDir, input.handover.from, input.handover.sessionId);
    try {
      const files =
        input.handover && handoverDir !== undefined
          ? (await copyInto(input.handover, handoverDir, this.agentDir)).map(toContainerPath)
          : undefined;
      const { args, env, problems } = await prepareSbxRun({
        agent,
        name: this.name,
        ref: at.ref,
        projectRefPath: at.path,
        settings: start.settings,
        knowledge: start.knowledge,
        sandboxes: start.ready.sandboxes,
        organization: start.ready.organization,
        rules: start.ready.rules,
        warm: start.warm,
        paths,
        agentArgs: [...hooks.args, ...input.agentArgs(files)],
        env: agent.sandbox.env ?? [],
        sessionMounts: this.sessionMounts(),
        secretValues: start.secretValues,
        variableValues: start.variableValues,
        onData: input.onData,
      });
      for (const notice of sbxProblemNotices(problems)) {
        onNotice("warning", notice);
      }
      return { executable: "sbx", args, envOverride: env, handoverDir };
    } catch (error) {
      // No tab keeps a copy for a start that failed; a restart copies again.
      if (handoverDir) {
        await fs.promises.rm(handoverDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }
}

/**
 * Copies a handover's files into `dir`, inside the sandbox's `agentDir`, answering the copies' paths.
 * Both sides may be a sandbox's folder, so neither follows a link out of it (openInside): a copy is
 * created anew, never written through what lies at its path.
 */
async function copyInto({ files, within }: HandoverFiles, dir: string, agentDir: string): Promise<string[]> {
  await fs.promises.mkdir(dir, { recursive: true });
  return Promise.all(
    files.map(async (file) => {
      const copy = path.join(dir, path.basename(file));
      const source = within === undefined ? await fs.promises.open(file, "r") : await openInside(within, file, "r");
      try {
        await removeInside(agentDir, copy);
        const target = await openInside(agentDir, copy, "wx");
        try {
          await pipeline(source.createReadStream({ autoClose: false }), target.createWriteStream({ autoClose: false }));
        } finally {
          await target.close();
        }
      } finally {
        await source.close();
      }
      return copy;
    }),
  );
}
