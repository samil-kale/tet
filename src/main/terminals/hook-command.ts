import type { HookEvent } from "../../shared/control";

/**
 * How an agent whose hooks are commands reports one event: `tet-ctl` off the terminal's PATH,
 * the same channel its toast already went through. Shared by Claude Code and Codex; opencode and
 * pi report from inside their own process and speak the wire contract directly.
 *
 * A bare name and nothing else — no interpreter, no generated script, no redirection — because
 * the command is parsed by whichever shell the agent chose, and that is not ours to pick: on
 * win32 Claude Code runs hooks under `/usr/bin/bash`, and PowerShell and cmd.exe have both been
 * seen too. All three resolve a bare name off PATH and hand the two arguments over unchanged;
 * anything richer is where they start to differ (measured: `cmd.exe /c` has MSYS rewrite the
 * `/c` into `C:\`, and cmd then opens interactively, banner and all, into the very prompt the
 * hook was reporting). What makes the bare name resolve in all three is the pair of launchers
 * written into userData — see control-launcher.ts.
 *
 * The event is tet's own vocabulary, not the CLI's: each agent's setup maps its own events onto
 * these, and the session manager gives all of them the same meaning.
 */
export function hookCommand(event: HookEvent): string {
  return `tet-ctl hook ${event}`;
}
