import * as fs from "node:fs";
import * as path from "node:path";
import { buildBusyCommand, buildWaitingCommand, markerDir, markPosix, markPowershell } from "../../terminals/marker-watch";
import { HOST_TARGET, type HookTarget } from "../../terminals/hook-target";
import { buildHookNotifyCommand, buildReadFileCommand, WIN_BOM, writePosixScript } from "../../terminals/os-notify";
import type { NotificationSettings } from "../../../shared/types";

/**
 * The Stop hook: touches the "finished" marker and notifies where enabled, both behind one
 * guard. Stop fires on every turn boundary, including one that merely launched a background
 * subagent or shell command; the payload's `background_tasks` array lists each pending job
 * with `id`, `type` (`subagent`, `shell`) and `status`. Suppresses only on `status: running`,
 * so an unknown status reports rather than silencing every future turn.
 */
function buildStopCommand(storageDir: string, notifyCommand: string | undefined, target: HookTarget): string {
  const marks = markerDir(storageDir, "finished");
  fs.mkdirSync(marks, { recursive: true });
  if (!target.posix) {
    const scriptFile = path.join(storageDir, "stop-guard.ps1");
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
  # @() must wrap the whole pipeline: PowerShell 5.1 returns a bare object when Where-Object
  # matches exactly once, and a bare object has no .Count. The $_ test drops the lone $null
  # an absent field pipes on.
  $running = @($json.background_tasks | Where-Object { $_ -and $_.status -eq "running" })
  if ($running.Count -gt 0) {
    exit 0
  }
${markPowershell(target.embed(marks))}
} catch {}
${notifyCommand ?? ""}
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${target.embed(scriptFile)}"`;
  }
  const scriptFile = path.join(storageDir, "stop-guard.sh");
  writePosixScript(
    scriptFile,
    `#!/bin/sh
json=$(cat)
# Isolate the background_tasks array first, so a "status":"running" quoted in another field
# cannot suppress. Task objects hold no nested arrays, so stopping at the first ] is safe.
tasks=$(printf '%s' "$json" | sed -n 's/.*"background_tasks"[[:space:]]*:[[:space:]]*\\(\\[[^]]*\\]\\).*/\\1/p')
if printf '%s' "$tasks" | grep -q '"status"[[:space:]]*:[[:space:]]*"running"'; then
  exit 0
fi
${markPosix(target.embed(marks))}
${notifyCommand ?? ""}
`
  );
  return `sh "${target.embed(scriptFile)}"`;
}

/**
 * Generates the per-repository settings file registering Claude Code's hooks and returns the
 * `--settings` arguments. Claude Code layers it over its own configuration; the user's
 * `~/.claude/settings.json` is never touched.
 */
export function setupClaudeHooks(
  storageDir: string,
  cwd: string,
  displayName: string,
  notifications: NotificationSettings,
  context: { contextFile: string; contextReadPaths: string[] },
  themeName: string,
  target: HookTarget = HOST_TARGET
): string[] {
  const hooks: Record<string, unknown> = {
    // The context file's contents become part of the prompt; the marker says the session is
    // working. A UserPromptSubmit hook's output is appended to the prompt and a non-zero exit
    // can hold it back, so the marker command prints nothing and always exits 0.
    UserPromptSubmit: [
      {
        hooks: [
          { type: "command", command: buildReadFileCommand(storageDir, "read-context", context.contextFile, target) },
          { type: "command", command: buildBusyCommand(storageDir, target) }
        ]
      }
    ]
  };
  const repositoryName = path.basename(cwd);

  // Registered whatever the settings say: the mark is not optional, only the toast inside it.
  const notify = notifications.finished ? buildHookNotifyCommand(target, `${displayName}: Finished`, `Finished in ${repositoryName}`) : undefined;
  hooks.Stop = [{ hooks: [{ type: "command", command: buildStopCommand(storageDir, notify, target) }] }];

  // The two Notification events that mean Claude Code is blocked on the user. Not
  // `idle_prompt`: that fires after a turn ended, which the bubble already stands for. No
  // guard: these events are raised only when it has actually stopped for an answer.
  const notificationHooks: { matcher: string; hooks: { type: string; command: string }[] }[] = [
    {
      matcher: "permission_prompt|elicitation_dialog",
      hooks: [
        {
          type: "command",
          command: buildWaitingCommand(
            storageDir,
            "needs-you",
            notifications.needsYou
              ? buildHookNotifyCommand(target, `${displayName}: Action needed`, `Waiting for input in ${repositoryName}`)
              : undefined,
            target
          )
        }
      ]
    }
  ];
  // Claude Code is the one agent with an idle event; the switch's label in Settings says so.
  if (notifications.idleReminder) {
    notificationHooks.push({
      matcher: "idle_prompt",
      hooks: [
        { type: "command", command: buildHookNotifyCommand(target, `${displayName}: Still waiting`, `No response yet in ${repositoryName}`) }
      ]
    });
  }
  hooks.Notification = notificationHooks;

  // `AskUserQuestion` is a tool rather than a Notification event, so the same condition needs a
  // second hook to be seen at all.
  hooks.PreToolUse = [
    {
      matcher: "AskUserQuestion",
      hooks: [
        {
          type: "command",
          command: buildWaitingCommand(
            storageDir,
            "question",
            notifications.needsYou
              ? buildHookNotifyCommand(target, `${displayName}: Question`, `Waiting for your answer in ${repositoryName}`)
              : undefined,
            target
          )
        }
      ]
    }
  ];

  // The context files sit outside the repository, where reads are denied unless granted.
  // Per file, not the directory (which also holds the scripts and this settings file).
  const permissions = { allow: context.contextReadPaths.map((file) => `Read(${target.embed(file)})`) };

  // Claude Code paints dark unless told otherwise; `theme` here outranks `~/.claude.json` for
  // this process alone (measured). A built-in theme name, not a custom one: custom themes load
  // after the first render, and it draws a dark frame meanwhile (measured).
  const settingsFile = path.join(storageDir, "tet-hooks-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks, permissions, theme: themeName }, null, 2));
  return ["--settings", target.embed(settingsFile)];
}
