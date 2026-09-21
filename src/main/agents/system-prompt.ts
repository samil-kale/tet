/**
 * What every agent tab is told about TET, once per session: appended to its system prompt, never
 * replacing the user's own instructions, not repeated with every message. Claude Code, opencode and
 * pi take it at spawn (prepareSpawn and prepareSandboxSpawn), Codex as its `SessionStart` hook's
 * answer (codex/hooks.ts). It only says when to look; `tet-ctl help` holds the verbs.
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

/** Only outside a sandbox, where the credentials verbs answer; a sandbox never hears of them. */
const CREDENTIALS_SENTENCE =
  " When a task needs a credential that neither the environment nor a CLI login provides, " +
  "tet-ctl credentials-get and credentials-request supply one, typed by the user into TET, never into the chat.";

export function systemPrompt(sandboxed: boolean): string {
  return sandboxed ? TET_SYSTEM_PROMPT : TET_SYSTEM_PROMPT + CREDENTIALS_SENTENCE;
}
