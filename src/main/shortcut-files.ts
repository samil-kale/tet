import { shellSingleQuote } from "./terminals/script-text";

/**
 * The texts behind tet's shortcuts on Linux and macOS (shortcuts.ts writes them). Both start tet
 * the way the `tet` command does — the node it ran under, running dist/tet.js — so electron's
 * binary is fetched and macOS's bundle named whenever that is still to do, after an update too.
 */

/** A value inside a desktop entry's `Exec`, quoted as the spec asks: `"`, `` ` ``, `$` and `\`
 *  escaped by a backslash inside double quotes. */
function execQuote(value: string): string {
  return `"${value.replace(/(["`$\\])/g, "\\$1")}"`;
}

/** The freedesktop.org desktop entry: the application menu's `tet-ide.desktop`, and the desktop's. */
export function desktopEntry(node: string, launcher: string, icon: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=TET",
    "Comment=Git workspace for coding agents",
    `Exec=${execQuote(node)} ${execQuote(launcher)}`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Development;",
    ""
  ].join("\n");
}

/** The executable of `~/Applications/TET.app`: nothing but the `tet` command. */
export function macLauncherScript(node: string, launcher: string): string {
  return `#!/bin/sh\nexec ${shellSingleQuote(node)} ${shellSingleQuote(launcher)}\n`;
}

/**
 * `~/Applications/TET.app`'s Info.plist. `LSUIElement`: the wrapper only runs the command and
 * quits, and without it would bounce in the Dock beside the TET it starts.
 */
export function macInfoPlist(): string {
  const entries: [string, string][] = [
    ["CFBundleName", "TET"],
    ["CFBundleDisplayName", "TET"],
    ["CFBundleIdentifier", "com.samilkale.tet.launcher"],
    ["CFBundleExecutable", "tet"],
    ["CFBundleIconFile", "tet.icns"],
    ["CFBundlePackageType", "APPL"]
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries.map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`),
    "  <key>LSUIElement</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}
