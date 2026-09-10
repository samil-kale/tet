import * as fs from "node:fs";
import * as path from "node:path";
import { hookCommand } from "../../terminals/hook-command";
import { HOST_TARGET, type HookTarget } from "../../terminals/hook-target";

/**
 * The `background_tasks` guard on the end of a turn: Stop fires on every turn boundary,
 * including one that merely launched a background subagent or shell command, and the payload
 * lists each pending job with `id`, `type` (`subagent`, `shell`) and `status`. Only
 * `status: "running"` holds the turn open, so an unknown status reports rather than silencing
 * every future turn.
 *
 * A payload that is not JSON at all — nothing on stdin, a future release changing shape — is a
 * turn that ended: the mark is what the user is waiting for, and there is nothing here that
 * could tell them it was withheld.
 */
export function claudeHoldsTurnEnd(payload: string): boolean {
  let tasks: unknown;
  try {
    tasks = (JSON.parse(payload) as { background_tasks?: unknown }).background_tasks;
  } catch {
    return false;
  }
  return Array.isArray(tasks) && tasks.some((task) => (task as { status?: unknown } | null)?.status === "running");
}

/**
 * Generates the per-repository settings file registering Claude Code's hooks and returns the
 * `--settings` arguments. Claude Code layers it over its own configuration; the user's
 * `~/.claude/settings.json` is never touched.
 *
 * Every hook is one `tet-ctl hook <event>` — no generated script, so nothing here depends on
 * which shell Claude Code picked (measured on win32: `/usr/bin/bash`, where the launcher's
 * extensionless twin is what resolves; see control-launcher.ts). `UserPromptSubmit` is one
 * command rather than two: the same call that marks the session busy answers with the context
 * file's text, which Claude Code appends to the prompt.
 */
export function setupClaudeHooks(
  storageDir: string,
  paths: { contextReadPaths: string[]; idleReminder: boolean },
  themeName: string,
  target: HookTarget = HOST_TARGET
): string[] {
  const command = (event: Parameters<typeof hookCommand>[0]): { type: string; command: string }[] => [
    { type: "command", command: hookCommand(event) }
  ];

  const hooks = {
    UserPromptSubmit: [{ hooks: command("prompt-submit") }],
    Stop: [{ hooks: command("stop") }],
    // The two Notification events that mean Claude Code is blocked on the user, and the one that
    // means it has been waiting a while. Not `idle_prompt` as a question: it fires after a turn
    // ended, which the bubble already stands for — it is a reminder and nothing else, so it is
    // the one hook registered only when its toast is wanted (AgentPaths.idleReminder); every
    // other hook leaves a mark whatever the settings say. No guard on the two below: those
    // events are raised only when Claude Code has actually stopped.
    Notification: [
      { matcher: "permission_prompt|elicitation_dialog", hooks: command("permission") },
      ...(paths.idleReminder ? [{ matcher: "idle_prompt", hooks: command("idle") }] : [])
    ],
    // `AskUserQuestion` is a tool rather than a Notification event, so the same condition needs
    // a second hook to be seen at all.
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: command("question") }]
  };

  // The shell transcript sits outside the repository, where reads are denied unless granted.
  // Per file, not the directory (which also holds this settings file).
  const permissions = { allow: paths.contextReadPaths.map((file) => `Read(${target.embed(file)})`) };

  // Claude Code paints dark unless told otherwise; `theme` here outranks `~/.claude.json` for
  // this process alone (measured). A built-in theme name, not a custom one: custom themes load
  // after the first render, and it draws a dark frame meanwhile (measured).
  const settingsFile = path.join(storageDir, "tet-hooks-settings.json");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks, permissions, theme: themeName }, null, 2));
  return ["--settings", target.embed(settingsFile)];
}
