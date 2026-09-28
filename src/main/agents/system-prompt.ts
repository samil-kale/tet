/**
 * What every agent tab is told about TET, once per session: never replacing the user's own
 * instructions, not repeated with every message. Claude Code and pi append it to their system
 * prompt at spawn (AgentHost.prepare and AgentSandbox.prepare), Codex takes it as added context in its
 * `SessionStart` hook's answer (codex/hooks.ts). It only says when to look; `tet-ctl help` holds
 * the verbs.
 *
 * One line with no `"`, `\`, backtick or cmd.exe/shell metacharacter (pieces.test.ts): it travels
 * as a plain argument through cmd.exe (pi's npm shim) and through `sbx run`. A sandboxed tab is
 * not offered tabs-run-command, so it is not sent looking for one.
 */
function tetSentences(sandboxed: boolean): string {
  return (
    "You are running inside TET, which runs coding agents, shells and saved commands as terminal tabs the user watches. " +
    "Run tet-ctl help before using tet-ctl, and use it when the user asks about TET, means something they ran or saw in another tab, " +
    "or wants something shown to them, or when " +
    (sandboxed ? "another agent" : "a saved command or another agent") +
    " should do the job."
  );
}

/** Only outside a sandbox, where the env verbs answer; a sandbox never hears of them. */
const ENVIRONMENT_SENTENCE =
  " When an environment variable you need, a token or password, is not set, never ask for its value in the chat: " +
  "offer the user to type it into TET or to set it themselves, as tet-ctl help describes.";

/** A worktree made by git or by an agent's own worktree tools lands outside TET's worktrees, which
 *  TET shows greyed and never opens. */
const WORKTREE_SENTENCE =
  " To create or delete a git worktree, use tet-ctl rather than git or your own worktree tools: TET opens only the worktrees it made.";

/** In a sandbox too: tabs-create opens an sbx agent's tab there. An agent's own subagents are no
 *  tabs, so it is told which work gets one. */
const TASK_SENTENCE =
  " When the user wants another agent or a tab of its own on a task, open one with tet-ctl; your own subagents stay as they are.";

export function systemPrompt(sandboxed: boolean): string {
  return tetSentences(sandboxed) + WORKTREE_SENTENCE + TASK_SENTENCE + (sandboxed ? "" : ENVIRONMENT_SENTENCE);
}
