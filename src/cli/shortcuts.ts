import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { INSTALLED_ARG } from "../shared/launch";
import { WIN_BOM } from "../shared/script-text";

/**
 * The desktop icon and the toasts' name an installer would have set up on Windows. The `tet`
 * command has them put in place by a PowerShell script of its own, run once tet is already
 * starting: the desktop and the registry are where a virus scanner or a protected folder refuses,
 * and a refusal — or the script being killed outright — costs those and never tet. A failure goes
 * to `failed.log` beside the script. The Start menu entry is the app's own
 * (src/main/start-menu.ts); Linux and macOS get none of it.
 *
 * Attempted once per package directory (the stamp), not once per start: an icon the user deleted
 * stays deleted, and a scanner that refused is not asked again at every start.
 */

/** tet's AppUserModelID, as main.ts sets it on the process. */
const APP_USER_MODEL_ID = "com.samilkale.tet";

/** A PowerShell start takes a second or two on a slow machine; a scanner holding it, longer. */
const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * The desktop icon through `WScript.Shell`, starting electron with the package directly: one to
 * node would open a console window beside tet, and that binary is fetched again by the update right
 * after it replaces it (tet-update.ts). And the toasts' name as a `DisplayName`/`IconUri` under
 * `HKCU\Software\Classes\AppUserModelId\<id>` — per user, no rights needed: measured, the Start
 * menu entry's id names the taskbar button but not a toast. Each on its own, so one refused leaves
 * the other standing. The constants are written into the script rather than passed: measured,
 * `-File` swallows an argument starting with `--` and shifts the ones after it.
 */
const INSTALL_PS1 = `param([string]$Electron, [string]$PackageDir, [string]$Log)
$failed = @()
try {
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'TET.lnk'))
  $link.TargetPath = $Electron
  $link.Arguments = '"' + $PackageDir + '" ${INSTALLED_ARG}'
  $link.IconLocation = (Join-Path $PackageDir 'dist\\icon.ico') + ',0'
  $link.Description = 'Git workspace for coding agents'
  $link.Save()
} catch { $failed += "desktop icon: $_" }
try {
  $key = 'HKCU:\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}'
  New-Item -Path $key -Force -ErrorAction Stop | Out-Null
  Set-ItemProperty -Path $key -Name DisplayName -Value 'TET' -ErrorAction Stop
  Set-ItemProperty -Path $key -Name IconUri -Value (Join-Path $PackageDir 'dist\\icon.png') -ErrorAction Stop
} catch { $failed += "notification name: $_" }
if ($failed.Count -gt 0) { Set-Content -LiteralPath $Log -Value $failed -Encoding UTF8 }
`;

/**
 * Runs the script when this package directory has not had it run yet. Its files sit beside tet's
 * userData — `%APPDATA%\TET`, the directory electron derives from `productName`, or the one a
 * `--user-data-dir=` names.
 */
export function installDesktopIcon(argv: readonly string[], electronPath: string, packageDir: string): void {
  const userData =
    argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ||
    path.join(process.env.APPDATA ?? "", "TET");
  const dir = path.join(path.resolve(userData), "shortcuts");
  const stampFile = path.join(dir, "stamp");
  try {
    if (fs.readFileSync(stampFile, "utf8") === packageDir) {
      return;
    }
  } catch {
    // Never attempted.
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stampFile, packageDir);
  const log = path.join(dir, "failed.log");
  fs.rmSync(log, { force: true });
  const script = path.join(dir, "install.ps1");
  // PowerShell 5.1 reads a script without a BOM as ANSI, which garbles a non-ASCII user name.
  fs.writeFileSync(script, WIN_BOM + INSTALL_PS1);
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
  // Waited for rather than detached: measured, a detached powershell.exe has no console and exits
  // 0 without running the script. tet is already starting by now, and the wait is only on the
  // first start of an install; a script killed or hanging ends here and nowhere else.
  spawnSync(powershell, [...args, electronPath, packageDir, log], {
    stdio: "ignore",
    windowsHide: true,
    timeout: SCRIPT_TIMEOUT_MS
  });
}
