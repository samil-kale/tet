/**
 * What every agent tab is told about TET, once per session: never replacing the user's own
 * instructions, not repeated with every message. Claude Code, opencode and pi append it to their
 * system prompt at spawn (prepareSpawn and prepareSandboxSpawn), Codex takes it as added context in
 * its `SessionStart` hook's answer (codex/hooks.ts). It only says when to look; `tet-ctl help` holds the verbs.
 *
 * One line with no `"`, `\`, backtick or cmd.exe/shell metacharacter (pieces.test.ts): it travels
 * as a plain argument through cmd.exe (pi's npm shim) and through `sbx run`. Measured with this
 * text, 2026-09-16, win32 host and sbx 0.42.1 — Claude Code 2.1.273, opencode 1.18.4, pi 0.85.1:
 * each answered a canary word only this text carried.
 */
const TET_SYSTEM_PROMPT =
  "You are running inside TET, which runs coding agents and shells as terminal tabs. " +
  "tet-ctl controls TET and reads this project's tabs; run tet-ctl help before using it. " +
  "Use it when the user asks about TET, about something they ran or saw in a shell tab, or about what another agent did or said.";

/** Only outside a sandbox, where the env verbs answer; a sandbox never hears of them. */
const ENVIRONMENT_SENTENCE =
  " When an environment variable you need, a token or password, is not set, never ask for its value in the chat: " +
  "offer the user to type it into TET or to set it themselves, as tet-ctl help describes.";

export function systemPrompt(sandboxed: boolean): string {
  return sandboxed ? TET_SYSTEM_PROMPT : TET_SYSTEM_PROMPT + ENVIRONMENT_SENTENCE;
}
