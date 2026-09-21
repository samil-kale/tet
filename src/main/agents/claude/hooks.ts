import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { hookCommand } from "../../terminals/hook-command";
import { HOST_TARGET, type HookTarget } from "../../terminals/hook-target";

/**
 * The `background_tasks` guard: Stop fires on every turn boundary, including one that merely
 * launched a background subagent or shell command; the payload lists each pending job with `id`,
 * `type` (`subagent`, `shell`) and `status`. Only a running job of those two types holds the turn,
 * so an unknown status or type reports rather than silencing every future turn: a `monitor` (an
 * artifact's live updates, measured 2026-09-21) runs for the whole session and would hold them all.
 *
 * A non-JSON payload (empty stdin, a changed shape) is an ended turn: a withheld mark could not
 * be noticed by the user waiting for it.
 */
export function claudeHoldsTurnEnd(payload: string): boolean {
  let tasks: unknown;
  try {
    tasks = (JSON.parse(payload) as { background_tasks?: unknown }).background_tasks;
  } catch {
    return false;
  }
  return (
    Array.isArray(tasks) &&
    tasks.some((task) => {
      const job = task as { type?: unknown; status?: unknown } | null;
      return (job?.type === "subagent" || job?.type === "shell") && job.status === "running";
    })
  );
}

/**
 * Writes the per-repository settings file registering Claude Code's hooks; returns the
 * `--settings` args. Layered over the user's config; `~/.claude/settings.json` is never touched.
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
  writeFileAtomic.sync(settingsFile, JSON.stringify({ hooks, theme: themeName }, null, 2));
  return ["--settings", target.embed(settingsFile)];
}
