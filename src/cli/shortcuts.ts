import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { shellSingleQuote, WIN_BOM, writePosixScript } from "../shared/script-text";

/**
 * What an npm install lacks that an installer gave: an entry in the Start menu, the application
 * menu or ~/Applications, an icon on the desktop (Windows and Linux; macOS keeps apps off the
 * desktop), and on Windows the name and icon its toasts are headed with. The `tet` command has
 * them put in place by a script of their own, run once tet is already starting: that is where a
 * virus scanner or a protected folder refuses, and a refusal — or the script being killed
 * outright — costs those things and never tet. What failed goes to `failed.log` beside the script.
 *
 * Attempted once per node and package directory (the stamp), not once per start: a shortcut the
 * user deleted stays deleted, and a scanner that refused is not asked again at every start.
 */

/** tet's toasts are headed by what Windows finds for this id; main.ts sets it on the process. */
const APP_USER_MODEL_ID = "com.samilkale.tet";

/** A PowerShell start takes a second or two on a slow machine; a scanner holding it, longer. */
const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Windows: the two shortcuts through `WScript.Shell`, the toast name as a `DisplayName`/`IconUri`
 * under `HKCU\Software\Classes\AppUserModelId\<id>` — per user, no rights needed. Each on its own:
 * one refused leaves the others standing. The shortcuts start electron with the package directly,
 * since one to node would open a console window beside tet; that binary is fetched again by the
 * update right after it replaces it (tet-update.ts).
 */
const INSTALL_PS1 = `param([string]$Electron, [string]$PackageDir, [string]$Node, [string]$AppId, [string]$Log)
$failed = @()
function Write-Shortcut([string]$Dir) {
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $Dir 'TET.lnk'))
  $link.TargetPath = $Electron
  $link.Arguments = '"' + $PackageDir + '" --tet-node="' + $Node + '"'
  $link.IconLocation = (Join-Path $PackageDir 'dist\\icon.ico') + ',0'
  $link.Description = 'Git workspace for coding agents'
  $link.Save()
}
try { Write-Shortcut ([Environment]::GetFolderPath('Programs')) } catch { $failed += "Start menu entry: $_" }
try { Write-Shortcut ([Environment]::GetFolderPath('Desktop')) } catch { $failed += "desktop icon: $_" }
try {
  $key = "HKCU:\\Software\\Classes\\AppUserModelId\\$AppId"
  New-Item -Path $key -Force -ErrorAction Stop | Out-Null
  Set-ItemProperty -Path $key -Name DisplayName -Value 'TET' -ErrorAction Stop
  Set-ItemProperty -Path $key -Name IconUri -Value (Join-Path $PackageDir 'dist\\icon.png') -ErrorAction Stop
} catch { $failed += "notification name: $_" }
if ($failed.Count -gt 0) { Set-Content -LiteralPath $Log -Value $failed -Encoding UTF8 }
`;

/**
 * Linux and macOS: the entries are written by the `tet` command into the staging directory and
 * only copied into place here, so what they contain stays in TypeScript and tested.
 */
const INSTALL_SH = `#!/bin/sh
staged=$1
log=$2
failed=
if [ -d "$staged/TET.app" ]; then
  # The icon only for this wrapper, tet's own bundle: electron's, which runs the window, is left as
  # it came, so its Dock entry reads Electron. sips and iconutil ship with every macOS.
  iconset="$staged/tet.iconset"
  ( mkdir -p "$iconset" &&
    for size in 16 32 128 256 512; do
      sips -z $size $size "$staged/icon.png" --out "$iconset/icon_\${size}x\${size}.png" >/dev/null &&
      sips -z $((size * 2)) $((size * 2)) "$staged/icon.png" --out "$iconset/icon_\${size}x\${size}@2x.png" >/dev/null || exit 1
    done &&
    iconutil -c icns "$iconset" -o "$staged/TET.app/Contents/Resources/tet.icns" ) || failed="$failed app icon;"
  { mkdir -p "$HOME/Applications" && rm -rf "$HOME/Applications/TET.app" && cp -R "$staged/TET.app" "$HOME/Applications/"; } || failed="$failed applications entry;"
else
  apps="\${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  { mkdir -p "$apps" && cp "$staged/tet-ide.desktop" "$apps/tet-ide.desktop"; } || failed="$failed application menu entry;"
  desktop=$(xdg-user-dir DESKTOP 2>/dev/null) || desktop="$HOME/Desktop"
  # A desktop runs an entry on it only if it is executable; the directory is not created here.
  if [ -d "$desktop" ]; then
    { cp "$staged/tet-ide.desktop" "$desktop/tet-ide.desktop" && chmod 755 "$desktop/tet-ide.desktop"; } || failed="$failed desktop icon;"
  fi
fi
[ -z "$failed" ] || printf '%s\\n' "$failed" > "$log"
`;

/** A value inside a desktop entry's `Exec`, quoted as the spec asks: `"`, `` ` ``, `$` and `\`
 *  escaped by a backslash inside double quotes. */
function execQuote(value: string): string {
  return `"${value.replace(/(["`$\\])/g, "\\$1")}"`;
}

/** The freedesktop.org desktop entry, for the application menu and the desktop alike. It runs the
 *  `tet` command, which fetches electron's binary whenever that is still to do. */
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

/** Lays out what the POSIX script copies into place. */
function stage(dir: string, node: string, launcher: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  const icon = path.join(path.dirname(launcher), "icon.png");
  if (process.platform === "darwin") {
    const contents = path.join(dir, "TET.app", "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
    fs.writeFileSync(path.join(contents, "Info.plist"), macInfoPlist());
    const executable = path.join(contents, "MacOS", "tet");
    writePosixScript(executable, macLauncherScript(node, launcher));
    fs.chmodSync(executable, 0o755);
    // Turned into the bundle's tet.icns by the script.
    fs.copyFileSync(icon, path.join(dir, "icon.png"));
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tet-ide.desktop"), desktopEntry(node, launcher, icon));
  }
}

/** Starts the shortcut script when this node and package have not had it run yet. */
export function installShortcuts(userData: string, electronPath: string, packageDir: string, node: string): void {
  const dir = path.join(userData, "shortcuts");
  const stampFile = path.join(dir, "stamp");
  const stamp = JSON.stringify({ node, packageDir });
  try {
    if (fs.readFileSync(stampFile, "utf8") === stamp) {
      return;
    }
  } catch {
    // Never attempted.
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stampFile, stamp);
  const log = path.join(dir, "failed.log");
  fs.rmSync(log, { force: true });

  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    const script = path.join(dir, "install.ps1");
    // PowerShell 5.1 reads a script without a BOM as ANSI, which garbles a non-ASCII user name.
    fs.writeFileSync(script, WIN_BOM + INSTALL_PS1);
    command = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, electronPath, packageDir, node, APP_USER_MODEL_ID, log];
  } else {
    const staged = path.join(dir, "files");
    stage(staged, node, path.join(packageDir, "dist", "tet.js"));
    const script = path.join(dir, "install.sh");
    writePosixScript(script, INSTALL_SH);
    command = "/bin/sh";
    args = [script, staged, log];
  }
  // Waited for rather than detached: measured on win32, a detached powershell.exe has no console
  // and exits 0 without running the script. tet is already starting by now, and the wait is only
  // on the first start of an install; a script killed or hanging ends here and nowhere else.
  spawnSync(command, args, { stdio: "ignore", windowsHide: true, timeout: SCRIPT_TIMEOUT_MS });
}
