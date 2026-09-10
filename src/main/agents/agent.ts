import type { ThemeDefinition } from "../../shared/themes";
import type { AgentId } from "../../shared/types";

export interface AgentSessionInfo {
  /** Agent-native session id (Claude: transcript uuid; opencode: "ses_..."). */
  id: string;
  /** Human-readable label; "" allowed — the UI falls back to a placeholder. */
  title: string;
  /** Last activity, ms since epoch (Claude: transcript mtime; opencode: `updated`). */
  updatedAt: number;
  /** Creation time, ms since epoch — determines tab order, independent of `updatedAt`. */
  createdAt: number;
  /**
   * True while `title` stands in for a name the agent hasn't assigned yet (Claude: the first
   * prompt until an agent-name/ai-title lands, which can arrive after the CLI has gone quiet).
   * The manager keeps polling such sessions a while longer — see reconcile.
   */
  provisionalTitle?: boolean;
  /**
   * When this session's last turn ended, ms since epoch, per the agent's own record; undefined
   * where it keeps none. A net under the `stop` hook for the ends that signal cannot
   * carry (Claude Code runs no Stop hook for a turn the user cut short). Read only in reconcile,
   * only to end a turn.
   */
  turnEndedAt?: number;
  /**
   * The sbx sandbox this session lives in, by name; unset on the host. Such a session can only
   * be resumed there (resolveSbxRun). Set by the session manager on everything a
   * `SessionProvider.sandbox` listing returns, and by opencode's provider from its plugin's records.
   */
  sandbox?: string;
}

/** One host path tet mounts into a sandbox so an agent's sessions land on the host — see SessionProvider.sandbox. */
export interface SandboxSessionMount {
  /** Under the host root (`sandboxSessionDir`), the file or directory that is mounted. */
  sub: string;
  /** The absolute container path it is mounted at — where this agent's CLI looks. */
  target: string;
  /** Whether `sub` is a plain file: sbx mounts either, but the host side must exist first and
   *  the two are created differently. */
  file?: boolean;
}

/**
 * How an agent's sessions are read back out of an sbx sandbox: a host directory bind-mounted
 * at the path the CLI writes to (stacks even over sbx's own volume, see `mounts`), read by the
 * same code that reads a host transcript. Every method takes the mounted host `root` and the
 * sandbox's own `cwd` (`toContainerPath`), because the CLI wrote container paths into its records.
 * Without it a sandboxed tab gets no session id, hence no resume, title or turn marks.
 *
 * No `watch` counterpart: the host one notices transcripts the tab's output never announced,
 * and a sandboxed tab's CLI is the one filling the mounted tree, so its output already
 * schedules the reconcile.
 */
export interface SandboxSessions {
  /** Everything that has to be mounted for this agent's sessions to land on the host. */
  mounts: SandboxSessionMount[];
  /** SessionProvider.list against the mounted root, for the sandbox's own cwd. The manager
   *  names the sandbox on what comes back. */
  list(executable: string, root: string, cwd: string): Promise<AgentSessionInfo[]>;
  /** SessionProvider.remove against the mounted root. */
  remove(executable: string, root: string, cwd: string, sessionId: string): Promise<void>;
  /** SessionProvider.rename against the mounted root. */
  rename(executable: string, root: string, cwd: string, sessionId: string, title: string): Promise<void>;
}

/** Agent-specific session enumeration/resume/deletion; lives in the agent's own folder. */
export interface SessionProvider {
  /** All sessions of this repository, in creation order (oldest first). Must resolve [] on any failure. */
  list(executable: string, cwd: string): Promise<AgentSessionInfo[]>;
  /** CLI args that open the given session. */
  resumeArgs(sessionId: string): string[];
  /** Permanently deletes the session. Rejects on failure (caller surfaces the error). */
  remove(executable: string, cwd: string, sessionId: string): Promise<void>;
  /** Renames the session's persisted title. Rejects on failure (caller surfaces the error). */
  rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void>;
  /**
   * Optional: calls `onChange` whenever this repository's sessions change, so the manager
   * re-lists at once instead of waiting out its polling. Returns a stop function, called on shutdown.
   */
  watch?(executable: string, cwd: string, onChange: () => void): () => void;
  /**
   * How this agent's sandboxed sessions are read — see SandboxSessions. Omitted where they
   * already come back from `list` (opencode) or the agent cannot be sandboxed.
   */
  sandbox?: SandboxSessions;
}

