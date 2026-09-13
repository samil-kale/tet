import * as fs from "node:fs";
import * as path from "node:path";
import { app, shell } from "electron";
import { desktopEntry, macInfoPlist, macLauncherScript } from "./shortcut-files";
import { writePosixScript } from "./terminals/script-text";

/** The package tet runs from: main.js sits in its dist/. */
const PACKAGE_DIR = path.join(__dirname, "..");
const LAUNCHER = path.join(__dirname, "tet.js");

/**
 * What an npm install lacks that an installer gave: an entry in the Start menu, the application
 * menu or ~/Applications, and an icon on the desktop (Windows and Linux; macOS keeps apps off the
 * desktop). Written at startup by tet started through its `tet` command — only when what they
 * point at differs from the last time they were written (a marker in userData), so a shortcut the
 * user deleted stays deleted until tet moves to another node or prefix.
 *
 * Windows' shortcuts start electron with the package directly: a shortcut to node would open a
 * console window beside tet. That binary is missing after an update until something fetches it,
 * which is why the update does so itself (tet-update.ts). The Linux and macOS ones run the `tet`
 * command, which fetches it and names the macOS bundle.
 */
export function writeShortcuts(node: string, appUserModelId: string): void {
  const marker = path.join(app.getPath("userData"), "shortcuts");
  const stamp = JSON.stringify({ node, packageDir: PACKAGE_DIR, electron: process.execPath });
  try {
    if (fs.readFileSync(marker, "utf8") === stamp) {
      return;
    }
  } catch {
    // Never written.
  }
  if (process.platform === "win32") {
    writeWindowsShortcuts(node, appUserModelId);
  } else if (process.platform === "darwin") {
    writeMacApp(node);
  } else {
    writeLinuxEntries(node);
  }
  fs.writeFileSync(marker, stamp);
}

function writeWindowsShortcuts(node: string, appUserModelId: string): void {
  const startMenu = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  const places = [startMenu, app.getPath("desktop")].filter((dir) => fs.existsSync(dir));
  for (const dir of places) {
    // appUserModelId: the shortcut names tet's toasts too, as the installers' shortcut did.
    const written = shell.writeShortcutLink(path.join(dir, "TET.lnk"), "create", {
      target: process.execPath,
      args: `"${PACKAGE_DIR}" --tet-node="${node}"`,
      description: "Git workspace for coding agents",
      icon: path.join(__dirname, "icon.ico"),
      iconIndex: 0,
      appUserModelId
    });
    if (!written) {
      throw new Error(`could not write ${path.join(dir, "TET.lnk")}`);
    }
  }
}

/** Beside the target and renamed into place: the desktop reads these files while tet writes. */
function replaceFile(file: string, contents: string, mode?: number): void {
  const temp = `${file}.tmp`;
  if (mode === undefined) {
    fs.writeFileSync(temp, contents);
  } else {
    writePosixScript(temp, contents);
    fs.chmodSync(temp, mode);
  }
  fs.renameSync(temp, file);
}

function writeLinuxEntries(node: string): void {
  const entry = desktopEntry(node, LAUNCHER, path.join(__dirname, "icon.png"));
  const dataHome = process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share");
  const applications = path.join(dataHome, "applications");
  fs.mkdirSync(applications, { recursive: true });
  replaceFile(path.join(applications, "tet-ide.desktop"), entry);
  // A desktop runs an entry on it only if it is executable; the directory is not created here.
  const desktop = app.getPath("desktop");
  if (fs.existsSync(desktop)) {
    replaceFile(path.join(desktop, "tet-ide.desktop"), entry, 0o755);
  }
}

/**
 * `~/Applications/TET.app`, a bundle holding nothing but the `tet` command, with the icon the
 * command put into electron's own bundle (brandMacBundle in src/cli/tet.ts).
 */
function writeMacApp(node: string): void {
  const contents = path.join(app.getPath("home"), "Applications", "TET.app", "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  replaceFile(path.join(contents, "Info.plist"), macInfoPlist());
  replaceFile(path.join(contents, "MacOS", "tet"), macLauncherScript(node, LAUNCHER), 0o755);
  const icon = path.resolve(process.execPath, "..", "..", "Resources", "electron.icns");
  if (fs.existsSync(icon)) {
    fs.copyFileSync(icon, path.join(contents, "Resources", "tet.icns"));
  }
}
