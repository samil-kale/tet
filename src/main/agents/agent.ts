import type { ThemeDefinition } from "../../shared/themes";
import type { HookEvent } from "../../shared/control";
import type { ControlSide } from "../../shared/control-side";
import type { AgentIcon, AgentId, AskModel, SbxKnowledgeEntry, SbxKnowledgeKind } from "../../shared/types";

export interface AgentSessionInfo {
  /** Agent-native session id (Claude: transcript uuid). */
  id: string;
  /** Human-readable label; "" allowed — the UI falls back to a placeholder. */
  title: string;
  /** Last activity, ms since epoch (Claude: transcript mtime). */
  updatedAt: number;
  /** Creation time, ms since epoch — decides tab order. */
  createdAt: number;
  /**
   * `title` stands in for a name the agent hasn't assigned yet (Claude: the first prompt until an
   * agent-name/ai-title lands); reconcile polls such sessions longer.
   */
  provisionalTitle?: boolean;
  /**
   * When the last turn ended, per the agent's own record; undefined where it keeps none. A net
   * under the `stop` hook, which no agent fires for a turn the user cut short. Read only in
   * reconcile, only to end a turn.
   */
  turnEndedAt?: number;
  /**
   * The sbx sandbox this session lives in; unset on the host. Resumable only there (resolvePlace).
   * Set by the sandbox's place on its listing (`SandboxPlace.listSessions`).
   */
  sandbox?: string;
}

/** One host path mounted into a sandbox so an agent's sessions land on the host. Curated subpaths
 *  only, never the one holding the agent's credentials. */
export interface SandboxSessionMount {
  /** The mounted file or directory, under the host root (`sandboxSessionDir`). */
  sub: string;
  /** Absolute container path it is mounted at — where the CLI looks. */
  target: string;
  /** `sub` is a plain file: the host side must exist first, and a file is created differently. */
  file?: boolean;
}

/**
 * How sessions are read out of an sbx sandbox: a host directory bind-mounted where the CLI writes,
 * read by the host transcript code. No `watch`: the sandboxed tab's own output schedules the
 * reconcile.
 */
export interface SandboxSessions {
  mounts: SandboxSessionMount[];
  /** The operations on one sandbox's sessions, bound to the mounted `root` and the sandbox's `cwd`
   *  (`toContainerPath`), since the CLI records container paths. */
  at(root: string, cwd: string): SandboxSessionStore;
}

/** One sandbox's sessions (SandboxSessions.at). */
export interface SandboxSessionStore {
  /** SessionProvider.list against the mounted root; SandboxPlace names the sandbox on the result. */
  list(): Promise<AgentSessionInfo[]>;
  remove(sessionId: string): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  /** SessionProvider.files against the mounted root, as host paths. */
  files(sessionId: string): Promise<string[]>;
}

/** Agent-specific session enumeration/resume/deletion, on this machine. */
export interface SessionProvider {
  /** All sessions of this repository or worktree, oldest first. Must resolve [] on any failure. */
  list(cwd: string): Promise<AgentSessionInfo[]>;
  resumeArgs(sessionId: string): string[];
  /** Deletes the session; rejects on failure. An already-gone session must resolve: a tab whose
   *  removal rejects is put back (TabSessionManager.destroyTab) and could never be closed. `cwd`
   *  may be gone: a deleted worktree's sessions go after its folder (`removeAllSessions`). */
  remove(executable: string, cwd: string, sessionId: string): Promise<void>;
  /** Renames the persisted title; rejects on failure. */
  rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void>;
  /** The files holding the session's transcript, as the agent keeps them, for another agent to
   *  read (a handoff). [] where there are none. */
  files(cwd: string, sessionId: string): Promise<string[]>;
  /** Calls `onChange` when this repository's or worktree's sessions change, so the manager
   *  re-lists without waiting for a tab's output. */
  watch?(cwd: string, onChange: () => void): SessionWatch;
}

/** A running SessionProvider.watch. */
export interface SessionWatch {
  stop(): void;
  /** Whether a watcher is armed now: false while none could be (a store not there yet, `fs.watch`
   *  refused), so a tab's output schedules the listing instead. */
  watching(): boolean;
}

