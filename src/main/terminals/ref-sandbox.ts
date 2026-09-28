import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentPaths, AgentSessionInfo, SandboxedAgent } from "../agents/agent";
import { sandboxDir } from "../project-dirs";
import type { ResolvedRef } from "../resolved-ref";
import { sandboxName } from "../sbx";
import { sandboxSessionDir, toContainerPath } from "./hook-target";
import type { SessionActions } from "./tab-place";

/** A session mount with its host side resolved (SbxRunRequest.sessionMounts). */
export interface ResolvedSessionMount {
  host: string;
  target: string;
  file?: boolean;
}

/**
 * One agent's sandbox of one repository or worktree: its name, its folder in `~/.tet` (the one TET
 * folder it mounts, sandboxDir), and its sessions as the host reads them through their mounts. The
 * one place these are derived — the session manager and SandboxPlace only ask it.
 */
export class RefSandbox {
  readonly name: string;
  readonly agentDir: string;

  constructor(
    readonly at: ResolvedRef,
    storageRoot: string,
    readonly agent: SandboxedAgent
  ) {
    this.name = sandboxName(at.ref, agent.id);
    this.agentDir = sandboxDir(storageRoot, at.ref, agent.id);
  }

  /** The repository or worktree as the sandboxed CLI records it. */
  private cwd(): string {
    return toContainerPath(this.at.path);
  }

  /** What AgentSandbox.prepare is handed; the folder is created only when asked for. */
  paths(idleReminder: boolean, theme: AgentPaths["theme"]): AgentPaths {
    fs.mkdirSync(this.agentDir, { recursive: true });
    return { agentDir: this.agentDir, idleReminder, theme };
  }

  /** Its sessions, each named with this sandbox (AgentSessionInfo.sandbox); none where the agent
   *  keeps none in a sandbox. Listed whether or not sandboxing is on: they stay resumable there. */
  async listSessions(): Promise<AgentSessionInfo[]> {
    const sessions = this.agent.sandbox.sessions;
    if (!sessions) {
      return [];
    }
    const listed = await sessions.list(sandboxSessionDir(this.agentDir), this.cwd());
    return listed.map((info) => ({ ...info, sandbox: this.name }));
  }

  /** The operations on a session living here; undefined where the agent keeps none here. */
  sessionActions(): SessionActions | undefined {
    const sessions = this.agent.sandbox.sessions;
    if (!sessions) {
      return undefined;
    }
    const root = sandboxSessionDir(this.agentDir);
    const cwd = this.cwd();
    return {
      remove: (sessionId) => sessions.remove(root, cwd, sessionId),
      rename: (sessionId, title) => sessions.rename(root, cwd, sessionId, title),
      files: (sessionId) => sessions.files(root, cwd, sessionId)
    };
  }

  /** Where the agent's sessions land on the host (AgentSandbox.sessions' mounts). */
  sessionMounts(): ResolvedSessionMount[] {
    const root = sandboxSessionDir(this.agentDir);
    return (this.agent.sandbox.sessions?.mounts ?? []).map((mount) => ({
      host: path.join(root, mount.sub),
      target: mount.target,
      file: mount.file
    }));
  }
}
