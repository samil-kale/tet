import * as fs from "node:fs";
import * as path from "node:path";

/** PowerShell 5.1 decodes BOM-less files as ANSI, so generated .ps1 files need this. */
export const WIN_BOM = "﻿";

/**
 * Builds a shell command that shows a native OS notification through each platform's built-in
 * notifier — no extra dependency, no registry writes, no installs. Notification-only, no click
 * action: making a toast act on a click requires registering an app identity, which would mean
 * writing to the registry. `id` must be unique per call site — it names the generated script
 * file, so two events do not overwrite each other's.
 */
export function buildNotifyCommand(storageDir: string, id: string, title: string, body: string): string {
  if (process.platform === "win32") {
    return buildWindowsCommand(storageDir, id, title, body);
  }
  if (process.platform === "darwin") {
    return buildMacCommand(storageDir, id, title, body);
  }
  return buildLinuxCommand(storageDir, id, title, body);
}

function buildWindowsCommand(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.ps1`);
  // Well-known AUMID Windows registers by default for its own PowerShell Start Menu
  // shortcut. Reusing it never creates a registry entry, but it does attribute the toast to
  // "Windows PowerShell" rather than to tet — an app identity of our own would have to
  // be registered first, which this deliberately avoids.
  const appId = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;
  fs.writeFileSync(
    scriptFile,
    WIN_BOM +
      `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

# @'...'@, not @"..."@: the literal here-string. The interpolating one would have PowerShell
# read the text below as code — a repository folder named "cost$analysis" would lose half its
# name to an empty variable, and one with $(...) in it would run whatever that says.
$template = @'
<toast activationType="protocol" launch="">
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXml(title)}</text>
      <text>${escapeXml(body)}</text>
    </binding>
  </visual>
</toast>
'@

# activationType="protocol" with an empty launch URI makes the click a no-op — there is
# nothing to launch, so the toast just dismisses. Without it the click falls back to
# activating the app behind $appId, which pops a dialog about an external application.
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
try {
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}')
  $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch {}
`
  );
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
}

function buildMacCommand(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.sh`);
  // Route the values through env vars read via AppleScript's `system attribute` instead of
  // interpolating them into the -e string directly, so no AppleScript string-literal
  // escaping is needed regardless of what title/body contain.
  writePosixScript(
    scriptFile,
    `#!/bin/sh
TET_TITLE=${shellSingleQuote(title)} TET_BODY=${shellSingleQuote(body)} osascript -e 'display notification (system attribute "TET_BODY") with title (system attribute "TET_TITLE")' >/dev/null 2>&1
exit 0
`
  );
  return `sh "${scriptFile}"`;
}

function buildLinuxCommand(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.sh`);
  // Guarded with `command -v`: notify-send ships with most desktop distros but not
  // minimal/headless ones, and a missing binary must fail silently, not surface as a hook
  // error in the TUI.
  writePosixScript(
    scriptFile,
    `#!/bin/sh
command -v notify-send >/dev/null 2>&1 && notify-send ${shellSingleQuote(title)} ${shellSingleQuote(body)}
exit 0
`
  );
  return `sh "${scriptFile}"`;
}

/** sh chokes on CRLF (`then\r`, `fi\r`), whatever line endings the source file was stored with. */
export function writePosixScript(file: string, contents: string): void {
  fs.writeFileSync(file, contents.replace(/\r\n/g, "\n"));
}

/**
 * Builds a hook command that prints a file's contents on stdout — the context file, for the
 * `UserPromptSubmit` hook whose plain stdout an agent appends to the prompt. Shared by Claude
 * Code and Codex: both treat a hook's non-JSON stdout the same way, so the same script does for
 * either.
 *
 * Which shell a hook runs under on win32 is environment-dependent — PowerShell, cmd.exe and Git
 * Bash were all observed for Claude Code's own hooks — so builtins like `type` are unreliable. An
 * explicit `powershell -File` invocation is parsed identically by all three.
 */
export function buildReadFileCommand(storageDir: string, scriptName: string, targetFile: string): string {
  if (process.platform !== "win32") {
    return `cat ${shellSingleQuote(targetFile)}`;
  }
  const scriptFile = path.join(storageDir, `${scriptName}.ps1`);
  // Quoted the literal way in both shells: every path we generate has the user's own name in
  // it, and a "$" in that would otherwise be read as a variable rather than as a character.
  fs.writeFileSync(
    scriptFile,
    WIN_BOM +
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nGet-Content -Raw ${powershellSingleQuote(targetFile)}\n`
  );
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wraps a value as a POSIX sh single-quoted string, safe for any content. */
export function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * The same for PowerShell, whose single-quoted strings are literal too — `$` and `$(...)` in
 * a path (the user's own name is part of every path we generate) would otherwise be read as
 * a variable or a command substitution.
 */
export function powershellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}
