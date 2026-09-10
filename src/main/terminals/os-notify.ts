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
 * Where the notifier reads its two strings: the environment of the process running the script,
 * never the script itself. That is what makes one file serve every toast — measured, rewriting
 * the script while a PowerShell still had it open fails outright (`EBUSY`), and that failure
 * travelled up the `hook` verb and swallowed the answer the reporting agent was waiting for. It
 * also ends every quoting question at once: no shell, no script parser and no markup literal
 * ever sees what a user or an agent wrote.
 */
export const NOTIFY_ENV = { title: "TET_NOTIFY_TITLE", body: "TET_NOTIFY_BODY" } as const;

/**
 * The script that shows a native OS notification through each platform's built-in notifier — no
 * extra dependency, no registry writes, no installs. No click action: that needs a registered app
 * identity. Written on first use and whenever its content changed (a tet update), and returned as
 * the plain spawn that runs it. `-File` rather than `-Command`, so the path is never re-parsed by
 * PowerShell; measured through pi's extension on win32 as exactly this shape.
 */
export function ensureNotifyScript(storageDir: string): ScriptInvocation {
  fs.mkdirSync(storageDir, { recursive: true });
  if (process.platform === "win32") {
    const file = path.join(storageDir, "notify.ps1");
    replaceIfChanged(file, WIN_BOM + WINDOWS_SCRIPT);
    return { command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file] };
  }
  const file = path.join(storageDir, "notify.sh");
  // sh chokes on CRLF, whatever this source file is stored with — see writePosixScript.
  replaceIfChanged(file, (process.platform === "darwin" ? MAC_SCRIPT : LINUX_SCRIPT).replace(/\r\n/g, "\n"));
  return { command: "sh", args: [file] };
}

/** Well-known AUMID Windows registers by default for its own PowerShell Start Menu shortcut.
 *  Reusing it creates no registry entry, at the price of attributing the toast to PowerShell. */
const WINDOWS_APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;

/**
 * Single-quoted literals throughout: the interpolating string would read a title as code, and a
 * folder named `cost$analysis` or one with `$(...)` in it is a real name. The toast is markup, so
 * both values are XML-escaped where they are read — `SecurityElement::Escape` covers `& < > " '`.
 * `activationType="protocol"` with an empty launch URI makes the click a no-op; without it the
 * click activates the app behind the AUMID, which pops a dialog about an external application.
 */
const WINDOWS_SCRIPT = `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

try {
  $title = [System.Security.SecurityElement]::Escape($env:${NOTIFY_ENV.title})
  $body = [System.Security.SecurityElement]::Escape($env:${NOTIFY_ENV.body})
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast activationType="protocol" launch=""><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual></toast>')
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}')
  $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch {}
`;

/** `system attribute` reads osascript's own environment, so no AppleScript string literal is
 *  built around either value and nothing in them needs escaping. */
const MAC_SCRIPT = `#!/bin/sh
osascript -e 'display notification (system attribute "${NOTIFY_ENV.body}") with title (system attribute "${NOTIFY_ENV.title}")' >/dev/null 2>&1
exit 0
`;

/** Guarded with `command -v`: notify-send ships with most desktop distros but not minimal or
 *  headless ones, and a missing binary must fail silently rather than as a hook error. `--` so a
 *  title that happens to start with a dash stays a title. */
const LINUX_SCRIPT = `#!/bin/sh
command -v notify-send >/dev/null 2>&1 && notify-send -- "$${NOTIFY_ENV.title}" "$${NOTIFY_ENV.body}"
exit 0
`;

/** Written beside the target and renamed into place, and only when it would differ: the file is
 *  read by another process, and on Windows a read landing mid-write fails outright. */
function replaceIfChanged(file: string, contents: string): void {
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing === contents) {
    return;
  }
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, file);
}

/** sh chokes on CRLF (`then\r`, `fi\r`), whatever line endings the source file was stored with. */
export function writePosixScript(file: string, contents: string): void {
  fs.writeFileSync(file, contents.replace(/\r\n/g, "\n"));
}

/** Wraps a value as a POSIX sh single-quoted string, safe for any content. */
export function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
