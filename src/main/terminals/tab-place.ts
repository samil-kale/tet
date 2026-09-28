import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentDefinition, AgentPaths, SpawnPreparation } from "../agents/agent";
import { sbxProblemNotices } from "../../shared/sbx-rules";
import type { AgentId, NoticeSeverity, SbxKnowledgeConfig, SbxProjectConfig } from "../../shared/types";
import { dropsDir } from "../project-dirs";
import type { ResolvedRef } from "../resolved-ref";
import { type checkSbxReady, mountDropped, prepareSbxRun } from "../sbx";
import { sandboxDropsDir, sandboxHandoffDir, toContainerPath } from "./hook-target";
import type { RefSandbox } from "./ref-sandbox";

/** A tab's session operations, bound to where its session lives. */
export interface SessionActions {
  remove(sessionId: string): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  files(sessionId: string): Promise<string[]>;
}

/** Another agent's session a new tab takes over: its transcript on the host (SessionProvider.files). */
export interface HandoffFiles {
  from: AgentId;
  sessionId: string;
  files: string[];
}

/** What a start hands its place. */
export interface LaunchInput {
  /** The agent's arguments after its setup's: resume, a saved command's and the first prompt, the
   *  prompt naming a handoff's files as `files` gives them. */
  agentArgs(files: string[] | undefined): string[];
  handoff?: HandoffFiles;
  /** Setup output, forwarded live to the tab. */
  onData(data: string): void;
}

/** What a tab's process is started with (TerminalSession). */
export interface Launch {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  /** Over the machine's variables. */
  envOverride?: Record<string, string>;
  sandboxed: boolean;
  /** A handoff's copy this start made for the tab alone, deleted with it. */
  handoffDir?: string;
}

/**
 * Where a tab's process runs — this machine, or the repository's or worktree's sandbox — and
 * everything that differs between the two. Decided once per start (the session manager's
 * resolvePlace), or by where a tab's session lives until then. Nothing outside a place asks which
 * one it is: a new difference is a member here, implemented by both (HostPlace, SandboxPlace).
 */
export interface TabPlace {
  /** A host path as the tab's process sees it. */
  embed(hostPath: string): string;
  /** Where the tab's pasted or dropped content without a path is written. */
  dropsDir(): string;
  /** Pasted or dropped paths of this machine as the tab types them; a refused one is left out. */
  handPaths(hostPaths: string[]): Promise<string[]>;
  /** The operations on a session living here; undefined where the agent keeps none here. */
  sessionActions(): SessionActions | undefined;
}

/** A place a start resolved, which can start the tab's process. */
export interface StartingPlace extends TabPlace {
  launch(input: LaunchInput): Promise<Launch>;
}

/** What both places are built from: one agent's tabs in one repository or worktree. */
export interface PlaceContext {
  at: ResolvedRef;
  storageRoot: string;
  agent: AgentDefinition;
  /** The agent's host executable (AgentDefinition.executable), for its session operations too. */
  executable: string;
  onNotice(severity: NoticeSeverity, message: string): void;
}

/** This machine: paths as they are, the host setup's spawn (HostSetups). */
export class HostPlace implements StartingPlace {
  constructor(
    private readonly context: PlaceContext,
    /** HostSetups.preparation, read at launch: a setup may be redone meanwhile. */
    private readonly preparation: () => SpawnPreparation | undefined
  ) {}

  embed(hostPath: string): string {
    return hostPath;
  }

  dropsDir(): string {
    return dropsDir(this.context.storageRoot, this.context.at.ref.projectId);
  }

  handPaths(hostPaths: string[]): Promise<string[]> {
    return Promise.resolve(hostPaths);
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
      files: (sessionId) => sessions.files(at.path, sessionId)
    };
  }

  /** A handoff's files are read where the other agent keeps them. */
  launch(input: LaunchInput): Promise<Launch> {
    const preparation = this.preparation();
    return Promise.resolve({
      executable: preparation?.executable ?? this.context.executable,
      args: [...(preparation?.args ?? []), ...input.agentArgs(input.handoff?.files)],
      env: preparation?.env,
      sandboxed: false
    });
  }
}

/**
 * The agent's sandbox of the repository or worktree (RefSandbox), which sees of `~/.tet` only its
 * agent folder: paths at their container path, what lies outside its sight mounted
 * (mountDropped), sessions through their mounts.
 */
