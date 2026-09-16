/**
 * What every agent tab is told about TET, once per session: appended to its system prompt when it
 * starts (each agent's prepareSpawn and prepareSandboxSpawn), not repeated with every message. It
 * only says when to look; `tet-ctl help` holds the verbs.
 *
 * One line with no `"`, `\`, backtick or cmd.exe/shell metacharacter (pieces.test.ts): it travels
 * as a plain argument through cmd.exe (pi's npm shim, Codex's launch.cmd), through `sbx run`, and
 * inside a TOML basic string (Codex). Measured with this text, 2026-09-16, win32 host and sbx
 * 0.42.1 — Claude Code 2.1.273, Codex 0.154.0, opencode 1.18.4, pi 0.85.1: each answered a canary
 * word only this text carried, and Codex's command line held it as one argument.
 */
export const TET_SYSTEM_PROMPT =
  "You are running inside TET, which runs coding agents and shells as terminal tabs. " +
  "tet-ctl controls TET and reads this project's tabs; run tet-ctl help before using it. " +
  "Use it when the user asks about TET, about something they ran or saw in a shell tab, or about what another agent did or said.";
