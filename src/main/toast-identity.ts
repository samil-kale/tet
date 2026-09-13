import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The name and icon Windows heads tet's toasts with. Windows reads them off whatever carries the
 * AppUserModelID: a Start Menu shortcut, which an npm install does not have, or else a
 * `DisplayName`/`IconUri` under `HKCU\Software\Classes\AppUserModelId\<id>` — per user, no rights
 * needed, and this one key is all tet writes there. Without it the toasts read "Electron".
 *
 * Written through `reg.exe`, spawned directly, and only when the icon path it names changed since
 * the last write (a marker in userData): the path moves with a different install prefix, and two
 * processes per start would be spent for nothing otherwise.
 */
export async function writeToastIdentity(appUserModelId: string, iconPath: string, userDataPath: string): Promise<void> {
  const marker = path.join(userDataPath, "toast-identity");
  const stamp = `${appUserModelId}\n${iconPath}`;
  try {
    if (fs.readFileSync(marker, "utf8") === stamp) {
      return;
    }
  } catch {
    // Never written.
  }
  const reg = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appUserModelId}`;
  await execFileAsync(reg, ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "TET", "/f"], { windowsHide: true });
  await execFileAsync(reg, ["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath, "/f"], { windowsHide: true });
  fs.writeFileSync(marker, stamp);
}
