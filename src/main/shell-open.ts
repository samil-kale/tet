import * as path from "node:path";

/**
 * What a ctrl-click may hand the OS (`shell:open-url`, `shell:open-file` in ipc.ts). Both end in
 * ShellExecute, `open` or `xdg-open`, which run a program as readily as they show a page, so terminal
 * output an agent printed must not reach them unchecked.
 */

/** Anything else — `file:`, `ms-msdt:`, a deep link into another app — is refused. */
const OPENABLE_URL_PROTOCOLS = ["http:", "https:", "mailto:"];

/** Run, not shown, by Windows' file associations. */
const WINDOWS_EXECUTABLE_EXTENSIONS = [
  ".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
  ".msi", ".msp", ".lnk", ".scr", ".pif", ".cpl", ".hta", ".reg", ".jar", ".appref-ms", ".url"
];

/** Run by Finder or a Linux desktop, beside anything with an executable bit. */
const UNIX_EXECUTABLE_EXTENSIONS = [".sh", ".command", ".tool", ".app", ".desktop"];

export function isOpenableUrl(url: string): boolean {
  try {
    return OPENABLE_URL_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** `mode` is the file's `fs.Stats.mode`; Windows has no executable bit worth reading. */
export function isExecutableFile(filePath: string, mode: number, platform: NodeJS.Platform = process.platform): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (platform === "win32") {
    return WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension);
  }
  return (mode & 0o111) !== 0 || UNIX_EXECUTABLE_EXTENSIONS.includes(extension);
}
