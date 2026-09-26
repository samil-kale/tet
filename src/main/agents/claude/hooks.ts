import * as fs from "node:fs";
import * as path from "node:path";
import { hookCommand } from "../../terminals/hook-command";
import { HOST_TARGET, type HookTarget } from "../../terminals/hook-target";
import { writeIfChanged } from "../../write-if-changed";

/**
 * Writes the settings file registering Claude Code's hooks into `agentDir` (the host tabs' one,
 * or a sandbox folder's); returns the `--settings` args. Layered over the user's config; `~/.claude/settings.json` is never touched.
 *
 * Every hook is a bare `tet-ctl hook <event>`, independent of Claude Code's shell (measured on
 * win32: `/usr/bin/bash`, where only the extensionless launcher resolves; control-launcher.ts).
 * One `UserPromptSubmit` command marks the session busy; its answer is empty, since TET's system
 * prompt goes in once at spawn (index.ts).
 */
export function setupClaudeHooks(
  storageDir: string,
  paths: { idleReminder: boolean },
  themeName: string,
  target: HookTarget = HOST_TARGET
): string[] {
  const command = (event: Parameters<typeof hookCommand>[0]): { type: string; command: string }[] => [
    { type: "command", command: hookCommand(event) }
  ];

  const hooks = {
    UserPromptSubmit: [{ hooks: command("prompt-submit") }],
    Stop: [{ hooks: command("stop") }],
    // Two events mean blocked on the user; `idle_prompt` fires after a turn ended (the bubble's
    // meaning), so it is only a reminder, registered only when wanted (AgentPaths.idleReminder).
    // No guard on the first two: they are raised only when Claude Code has actually stopped.
    Notification: [
      { matcher: "permission_prompt|elicitation_dialog", hooks: command("permission") },
      ...(paths.idleReminder ? [{ matcher: "idle_prompt", hooks: command("idle") }] : [])
    ],
    // `AskUserQuestion` is a tool, not a Notification event.
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: command("question") }]
  };

  // Claude Code paints dark unless told; `theme` here outranks `~/.claude.json` for this process
  // (measured). Built-in only: a custom theme loads after the first render, drawing a dark frame
  // meanwhile (measured).
  const settingsFile = path.join(storageDir, "tet-hooks-settings.json");
  fs.mkdirSync(storageDir, { recursive: true });
  // Rename into place: a sandbox's copy is rewritten on every spawn while another tab may read it.
  writeIfChanged(settingsFile, JSON.stringify({ hooks, theme: themeName }, null, 2));
  return ["--settings", target.embed(settingsFile)];
}

/**
 * AgentDefinition.workOutlivesStop. Stop fires when the main turn ends, background agents still
 * running; its payload lists them in `background_tasks` (`type: "subagent"`, `status: "running"`)
 * and each one's end starts a turn of its own (`UserPromptSubmit` with a `<task-notification>`,
 * then Stop) — measured, 2.1.282. Background shells (`type: "shell"`) don't count: a server never
 * ends, and one a subagent left behind ends without a turn (measured).
 */
export function claudeWorkOutlivesStop(payload: string): boolean {
  try {
    const tasks = (JSON.parse(payload) as { background_tasks?: unknown } | null)?.background_tasks;
    return (
      Array.isArray(tasks) &&
      tasks.some((task: { type?: unknown; status?: unknown } | null) => task?.type === "subagent" && task.status === "running")
    );
  } catch {
    return false;
  }
}
