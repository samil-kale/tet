import type { ThemeDefinition } from "../../shared/themes";
import type { AgentId, NotificationSettings } from "../../shared/types";

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
   * True while `title` is only standing in for a name the agent hasn't assigned yet (Claude:
   * the first prompt, shown until an agent-name/ai-title lands). Those arrive from a background
   * call that can finish after the CLI has gone quiet, so the manager keeps polling a while
   * longer for sessions flagged here — see reconcile.
   */
  provisionalTitle?: boolean;
  /**
   * When this session's last turn ended, ms since epoch, as the agent's own record of it says —
   * undefined where the agent keeps no such record. It is a *net* under the end-of-turn signal
   * an agent reports through AgentPaths.onSessionFinished, for the ends that signal cannot
   * carry: Claude Code runs no Stop hook for a turn the user cut short. See reconcile, which is
   * the one place it is read, and only ever to end a turn.
   */
  turnEndedAt?: number;
}

/**
 * Agent-specific session enumeration/resume/deletion, living in the agent's own folder
 * since it speaks that agent's protocol (Claude: transcript files on disk; opencode: its
 * HTTP API).
 */
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
   * Optional: calls `onChange` whenever this repository's sessions change, so the manager can
   * re-list right away instead of waiting out its polling. Returns a stop function, called on
   * shutdown — an implementation owning a process or connection tears it down there.
   */
  watch?(executable: string, cwd: string, onChange: () => void): () => void;
}

/**
 * What one agent is handed to set itself up for one repository: where it may write, and the
 * one thing it reports back out of band. Everything else an agent says goes through the
 * return value of the call it was made from.
 */
export interface AgentPaths {
  /**
   * This agent's own scratch directory for this repository, already created. Per repository
   * because several are open at once and what is generated in there (notification texts, hook
   * settings) names the one it belongs to.
   */
  agentDir: string;
  /**
   * The repository's context file, kept current by tet — the agent's job is only to
   * arrange for it to reach the model. Blank whenever there is nothing to say.
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
   * What this agent may notify the OS about, as the settings dialog last left it. Handed over
   * rather than imported, so the one persisted copy stays the only one — and read here, at
   * setup, because that is where each agent bakes it in: Claude Code into the settings file it
   * reads once at startup, opencode into the notifier around its event stream.
   */
  notifications: NotificationSettings;
  /**
   * The window's color theme, handed over for the same reason and read at the same moment:
   * an agent that cannot read the terminal's colors off the terminal (Codex on win32 reads
   * the console's) is told them at setup, and keeps them for its process's lifetime.
   */
  theme: ThemeDefinition;
  /**
   * Whether to have *this* agent draw in that theme — Claude Code's `theme`, Codex's
   * `tui.theme=ansi`, opencode's `"theme": "system"` — or to leave its looks to it and the
   * user's own configuration; one switch per agent in the Appearance tab. Off, the agent is
   * still told which way the background is (Codex's console colors): that is a fact about the
   * window, not a choice about its looks.
   */
  themeAgents: boolean;
  /**
   * The two ends of a turn, reported as the agent itself sees them — never guessed from the
   * terminal's output. `busy` puts the spinner on the tab, `finished` takes it off again and
   * leaves the mark behind; see "Both ends of a turn" in CLAUDE.md.
   *
   * A session id, not a tab id: an agent knows nothing about tabs. One that has no tab yet is
   * held until the next reconcile claims it, so a fresh session's first turn is not lost.
   *
   * `at` is when the agent *made* the report, where that is known (a marker file's mtime);
   * a report older than the last one applied to its session is dropped, since markers of the
   * three kinds are watched separately and can arrive out of order. Left out, it is now.
   */
  onSessionBusy(sessionId: string, at?: number): void;
  onSessionFinished(sessionId: string, at?: number): void;
  /**
   * The turn stopped part-way on a question only the user can answer — a permission prompt, an
   * elicitation, or `AskUserQuestion`. Reported through the same path and held the same way as
   * the two above, and deliberately *not* an end: the turn is still open, which is why it takes
   * the spinner's place rather than clearing it.
   *
   * There is no matching "answered" signal from either agent, and neither is worth buying: it
   * would cost a hook process on every tool call. The mark is cleared by being looked at, and
   * by either end of the turn — see setTurn.
   */
  onSessionWaiting(sessionId: string, at?: number): void;
}