/** What one agent is handed to set itself up for a repository or one of its worktrees. */
export interface AgentPaths {
  /**
   * This agent's folder, already created: to `AgentHost.prepare` the host tabs' setup, one for
   * every project (data-root.ts's agentConfigDir); to `AgentSandbox.prepare` the repository's or
   * worktree's sandbox folder, the one TET folder its sandbox mounts, whole (project-dirs.ts's
   * sandboxDir). Neither side sees the other's.
   */
  agentDir: string;
  /**
   * The one notification setting handed to an agent: every other one is read when a report
   * arrives (session-manager's `toast`), but the idle reminder has no mark, so its hook is only
   * registered when wanted — which is why this switch applies only to tabs started after it.
   */
  idleReminder: boolean;
  /** The window's theme, for agents that are told it rather than reading the terminal's colors. */
  theme: ThemeDefinition;
}

/**
 * Result of AgentHost.prepare, merged into every session the manager starts on this machine.
 * Nothing to close: a setup leaves only files, and reports go over the control channel.
 */
export interface SpawnPreparation {
  args: string[];
  env?: Record<string, string>;
  /**
   * Started instead of the agent's executable when something must run in the pty first (Codex's
   * console-color launcher on win32). Listing, renaming and the version check still use the agent.
   */
  executable?: string;
}

/** What an agent hands a sandboxed tab — see AgentSandbox.prepare. */
interface SandboxPreparation {
  /** Appended after `sbx run`'s own "--". */
  args: string[];
}

/** How TET tells an installed CLI from a missing one. */
export interface AgentInstall {
  /** Tells "not installed" from a spawn that failed otherwise. */
  versionArgs: string[];
  /**
   * The CLI version this definition is tested against (test/agents.test.ts reports a difference).
   * Not read by the app: a newer install is not refused.
   */
  verifiedVersion: string;
}

/** How a coding agent's CLI behaves in a terminal tab — found through the pty for each agent. */
export interface AgentTerminal {
  /**
   * A first prompt, as the last arguments of a new session's first start: the CLI submits it once
   * it is up, past a trust question. Typed into the terminal instead, it can land before the CLI
   * reads input or be taken as a paste, its Enter as a newline.
   */
  initialPromptArgs(prompt: string): string[];
  /**
   * Factory for a fresh per-session "CLI ready yet" check fed each output chunk; once true, the tab
   * strip's progress bar hides. Output reaches the terminal throughout. No CLI signals readiness, so
   * this is a per-agent guess at "the first real frame is drawn".
   */
  createIsSessionReady(): (chunk: string) => boolean;
  /** Ctrl+C presses that make the CLI quit by itself, sent before a kill (TerminalSession.stop). */
  quitPresses: number;
}

/** One question without a terminal, answered on stdout (`askAgent`). */
export interface AgentAsk {
  /** The question arrives on stdin, so these only name the mode — one that leaves no session
   *  behind: a background question must not come back as a tab. */
  args: string[];
  /** The models it can be asked with, as its CLI offers them in `cwd`, in its own order. */
  models(executable: string, cwd: string): Promise<AskModel[]>;
  /** What picks `model` (an `AskModel.id`) for one question, beside `args`. */
  modelArgs(model: string): string[];
}

/** One command line run in a terminal, for a saved command with `"shell": true`. */
export interface AgentRun {
  args(command: string): string[];
}

/** How the agent's hook reports (`tet-ctl hook <event>`) are read. */
export interface AgentTurns {
  /** The session a hook report is about — the only thing binding a new tab to its session: a
   *  listing carries no pid or tab. */
  sessionIdOf(payload: string): string | undefined;
  /**
   * Whether a question still stands after its turn ended: Codex's question lets the turn end while
   * it waits in the composer, so clearing it at turn end would drop the tab's only "wants the user"
   * mark.
   */
  questionOutlivesTurn?: boolean;
  /**
   * Whether a `stop` report leaves the session working: its turn ended, but work it started runs on
   * and reports back in a turn of its own. The tab stays busy, no toast. Omitted: `stop` ends it.
   */
  workOutlivesStop?(payload: string): boolean;
  /**
   * What its hook command prints back into the CLI for a report (`tet-ctl hook <event>`) — the
   * CLI's own contract, per event. Omitted: nothing, for an agent that reports without a hook
   * command (pi's extension).
   */
  hookReply?(event: HookEvent, side: ControlSide): string;
}