/**
 * What one agent is handed to set itself up for one repository: where it may write, and the
 * one thing it reports back out of band.
 */
export interface AgentPaths {
  /**
   * This agent's own scratch directory for this repository, already created. Per repository,
   * since what is generated in there (hook settings, a plugin, its records) is that repository's.
   */
  agentDir: string;
  /**
   * The repository's context file, kept current by tet — the agent only arranges for it to
   * reach the model. Blank whenever there is nothing to say.
   */
  contextFile: string;
  /**
   * The files the context file points at rather than inlining. They sit outside the
   * repository, so an agent that gates reads by path has to grant these explicitly.
   */
  contextReadPaths: string[];
  /** TET's user-data root, for anything an agent has to install machine-wide. */
  storageRoot: string;
  /**
   * Whether the idle reminder is wanted. The one notification setting an agent is handed:
   * every other one is read when the report arrives (session-manager's `toast`), but this one
   * has no mark behind it, so a hook registered for it would start a process per idle prompt
   * only to have the answer thrown away. Registered or not, therefore — which is why this one
   * switch reaches a project only through a tab started after it.
   */
  idleReminder: boolean;
  /**
   * The window's color theme, handed over the same way: an agent that cannot read the terminal's
   * colors (Codex on win32 reads the console's) is told them at setup.
   */
  theme: ThemeDefinition;
}

/**
 * Result of an agent's async spawn preparation — see AgentDefinition.prepareSpawn. `args`
 * and `env` are merged into every session the manager starts. Nothing to close: what a setup
 * leaves behind is files, and what an agent reports it reports over the control channel.
 */
export interface SpawnPreparation {
  args: string[];
  env?: Record<string, string>;
  /**
   * What to start instead of the agent's own executable when something has to run inside the
   * pty before it (Codex's console-color launcher on win32). Only the terminal's process takes
   * it; listing, renaming and the version check still go to the agent itself.
   */
  executable?: string;
}

/** What an agent hands a sandboxed tab — see AgentDefinition.prepareSandboxSpawn. */
export interface SandboxPreparation {
  /** Extra CLI arguments, appended after `sbx run`'s own "--". */
  args: string[];
  /**
   * Environment for the sandboxed process, passed as `sbx run -e KEY=VALUE`, in container
   * paths. Only for what is decided per repository; a constant belongs in `sandboxEnv`.
   */
  env?: Record<string, string>;
}

/**
 * Everything the shared terminal layer needs to run one agent. Agent-specific behaviour
 * stays behind these callbacks so the shared layer never imports an agent's own code.
 */