/**
 * Result of an agent's async spawn preparation — see AgentDefinition.prepareSpawn. `args`
 * and `env` are merged into every session the manager starts, `dispose` runs at shutdown.
 */
export interface SpawnPreparation {
  args: string[];
  env?: Record<string, string>;
  /**
   * What to start instead of the agent's own executable, where something has to run *inside*
   * the pty before it — Codex's console-color launcher on win32. Only the terminal's process
   * takes it; listing, renaming and the version check still go to the agent itself.
   */
  executable?: string;
  dispose(): void;
  /**
   * Whether this may be disposed again while the project has no session and no open tab of
   * this agent, and prepared afresh once it does. Set it when the preparation costs while it
   * sits idle — opencode's is a server process per repository, started only so its sessions
   * could be listed. One that is just a generated file is cheaper to keep than to redo, and
   * leaves this unset.
   *
   * Whatever the agent's `watch` holds goes with it, since it may well be a subscription on
   * the very thing being disposed.
   */
  releaseWhenIdle?: boolean;
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
   * Args that make the executable report its version, used to tell "not installed" from a
   * spawn that failed for another reason. Omitted for agents that always exist (the shell).
   */
  versionArgs?: string[];
  /**
   * Where this agent is installed from, for the startup check's dialog — tet needs one of
   * them and installs none of them itself. Goes with `versionArgs`: an agent that is always
   * there has neither.
   */
  installUrl?: string;
  /**
   * Args that put one question to the agent without a terminal, answered on stdout and then
   * over. The question itself arrives on stdin, so these name the mode and nothing else (see
   * `suggestCommands` for why it is not an argument). Omitted for an agent that cannot be
   * asked anything (the shell), which is what keeps it out of the jobs that use this.
   */
  askArgs?: string[];
  /**
   * Args that hand one command to this agent *in a terminal*, ending when it does. Only the
   * shell has it, and only a saved command that asked for a shell uses it — one otherwise
   * starts as the program it names, with nothing in between.
   */
  runArgs?: (command: string) => string[];
  /**
   * Removes what `askArgs` left behind, for an agent that persists a session either way — a
   * question asked in the background must not come back as a tab on the next start. Left out
   * by an agent that can be told not to persist one in the first place.
   */
  cleanupAsk?: (executable: string, cwd: string) => Promise<void>;
  /**
   * One-time setup for the app rather than for a repository, run before any project opens and
   * therefore before anything asks this agent for a session listing. What it is for is what a
   * killed run left behind: opencode takes down the servers of one, since no dispose of ours
   * runs when the process is killed. An agent with nothing to reclaim leaves it out.
   *
   * Synchronous, and nothing here waits for what it started: only the agent's own code knows
   * which of its calls have to, and it is that code which holds the promise.
   */
  prepareApp?: (storageRoot: string) => void;
  /** Session enumeration/resume/deletion; a missing provider means "this agent has no sessions". */
  sessions?: SessionProvider;
  /**
   * Async setup that has to finish before any session of this agent is spawned, for agents
   * whose spawn arguments aren't known up front — opencode brings up the server its TUI then
   * attaches to and only then knows the URL, and Claude Code's hooks are generated into a
   * settings file it is pointed at.
   *
   * Also where an agent arranges for the repository's context file to reach the model, which
   * each does its own way — see AgentPaths.
   */
  prepareSpawn?: (executable: string, cwd: string, paths: AgentPaths) => Promise<SpawnPreparation>;
  /**
   * Completes a url the agent's TUI wrapped across rows, from the agent's own record of what
   * it printed — in the buffer such a row cannot be told apart from one that merely ends in a
   * url (opencode breaks a long token at the last "." that fits, so not even the right edge
   * marks it). Returns the full url starting with `prefix`, or undefined when nothing is
   * known; the renderer then keeps the fragment as it is.
   *
   * Called only when the user holds the modifier over such a url, at most once per fragment,
   * so an implementation may go over HTTP — but must not throw.
   */
  resolveUrlPrefix?: (executable: string, cwd: string, sessionId: string, prefix: string) => Promise<string | undefined>;
  /**
   * A factory (not the predicate itself!) for the "is this session's CLI ready yet" check, so
   * each session gets a fresh one instead of carrying over one that already passed. It sees
   * each output chunk and the ms since that session started; once it returns true, the
   * progress bar under the tab strip hides. Output keeps flowing to the terminal throughout —
   * some CLIs query it for capabilities like the background colour at start and need a timely
   * answer, which withholding would break.
   *
   * There is no real readiness signal (no port, no log line, no flag), so this is a
   * best-effort guess at undocumented output behaviour — which is why the tuning lives per
   * agent. Omitted for agents that are up as soon as they are spawned (the shell).
   */
  createIsSessionReady?: () => (chunk: string) => boolean;
  /**
   * How many Ctrl+C bytes it takes to make this CLI quit by itself, so tet can ask before it
   * kills (see TerminalSession.stop). Omitted where asking makes no sense — the shell, which
   * has nothing to save and whose Ctrl+C is a plain SIGINT.
   *
   * Per agent because they genuinely differ, measured through this same pty rather than
   * assumed: Claude Code wants two, and drops its "press again to exit" offer after about a
   * second, so the second byte has to arrive well inside that. Codex and opencode start
   * shutting down on the first one (~400ms and ~150ms to exit) — and a byte sent to a Codex
   * already on its way out lands after it has given up raw mode, where ConPTY turns it into a
   * process-level CTRL_C_EVENT and kills the very shutdown we were waiting for. That left no
   * single interval that is right for all three: this is what one number to rule them all
   * would have had to thread, and why it is a per-agent count instead.
   */
  quitPresses?: number;
  /**
   * Whether a plain `\x03` kills this CLI instead of reaching it as input, so Ctrl+C without a
   * selection is swallowed rather than sent (terminal-views.ts). Measured, not assumed: Claude
   * Code and opencode run raw and read the byte as any other (clear the prompt, interrupt a
   * turn), but Codex sits in cooked mode, where on win32 ConPTY raises it as a process-level
   * CTRL_C_EVENT that kills a CLI with no handler for it rather than "interrupting" it.
   * Closing the tab is such an agent's equivalent action.
   */
  plainCtrlCKills?: boolean;
  /**
   * Whether this agent's TUI takes the right mouse button itself through xterm's mouse
   * reporting (Claude Code pastes, opencode copies the selection). Where it does not — the
   * shell never turns mouse reporting on, and Codex deliberately leaves the mouse to the
   * terminal (github.com/openai/codex#8344) — tet supplies the usual terminal convention
   * itself: copy a selection, or paste when there is none (terminal-views.ts).
   */
  takesRightMouse?: boolean;
  /**
   * opencode's TUI assigns blue and magenta the other way round from VS Code's terminal
   * palette, so what it draws comes out in the colour the user did not theme — the renderer
   * swaps the two in the palette this agent's terminals are handed (buildXtermTheme in
   * theme.ts), putting them back. Ported from sbc-vsc-agents, where it was observed, not
   * derived — if opencode's colours ever look wrong the other way, take this back out. It goes
   * with the `"theme": "system"` in tui-config.ts, which is what makes opencode take that
   * palette at all rather than painting in its own.
   */
  swapsBlueMagenta?: boolean;
}