export class SandboxPlace implements TabPlace {
  constructor(
    protected readonly context: PlaceContext,
    protected readonly sandbox: RefSandbox
  ) {}

  embed(hostPath: string): string {
    return toContainerPath(hostPath);
  }

  dropsDir(): string {
    return sandboxDropsDir(this.sandbox.agentDir);
  }

  /** Each mount and each refusal is said, once per path. */
  async handPaths(hostPaths: string[]): Promise<string[]> {
    const { at, onNotice } = this.context;
    const handed: string[] = [];
    for (const hostPath of hostPaths) {
      const mount = await mountDropped(this.sandbox.name, at.path, hostPath);
      if ("refused" in mount) {
        onNotice("warning", `${hostPath} was not mounted into ${at.name()}'s SBX sandbox: ${mount.refused}.`);
        continue;
      }
      if ("mounted" in mount) {
        onNotice("info", `${hostPath} is mounted into ${at.name()}'s SBX sandbox, read and write, until TET quits.`);
      }
      handed.push(this.embed(hostPath));
    }
    return handed;
  }

  sessionActions(): SessionActions | undefined {
    return this.sandbox.sessionActions();
  }
}

/** What the session manager's resolvePlace read before choosing the sandbox, so the launch does not
 *  read it again. */
export interface SbxStart {
  config: SbxProjectConfig;
  ready: Exclude<Awaited<ReturnType<typeof checkSbxReady>>, { notReady: string }>;
  /** The `ensureRunning` begun alongside the readiness check (SbxRunRequest.warm). */
  warm?: Promise<boolean>;
  /** The window's settings the sandbox setup takes (AgentPaths). */
  idleReminder: boolean;
  theme: AgentPaths["theme"];
  /** This machine's sbx values for the project (SbxLocalStore). */
  knowledge: SbxKnowledgeConfig;
  secretValues: ReadonlyMap<string, string>;
  variableValues: ReadonlyMap<string, string>;
}

/** The sandbox a start chose, with what that start read. */
export class SandboxStart extends SandboxPlace implements StartingPlace {
  constructor(
    context: PlaceContext,
    sandbox: RefSandbox,
    private readonly start: SbxStart
  ) {
    super(context, sandbox);
  }

  /**
   * `sbx run` (prepareSbxRun), tet.json as it stands: what could not be applied is said, one
   * notice per option and reason (sbxProblemNotices). A handoff's files are copied into the agent
   * folder, since the other agent's store is out of the sandbox's sight.
   */
  async launch(input: LaunchInput): Promise<Launch> {
    const { at, onNotice } = this.context;
    const { agent, agentDir } = this.sandbox;
    const paths = this.sandbox.paths(this.start.idleReminder, this.start.theme);
    const hooks = agent.sandbox.prepare(paths);
    const handoffDir = input.handoff && sandboxHandoffDir(agentDir, input.handoff.from, input.handoff.sessionId);
    try {
      const files =
        input.handoff && handoffDir !== undefined
          ? (await copyInto(input.handoff.files, handoffDir)).map((file) => this.embed(file))
          : undefined;
      const { args, env, problems } = await prepareSbxRun({
        agent,
        ref: at.ref,
        projectRefPath: at.path,
        config: this.start.config,
        knowledge: this.start.knowledge,
        sandboxes: this.start.ready.sandboxes,
        organization: this.start.ready.organization,
        rules: this.start.ready.rules,
        warm: this.start.warm,
        paths,
        agentArgs: [...hooks.args, ...input.agentArgs(files)],
        env: agent.sandbox.env ?? [],
        sessionMounts: this.sandbox.sessionMounts(),
        secretValues: this.start.secretValues,
        variableValues: this.start.variableValues,
        onData: input.onData
      });
      for (const notice of sbxProblemNotices(problems)) {
        onNotice("warning", notice);
      }
      return { executable: "sbx", args, envOverride: env, sandboxed: true, handoffDir };
    } catch (error) {
      // No tab keeps a copy for a start that failed; a restart copies again.
      if (handoffDir) {
        await fs.promises.rm(handoffDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }
}

/** Copies `files` into `dir`, answering the copies' paths. */
async function copyInto(files: string[], dir: string): Promise<string[]> {
  await fs.promises.mkdir(dir, { recursive: true });
  return Promise.all(
    files.map(async (file) => {
      const copy = path.join(dir, path.basename(file));
      await fs.promises.copyFile(file, copy);
      return copy;
    })
  );
}
