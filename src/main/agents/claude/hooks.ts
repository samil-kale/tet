import * as fs from "node:fs";
import * as path from "node:path";
import { buildMarkCommand, markerDir, markPosix, markPowershell } from "../../terminals/marker-watch";
import { buildNotifyCommand, buildReadFileCommand, WIN_BOM, writePosixScript } from "../../terminals/os-notify";
import type { NotificationSettings } from "../../../shared/types";

/**
 * Builds the UserPromptSubmit hook that records the session as working: the other end of the
 * turn from the Stop hook below, and what puts the spinner on its tab. It has no guard of its
 * own — a prompt was submitted, so the agent is busy, full stop.
 *
 * It shares UserPromptSubmit with the command that prints the context file, whose stdout is
 * appended to the prompt, so this one has to stay **silent**; and it must exit 0 whatever
 * happens, since a non-zero UserPromptSubmit hook can hold the prompt back — both of which
 * `buildMarkCommand` guarantees.
 */
function buildBusyCommand(storageDir: string): string {
  return buildMarkCommand(storageDir, "busy", "busy", undefined);
}

/**
 * Builds the Stop hook: it records that the session finished a turn — a file named after its
 * id — and then notifies, where notifications are on. Both are guarded by the same condition,
 * since both answer the one question of whether the turn is actually over.
 *
 * Stop fires on every turn boundary, including one that merely launches a background subagent
 * or shell command and returns at once — so unguarded, "Finished" shows up while that work is
 * still running.
 *
 * The Stop payload carries a `background_tasks` array for exactly this: every still pending
 * job, each with an `id`, a `type` (`subagent` for Task/Agent runs, `shell` for Bash calls
 * made with run_in_background) and a `status`.
 *
 * Deliberately narrow: it suppresses only on `status: running`. An unknown status therefore
 * reports rather than staying silent — a spurious mark is a far better failure than a job
 * stuck in the list silencing every future one.
 */
function buildStopCommand(storageDir: string, notifyCommand: string | undefined): string {
  const marks = markerDir(storageDir, "finished");
  fs.mkdirSync(marks, { recursive: true });
  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, "stop-guard.ps1");
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
  # The @() must wrap the whole pipeline, not just the input: PowerShell 5.1 returns a bare
  # object rather than a 1-element array when Where-Object matches exactly once, and a bare
  # object has no .Count - so $running.Count yields $null and the comparison below turns
  # false. That is the single-subagent case, i.e. the common one. The $_ test drops the lone
  # $null that piping an absent field would pass on.
  $running = @($json.background_tasks | Where-Object { $_ -and $_.status -eq "running" })
  if ($running.Count -gt 0) {
    exit 0
  }
${markPowershell(marks)}
} catch {}
${notifyCommand ?? ""}
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
  }
  const scriptFile = path.join(storageDir, "stop-guard.sh");
  writePosixScript(
    scriptFile,
    `#!/bin/sh
json=$(cat)
# Isolate the background_tasks array before matching, so a "status":"running" that merely
# appears in some other field (last_assistant_message quoting the payload shape, say)
# cannot suppress the notification. Task objects hold no nested arrays, so stopping at the
# first ] is safe.
tasks=$(printf '%s' "$json" | sed -n 's/.*"background_tasks"[[:space:]]*:[[:space:]]*\\(\\[[^]]*\\]\\).*/\\1/p')
if printf '%s' "$tasks" | grep -q '"status"[[:space:]]*:[[:space:]]*"running"'; then
  exit 0
fi
${markPosix(marks)}
${notifyCommand ?? ""}
`
  );
  return `sh "${scriptFile}"`;
}

/**
 * Builds a hook command that records the session as waiting on the user, and then notifies
 * where notifications are on. Built exactly like the Stop command and for the same reason: the
 * marker is what puts the mark on the tab, and that mark is not a notification the user can
 * turn off — it is how a session blocked out of sight is found again. Only the toast is
 * optional.
 *
 * No guard of its own, unlike Stop's `background_tasks` check: Claude Code raises these events
 * only when it has actually stopped for an answer, so there is no "it merely looks stopped"
 * case to rule out. It carries no turn state either — the turn is still open, and `waiting`
 * says where it stopped, not that it ended.
 *
 * `id` names the script file, because the two callers want different toast wording and a
 * shared file would have the second overwrite the first.
 */
