import type { HookEvent } from "../../shared/control";

/**
 * The hook command Claude Code and Codex run to report one event: `tet-ctl` off the terminal's
 * PATH. pi reports from inside its own process over the wire contract.
 *
 * A bare name plus arguments, nothing else, because the agent picks the shell: on win32 Claude
 * Code uses `/usr/bin/bash`, and PowerShell and cmd.exe have been seen too. All three resolve a
 * bare name off PATH; anything richer differs (measured: in `cmd.exe /c` MSYS rewrites `/c` to
 * `C:\` and cmd opens interactively into the agent's prompt). The launchers making the name
 * resolve are control-launcher.ts's.
 *
 * The event is tet's vocabulary; each agent's setup maps its own events onto it.
 */
export function hookCommand(event: HookEvent): string {
  return `tet-ctl hook ${event}`;
}