/** The agent's setup for host tabs (HostSetups, HostPlace). */
export interface AgentHost {
  /**
   * Setup before any session spawns: hooks, settings, plugins, and how TET's system prompt
   * (system-prompt.ts) reaches the model — the only place an agent may write configuration. The
   * same for every project, so it knows none (data-root.ts's agentConfigDir). A rejection marks the
   * agent unstartable, so reject only for what makes it unusable; a failed optional write is
   * swallowed.
   */
  prepare(executable: string, paths: AgentPaths): Promise<SpawnPreparation>;
}

/** Everything the agent needs to run in an sbx sandbox (SandboxPlace, sbx.ts). */
export interface AgentSandbox {
  /**
   * AgentHost.prepare for the sandbox: generated for POSIX regardless of the host's platform, paths
   * in the sandbox's view (`SANDBOX_TARGET`, hook-target.ts). Hooks report over the control
   * channel, so the host shows the toast.
   *
   * Returns args after `sbx run`'s "--"; constants for its environment go in `env`. No executable
   * override: the sandbox's bundled binary runs. Synchronous.
   */
  prepare(paths: AgentPaths): SandboxPreparation;
  /** "KEY=VALUE" for `sbx run -e`, for facts that differ only inside the sandbox. */
  env?: string[];
  /**
   * The agent's shareable knowledge on the host, per `SbxKnowledgeKind` — never its config
   * directory (sbx-mounts.ts's fixedMountSpecs). Targets under `SANDBOX_HOME`; a chosen skills
   * folder goes at the `skills` targets. sbx-mounts.ts drops paths that do not exist, and all of it
   * while the agent is not installed on this host.
   */
  knowledge(): Record<SbxKnowledgeKind, SbxKnowledgeEntry[]>;
  /**
   * Absolute container path where the sandboxed CLI reads `~/.agents/skills`, the skills folder no
   * agent owns: mounted whether or not the agent is installed here, unless one of its own skills
   * folders already takes that target (sbx-mounts.ts's sandboxKnowledgeFor). Omitted by an agent
   * that does not read that folder — tet never stands it in for one the CLI does read.
   */
  sharedSkillsTarget?: string;
  /**
   * `sbx create`'s agent argument where it is not the agent id: a kit sbx does not ship. Only
   * `create` takes it; `sbx run` reattaches by `--name` with the plain id. Omitted for a built-in kit.
   */
  kit?: string;
  /** Its sessions, read on the host through mounts. Omitted where it keeps none. */
  sessions?: SandboxSessions;
}

/**
 * Everything the shared terminal layer needs to run one agent, so it never imports an agent's
 * own code. Each group is present whole or not at all: what an agent can do is which groups it
 * has, and the shell has none but `run`. `turns` only with `sessions`: a hook report binds a tab to
 * a session.
 */
export type AgentDefinition = AgentBase &
  (
    | {
        /** Listing, resume args, rename, delete, files, optional watch. */
        sessions: SessionProvider;
        /** Omitted by an agent whose turns TET does not follow. */
        turns?: AgentTurns;
      }
    /** An agent with no sessions. */
    | { sessions?: undefined; turns?: undefined }
  );

interface AgentBase {
  /** Its registry key, which names its folders under `~/.tet` (`config/<agent>`, a sandbox's
   *  `<agent>`) and its tabs' `agentId`: never changed once released. */
  id: AgentId;
  /** Its name wherever the user reads it: menus, notices, dialogs. */
  displayName: string;
  /** Drawn by the window beside its tabs and menu entries (AgentInfo.icon). */
  icon: AgentIcon;
  /** A path as one word typed into its input (a paste, a drop): what its input field or shell reads
   *  as that path and nothing else. */
  quotePath(path: string): string;
  /** Resolved at spawn time: the shell's executable depends on the platform. */
  executable(): string;
  /** Omitted where the CLI always exists (the shell). */
  install?: AgentInstall;
  /** Omitted by the shell. */
  terminal?: AgentTerminal;
  /** Only the shell has it. */
  run?: AgentRun;
  /** Omitted by an agent that cannot answer without a terminal. */
  ask?: AgentAsk;
  /** Omitted by an agent needing no setup (the shell). */
  host?: AgentHost;
  /** Omitted by an agent that never runs in a sandbox (the shell). */
  sandbox?: AgentSandbox;
}

/** An agent that runs in an sbx sandbox. */
export type SandboxedAgent = AgentDefinition & { sandbox: AgentSandbox };

export function hasSandbox(agent: AgentDefinition): agent is SandboxedAgent {
  return agent.sandbox !== undefined;
}
