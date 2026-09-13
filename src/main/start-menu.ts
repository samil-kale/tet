import * as path from "node:path";
import { app, shell } from "electron";
import { INSTALLED_ARG } from "../shared/launch";

/**
 * The Start menu entry of an npm install on Windows, carrying tet's AppUserModelID. Windows finds
 * a taskbar button's name, icon and relaunch command through a shortcut with the window's id:
 * without it, pinning the running window pins a bare electron.exe named "Electron" (measured;
 * `BrowserWindow.setAppDetails` did not change what was pinned). Measured too: the entry names
 * the button only from the start after the one that wrote it, and does not name toasts — that is
 * the registry entry in src/cli/shortcuts.ts. Written by the app rather than a script, since only
 * a shell API sets the id on a shortcut — the way Squirrel apps put theirs in place from their own
 * process. Rewritten whenever it is missing or points elsewhere, as after a move to another prefix.
 */
export function writeStartMenuShortcut(appUserModelId: string): void {
  const file = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "TET.lnk");
  const details = {
    target: process.execPath,
    args: `"${path.join(__dirname, "..")}" ${INSTALLED_ARG}`,
    description: "Git workspace for coding agents",
    icon: path.join(__dirname, "icon.ico"),
    iconIndex: 0,
    appUserModelId
  };
  try {
    const current = shell.readShortcutLink(file);
    if (current.target === details.target && current.args === details.args && current.appUserModelId === appUserModelId) {
      return;
    }
  } catch {
    // None there yet.
  }
  if (!shell.writeShortcutLink(file, "create", details)) {
    throw new Error(`could not write ${file}`);
  }
}