function buildWaitingCommand(storageDir: string, id: string, notifyCommand: string | undefined): string {
  return buildMarkCommand(storageDir, id, "waiting", notifyCommand);
}

/**
 * Generates the settings file that registers Claude Code's hooks, and returns the arguments
 * that point the CLI at it. Everything is scoped to that per-repository file and passed with
 * `--settings`, which Claude Code layers on top of its own configuration — the user's
 * `~/.claude/settings.json` is never read, written or replaced here.
 */
export function setupClaudeHooks(
  storageDir: string,
  cwd: string,
  displayName: string,
  notifications: NotificationSettings,
  context: { contextFile: string; contextReadPaths: string[] },
  themeName: string | undefined
): string[] {
  const hooks: Record<string, unknown> = {
    // Two commands on the one event: the context file's contents become part of the prompt,
    // and the marker says the session has started working. Order matters only in that the
    // second must print nothing — everything a UserPromptSubmit hook writes is appended to
    // the prompt itself.
    UserPromptSubmit: [
      {
        hooks: [
          { type: "command", command: buildReadFileCommand(storageDir, "read-context", context.contextFile) },
          { type: "command", command: buildBusyCommand(storageDir) }
        ]
      }
    ]
  };
  const repositoryName = path.basename(cwd);

  // Registered whatever the notification settings say: the same hook is what marks the tab,
  // and that mark is not a notification the user can turn off — it is how a session that
  // finished out of sight is found again. Only the toast inside it is optional.
  const notify = notifications.finished
    ? buildNotifyCommand(storageDir, "stop", `${displayName}: Finished`, `Finished in ${repositoryName}`)
    : undefined;
  hooks.Stop = [{ hooks: [{ type: "command", command: buildStopCommand(storageDir, notify) }] }];

  // A turn that stopped on a question, registered on the same terms as Stop above: the command
  // marks the tab whatever the settings say, and only the toast inside it is optional. The
  // matcher is the pair of Notification events that mean Claude Code is actually blocked —
  // `idle_prompt` is deliberately not among them, since that one fires *after* a turn ended and
  // is already what the bubble stands for.
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
              ? buildNotifyCommand(
                  storageDir,
                  "needs-you",
                  `${displayName}: Action needed`,
                  `Waiting for input in ${repositoryName}`
                )
              : undefined
          )
        }
      ]
    }
  ];
  if (notifications.idleReminder) {
    notificationHooks.push({
      matcher: "idle_prompt",
      hooks: [
        {
          type: "command",
          command: buildNotifyCommand(
            storageDir,
            "idle",
            `${displayName}: Still waiting`,
            `No response yet in ${repositoryName}`
          )
        }
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
              ? buildNotifyCommand(
                  storageDir,
                  "question",
                  `${displayName}: Question`,
                  `Waiting for your answer in ${repositoryName}`
                )
              : undefined
          )
        }
      ]
    }
  ];

  // The context block points at a file in tet's own storage — outside the repository,
  // where reads are denied unless granted. Scoped to that one file rather than the whole
  // directory, which also holds the notify scripts and this settings file.
  const permissions = { allow: context.contextReadPaths.map((file) => `Read(${file})`) };

  // Claude Code paints its own theme — dark by default, or whatever `~/.claude.json` says —
  // without looking at the terminal, so on a light background its diff blocks came out as
  // the dark theme's near-black red and green. A `theme` in this file outranks the global
  // one for this process alone (measured: `light` changes every RGB the welcome screen is
  // drawn with), so the user's own file stays as it is. One of Claude's built-in themes, not
  // a custom one in tet's colors: those it reads after its first render — from a plugin and
  // from its own themes directory alike — and draws a dark frame in the meantime (measured at
  // ~230 ms), which was tried and taken back out. Undefined — the Appearance tab's switch off
  // — leaves the key out, and with it the user's own choice in charge.
  const settingsFile = path.join(storageDir, "tet-hooks-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks, permissions, theme: themeName }, null, 2));
  return ["--settings", settingsFile];
}
