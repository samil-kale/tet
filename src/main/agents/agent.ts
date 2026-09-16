import type { ThemeDefinition } from "../../shared/themes";
import type { AgentId, SbxKnowledgeConfig } from "../../shared/types";

export interface AgentSessionInfo {
  /** Agent-native session id (Claude: transcript uuid; opencode: "ses_..."). */
  id: string;
  /** Human-readable label; "" allowed — the UI falls back to a placeholder. */
  title: string;
  /** Last activity, ms since epoch (Claude: transcript mtime; opencode: `updated`). */
  updatedAt: number;
  /** Creation time, ms since epoch — decides tab order. */
  createdAt: number;
  /**
   * `title` stands in for a name the agent hasn't assigned yet (Claude: the first prompt until an
   * agent-name/ai-title lands, possibly after the CLI went quiet); reconcile polls such sessions longer.
   */
  provisionalTitle?: boolean;
  /**
   * When the last turn ended, per the agent's own record; undefined where it keeps none. A net
   * under the `stop` hook (no agent's hook fires for a turn the user cut short). Read only in
   * reconcile, only to end a turn.
   */
  turnEndedAt?: number;
  /**
   * The sbx sandbox this session lives in; unset on the host. Resumable only there (resolveSbxRun).
   * Set by the manager on a `SessionProvider.sandbox` listing, and by opencode from its plugin's records.
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
 * How sessions are read out of an sbx sandbox: a host directory bind-mounted where the CLI writes
 * (stacks even over sbx's own volume), read by the host transcript code. Every method takes the
 * mounted `root` and the sandbox's `cwd` (`toContainerPath`), since the CLI records container
 * paths. Without it a sandboxed tab gets no session id: no resume, title or turn marks.
 *
 * No `watch`: the sandboxed tab's own output already schedules the reconcile.
 */
export interface SandboxSessions {
  mounts: SandboxSessionMount[];
  /** SessionProvider.list against the mounted root; the manager names the sandbox on the result. */
  list(executable: string, root: string, cwd: string): Promise<AgentSessionInfo[]>;
  remove(executable: string, root: string, cwd: string, sessionId: string): Promise<void>;
  rename(executable: string, root: string, cwd: string, sessionId: string, title: string): Promise<void>;
}

/** Agent-specific session enumeration/resume/deletion. */
export interface SessionProvider {
  /** All sessions of this repository, oldest first. Must resolve [] on any failure. */
  list(executable: string, cwd: string): Promise<AgentSessionInfo[]>;
  resumeArgs(sessionId: string): string[];
  /** Deletes the session; rejects on failure. An already-gone session must resolve: a tab whose
   *  removal rejects is put back (ProjectSessionManager.destroyTab) and could never be closed. */
  remove(executable: string, cwd: string, sessionId: string): Promise<void>;
  /** Renames the persisted title; rejects on failure. */
  rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void>;
  /** Calls `onChange` when this repository's sessions change, so the manager re-lists without
   *  waiting for its poll. Returns a stop function. */
  watch?(executable: string, cwd: string, onChange: () => void): () => void;
  /** Omitted where sandboxed sessions already come back from `list` (opencode) or there are none. */
  sandbox?: SandboxSessions;
}

/** What one agent is handed to set itself up for one repository. */
export interface AgentPaths {
  /** This agent's scratch directory for this repository, already created. */
  agentDir: string;
  /** TET's data folder (`~/.tet`, data-root.ts), for anything installed machine-wide. */
  storageRoot: string;
  /**
   * The one notification setting handed to an agent: every other one is read when a report
   * arrives (session-manager's `toast`), but the idle reminder has no mark, so its hook is only
   * registered when wanted — which is why this switch applies only to tabs started after it.
   */
  idleReminder: boolean;
  /** The window's theme, for an agent that cannot read the terminal's colors (Codex on win32). */
  theme: ThemeDefinition;
}

/**
 * Result of AgentDefinition.prepareSpawn, merged into every session the manager starts. Nothing to
 * close: a setup leaves only files, and reports go over the control channel.
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

/** One piece of the agent's host knowledge, and where the sandboxed CLI reads it. */
export interface SandboxKnowledgeEntry {
  host: string;
  /** Absolute container path, under `SANDBOX_HOME`. */
  target: string;
}

/** What an agent hands a sandboxed tab — see AgentDefinition.prepareSandboxSpawn. */
export interface SandboxPreparation {
  /** Appended after `sbx run`'s own "--". */
  args: string[];
  /** `sbx run -e KEY=VALUE`, in container paths; per repository only — constants go in `sandboxEnv`. */
  env?: Record<string, string>;
}

/**
 * Everything the shared terminal layer needs to run one agent, so it never imports an agent's
 * own code.
 */
export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  /** Resolved at spawn time: the shell's executable depends on the platform. */
  executable(): string;
  /** Tells "not installed" from a spawn that failed otherwise. Omitted where it always exists (the shell). */
  versionArgs?: string[];
  /**
   * The CLI version test/agents.test.ts last passed against, on a signed-in machine: every measured
   * value in this definition held there. Read by nothing in the app — a newer install is not
   * refused; the test reports the difference. Omitted by the shell.
   */
  verifiedVersion?: string;
  /**
   * One question without a terminal, answered on stdout. The question arrives on stdin
   * (`askAgent`), so these only name the mode. Omitted by the shell.
   */
  askArgs?: string[];
  /** One command run in a terminal; only the shell has it, for a saved command with `"shell": true`. */
  runArgs?: (command: string) => string[];
  /**
   * Removes what `askArgs` left behind, for an agent that persists a session either way — a
   * background question must not come back as a tab.
   */
  cleanupAsk?: (executable: string, cwd: string) => Promise<void>;
  /** Listing, resume args, rename, delete, optional watch. Missing means "this agent has no sessions". */
  sessions?: SessionProvider;
  /**
   * Whether the raw end-of-turn payload says the turn is not over, so `stop` leaves no mark: Claude
   * Code runs Stop for a turn that merely launched a background job (`background_tasks`). Omitted
   * where an end is always an end (Codex reports subagents via unhooked `SubagentStop`; opencode
   * and pi have no such event).
   */
  holdsTurnEnd?: (payload: string) => boolean;
  /**
   * The session a hook report is about — the only thing binding a new tab to its session. A
   * listing carries no pid or tab, and a CLI persists its session at the first prompt, so of two
   * new tabs the one typed into first would hand its session to the other. Omitted without sessions.
   */
  sessionIdOf?: (payload: string) => string | undefined;
  /**
   * Whether a question still stands after its turn ended. Claude Code's `AskUserQuestion` blocks
   * its turn. Codex's does not (measured, 0.154.0: `request_user_input_async` answers
   * `{"accepted":true}` at once, the turn ends, the question waits queued in the composer), so
   * clearing it at turn end would drop the tab's only "wants the user" mark.
   */
  questionOutlivesTurn?: boolean;
  /**
   * Setup before any session spawns: hooks, settings, plugins, and how TET's system prompt
   * (system-prompt.ts) reaches the model — the only place an agent may write anything. A rejection
   * marks the agent unstartable, so reject only for what truly makes it unusable; a failed optional
   * write (an extension, a theme file) is swallowed.
   */
  prepareSpawn?: (executable: string, cwd: string, paths: AgentPaths) => Promise<SpawnPreparation>;
  /**
   * prepareSpawn for an sbx sandbox: generated for POSIX regardless of `process.platform`, paths in
   * the sandbox's view (`SANDBOX_TARGET`, hook-target.ts). Hooks report over the control channel,
   * so the host shows the toast.
   *
   * Returns args after `sbx run`'s "--" and, where the setup is found through a variable, its env.
   * No executable override: the sandbox's bundled binary runs. `cwd` is the host path (scopes
   * opencode's plugin); `sandbox` its name. Synchronous. Omitted by the shell.
   */
  prepareSandboxSpawn?: (cwd: string, paths: AgentPaths, sandbox: string) => SandboxPreparation;
  /**
   * "KEY=VALUE" for `sbx run -e`, for facts that differ only inside the sandbox. Claude Code's
   * fullscreen rollout reads flags from `statsig.anthropic.com`, which the per-sandbox `kit:` rule
   * does not allow (measured: `sbx policy ls --type network` lists it only for the global
   * default-ai-services rule), so it falls back to the classic renderer; `CLAUDE_CODE_NO_FLICKER=1`
   * forces fullscreen (code.claude.com/docs/en/fullscreen).
   */
  sandboxEnv?: string[];
  /**
   * The agent's shareable knowledge on the host, per `SbxKnowledgeConfig` kind — never its config
   * directory (sbx.ts's fixedMountSpecs). sbx.ts drops paths that do not exist. Omitted by the shell.
   */
  sandboxKnowledge?: () => Record<keyof SbxKnowledgeConfig, SandboxKnowledgeEntry[]>;
  /**
   * `sbx create`'s agent argument where it is not the agent id: a kit sbx does not ship. Only
   * `create` takes it; `sbx run` reattaches by `--name` with the plain id. Omitted for a built-in kit.
   */
  sandboxKit?: string;
  /**
   * Completes a url the TUI wrapped across rows, from the agent's own record — in the buffer such
   * a row looks like one ending in a url (opencode breaks a long token at the last "." that fits).
   * Returns the full url starting with `prefix`, or undefined (the renderer keeps the fragment).
   *
   * Called only on a modifier hover, at most once per fragment, so it may use HTTP; a rejection
   * reads as "nothing known".
   */
  resolveUrlPrefix?: (executable: string, cwd: string, sessionId: string, prefix: string) => Promise<string | undefined>;
  /**
   * Factory for a fresh per-session "CLI ready yet" check fed each output chunk; once true, the tab
   * strip's progress bar hides. Output reaches the terminal throughout — some CLIs query it for
   * capabilities at start.
   *
   * No real readiness signal exists: a per-agent guess at "the CLI drew its first real frame", from
   * undocumented output, its threshold tuned by hand per agent. Omitted by the shell.
   */
  createIsSessionReady?: () => (chunk: string) => boolean;
  /**
   * Ctrl+C presses that make the CLI quit by itself, sent before a kill (TerminalSession.stop).
   * Measured: Claude Code and pi 2 (pi within 500 ms), and both soon withdraw the offer; Codex and
   * opencode 1 — a second byte to a leaving Codex lands after raw mode ended, where ConPTY turns it
   * into a CTRL_C_EVENT that kills the shutdown. All four read `\x03` as an ordinary byte and decide
   * what it means. Omitted for the shell (plain SIGINT).
   */
  quitPresses?: number;
  /**
   * The TUI takes the right mouse button through mouse reporting (Claude Code pastes, opencode
   * copies). Otherwise — the shell, Codex (github.com/openai/codex#8344) — tet copies a selection or
   * pastes (terminal-views.ts). pi turns on no mouse reporting at all. A measured fact the renderer
   * acts on, travelling as a flag on AgentInfo, as does `swapsBlueMagenta`.
   */
  takesRightMouse?: boolean;
  /**
   * opencode under `"theme": "system"` (tui-config.ts) draws blue and magenta swapped against VS
   * Code's palette (observed); buildXtermTheme in theme.ts swaps them back.
   */
  swapsBlueMagenta?: boolean;
}