export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  /** Resolved at spawn time, since the shell's executable depends on the platform. */
  executable(): string;
  /**
   * Args that make the executable report its version, to tell "not installed" from a spawn
   * that failed for another reason. Omitted for agents that always exist (the shell).
   */
  versionArgs?: string[];
  /**
   * Args that put one question to the agent without a terminal, answered on stdout. The
   * question arrives on stdin (see `askAgent`), so these name the mode and nothing else.
   * Omitted for an agent that cannot be asked anything (the shell).
   */
  askArgs?: string[];
  /**
   * Args that hand one command to this agent in a terminal, ending when it does. Only the
   * shell has it, and only a saved command with `"shell": true` uses it.
   */
  runArgs?: (command: string) => string[];
  /**
   * Removes what `askArgs` left behind, for an agent that persists a session either way — a
   * background question must not come back as a tab on the next start.
   */
  cleanupAsk?: (executable: string, cwd: string) => Promise<void>;
  /** Session enumeration/resume/deletion; a missing provider means "this agent has no sessions". */
  sessions?: SessionProvider;
  /**
   * Whether this agent's own end-of-turn payload says the turn is not over after all, so the
   * `stop` hook leaves no mark: Claude Code runs Stop for a turn that merely launched a
   * background job and lists it in `background_tasks`. The raw payload, parsed by the one agent
   * that knows its shape. Omitted where an end is always an end (Codex reports a subagent
   * through `SubagentStop`, which tet does not hook; opencode and pi have no such event).
   */
  holdsTurnEnd?: (payload: string) => boolean;
  /**
   * Async setup before any session of this agent is spawned: generated hooks, settings files,
   * plugins, and however the repository's context file reaches the model (see AgentPaths).
   * A rejection marks the agent unstartable, so a failed optional write (a notification script)
   * is swallowed, never rethrown.
   */
  prepareSpawn?: (executable: string, cwd: string, paths: AgentPaths) => Promise<SpawnPreparation>;
  /**
   * prepareSpawn's hook wiring for an sbx sandbox: generated for a POSIX host regardless of
   * `process.platform`, every embedded path in the sandbox's own view (`SANDBOX_TARGET` in
   * hook-target.ts). What the hooks report goes over the control channel like a host tab's, so
   * the toast is shown by the host process, the one with a desktop session.
   *
   * Returns the extra CLI arguments after `sbx run`'s "--" and, where the setup is pointed at
   * by a variable, the environment for it. No executable override: the sandbox's own bundled
   * binary runs. `cwd` is the project's host path (for a notify message's repository name);
   * `sandbox` its name (AgentSessionInfo.sandbox). Synchronous. Omitted by the shell.
   */
  prepareSandboxSpawn?: (cwd: string, paths: AgentPaths, sandbox: string) => SandboxPreparation;
  /**
   * "KEY=VALUE" entries passed as `sbx run -e`, for a fact that only differs inside the
   * sandbox. Claude Code's fullscreen rollout reads feature flags from `statsig.anthropic.com`,
   * which the per-sandbox `kit:` policy rule does not allow (measured: `sbx policy ls --type
   * network` lists it only for the global default-ai-services rule), so a sandboxed session
   * falls back to the classic renderer; `CLAUDE_CODE_NO_FLICKER=1` forces fullscreen regardless
   * (code.claude.com/docs/en/fullscreen).
   */
  sandboxEnv?: string[];
  /**
   * Completes a url the agent's TUI wrapped across rows, from the agent's own record of what
   * it printed — in the buffer such a row cannot be told from one that merely ends in a url
   * (opencode breaks a long token at the last "." that fits). Returns the full url starting
   * with `prefix`, or undefined; the renderer then keeps the fragment.
   *
   * Called only when the user holds the modifier over such a url, at most once per fragment,
   * so it may go over HTTP and may reject — the one caller reads a rejection as "nothing known".
   */
  resolveUrlPrefix?: (executable: string, cwd: string, sessionId: string, prefix: string) => Promise<string | undefined>;
  /**
   * A factory (not the predicate itself) for the "is this session's CLI ready yet" check, so
   * each session gets a fresh one. It sees each output chunk and the ms since the session
   * started; once true, the progress bar under the tab strip hides. Output flows to the
   * terminal throughout — some CLIs query it for capabilities at start and need a timely answer.
   *
   * There is no real readiness signal, so this is a per-agent guess at undocumented output
   * behaviour. Omitted for agents that are up as soon as spawned (the shell).
   */
  createIsSessionReady?: () => (chunk: string) => boolean;
  /**
   * Ctrl+C presses that make this CLI quit by itself, so tet can ask before it kills
   * (TerminalSession.stop). Measured per agent: Claude Code and pi 2 (the second well inside
   * the ~1 s "press again" window), Codex and opencode 1 — and a second byte to a Codex already
   * leaving lands after it left raw mode, where ConPTY turns it into a CTRL_C_EVENT that kills
   * the shutdown. Omitted for the shell, whose Ctrl+C is a plain SIGINT.
   */
  quitPresses?: number;
  /**
   * Whether this agent's TUI takes the right mouse button itself through mouse reporting
   * (Claude Code pastes, opencode copies the selection). Where it does not — the shell, and
   * Codex (github.com/openai/codex#8344) — tet supplies the terminal convention itself: copy a
   * selection, or paste when there is none (terminal-views.ts).
   */
  takesRightMouse?: boolean;
  /**
   * opencode's TUI under `"theme": "system"` (tui-config.ts) draws blue and magenta swapped
   * relative to VS Code's terminal palette (observed, not derived); buildXtermTheme in theme.ts
   * swaps them back in the palette this agent's terminals are handed.
   */
  swapsBlueMagenta?: boolean;
}
