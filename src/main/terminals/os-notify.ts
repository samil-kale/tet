import * as fs from "node:fs";
import * as path from "node:path";

/** PowerShell 5.1 decodes BOM-less files as ANSI, so generated .ps1 files need this. */
export const WIN_BOM = "﻿";

/** What starts a generated script without a shell in between. */
export interface ScriptInvocation {
  command: string;
  args: string[];
}

/**
 * A script that shows a native OS notification through each platform's built-in notifier — no
 * extra dependency, no registry writes, no installs. No click action: that needs a registered app
 * identity. `id` names the script file and must be unique per call site; its path is returned.
 */
export function writeNotifyScript(storageDir: string, id: string, title: string, body: string): string {
  if (process.platform === "win32") {
    return writeWindowsScript(storageDir, id, title, body);
  }
  if (process.platform === "darwin") {
    return writeMacScript(storageDir, id, title, body);
  }
  return writeLinuxScript(storageDir, id, title, body);
}

/** How such a script is started as a plain spawn. `-File` rather than `-Command`, so the path is
 *  never re-parsed by PowerShell. Measured through pi's extension on win32 as exactly this shape. */
export function scriptInvocation(scriptFile: string): ScriptInvocation {
  if (process.platform === "win32") {
    return { command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile] };
  }
  return { command: "sh", args: [scriptFile] };
}

function writeWindowsScript(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.ps1`);
  // Well-known AUMID Windows registers by default for its own PowerShell Start Menu shortcut.
  // Reusing it creates no registry entry, at the price of attributing the toast to PowerShell.
  const appId = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;
  fs.writeFileSync(
    scriptFile,
    WIN_BOM +
      `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

# @'...'@, not @"..."@: the literal here-string. The interpolating one reads the text below as
# code — a folder named "cost$analysis" loses half its name to an empty variable, one with
# $(...) in it runs whatever that says.
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

# activationType="protocol" with an empty launch URI makes the click a no-op. Without it the
# click activates the app behind $appId, which pops a dialog about an external application.
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
try {
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}')
  $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch {}
`
  );
  return scriptFile;
}

function writeMacScript(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.sh`);
  // The values go through env vars read via AppleScript's `system attribute` rather than into
  // the -e string, so no AppleScript string-literal escaping is needed for any title/body.
  writePosixScript(
    scriptFile,
    `#!/bin/sh
TET_TITLE=${shellSingleQuote(title)} TET_BODY=${shellSingleQuote(body)} osascript -e 'display notification (system attribute "TET_BODY") with title (system attribute "TET_TITLE")' >/dev/null 2>&1
exit 0
`
  );
  return scriptFile;
}

function writeLinuxScript(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.sh`);
  // Guarded with `command -v`: notify-send ships with most desktop distros but not
  // minimal/headless ones, and a missing binary must fail silently rather than as a hook error.
  writePosixScript(
    scriptFile,
    `#!/bin/sh
command -v notify-send >/dev/null 2>&1 && notify-send ${shellSingleQuote(title)} ${shellSingleQuote(body)}
exit 0
`
  );
  return scriptFile;
}

/** sh chokes on CRLF (`then\r`, `fi\r`), whatever line endings the source file was stored with. */
export function writePosixScript(file: string, contents: string): void {
  fs.writeFileSync(file, contents.replace(/\r\n/g, "\n"));
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
