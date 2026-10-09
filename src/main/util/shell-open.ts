import * as path from "node:path";
import { PLATFORM } from "./host-platform";
import type { Platform } from "../../shared/platform";

/**
 * What a ctrl-click or "Open in external editor" may hand the OS (`shell:open-url`, `shell:open-file`,
 * `shell:open-file-externally` in ipc/shell.ts). All end in ShellExecute, `open` or `xdg-open`, which
 * run a program as readily as they show a page, so terminal output an agent printed, or a file of a
 * cloned repository, must not reach them unchecked.
 */

/** Anything else — `file:`, `ms-msdt:`, a deep link into another app — is refused. */
const OPENABLE_URL_PROTOCOLS = ["http:", "https:", "mailto:"];

/** Run, not shown, by Windows' file associations. */
const WINDOWS_EXECUTABLE_EXTENSIONS = [
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".msi",
  ".msp",
  ".lnk",
  ".scr",
  ".pif",
  ".cpl",
  ".hta",
  ".reg",
  ".jar",
  ".appref-ms",
  ".url",
  ".application",
  ".xbap",
  ".chm",
  ".hlp",
  ".msc",
  ".inf",
  ".ins",
  ".isp",
  ".scf",
  ".vb",
  ".ws",
  ".ps1xml",
  ".ps2",
  ".ps2xml",
  ".psc1",
  ".psc2",
  ".msh",
  ".msh1",
  ".msh2",
  ".mshxml",
  ".msh1xml",
  ".msh2xml",
  ".gadget",
  ".diagcab",
  ".xll",
  ".website",
  ".library-ms",
  ".search-ms",
  ".settingcontent-ms",
  ".appx",
  ".appxbundle",
  ".msix",
  ".msixbundle",
];

/** Run by Finder or a Linux desktop, beside anything with an executable bit: a `.terminal` carries a
 *  command, a `.fileloc` or `.inetloc` starts what it points at. */
const UNIX_EXECUTABLE_EXTENSIONS = [
  ".sh",
  ".command",
  ".tool",
  ".app",
  ".desktop",
  ".terminal",
  ".workflow",
  ".action",
  ".fileloc",
  ".inetloc",
  ".pkg",
  ".mpkg",
];

export function isOpenableUrl(url: string): boolean {
  try {
    return OPENABLE_URL_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** `mode` is the file's `fs.Stats.mode`, unread where a file runs by its extension. */
export function isExecutableFile(filePath: string, mode: number, platform: Platform = PLATFORM): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (platform.executableByExtension) {
    return WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension);
  }
  return (mode & 0o111) !== 0 || UNIX_EXECUTABLE_EXTENSIONS.includes(extension);
}
