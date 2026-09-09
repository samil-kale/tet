import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { NoticeSeverity } from "../shared/types";

/** How often to check after the first, startup check. An update only installs at the start of the
 *  next launch, so nothing is urgent about finding one. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const RELEASES_URL = "https://github.com/samil-kale/tet/releases/latest";

/** How long `installPendingUpdate` waits for the cached download to be re-validated before letting
 *  the app start: that costs only the small manifest fetch, never a re-download. */
const PENDING_UPDATE_TIMEOUT_MS = 8000;

/** The filename is the whole message, same idiom as the session turn markers in marker-watch.ts. */
function pendingUpdateMarkerPath(): string {
  return path.join(app.getPath("userData"), "update-pending-install");
}

function canInstallOnThisPlatform(): boolean {
  return process.platform === "win32" || Boolean(process.env.APPIMAGE);
}

/**
 * Installs an update that finished downloading in a previous session, before the first window
 * opens. Not through `autoInstallOnAppQuit`: its detached installer, spawned on quit and left
 * running after the app exited, raced a user reopening tet — which launched the not-yet-replaced
 * binary the installer then force-closed. Here no project or terminal exists yet to lose, and
 * quitAndInstall's own relaunch brings up the new version.
 *
 * Returns true if it quit the app to install; the caller must stop startup right there.
 */
export async function installPendingUpdate(): Promise<boolean> {
  if (!app.isPackaged) {
    return false;
  }
  const marker = pendingUpdateMarkerPath();
  if (!fs.existsSync(marker)) {
    return false;
  }
  fs.rmSync(marker, { force: true });
  if (!canInstallOnThisPlatform()) {
    return false;
  }

  autoUpdater.autoDownload = true;
  const downloaded = await new Promise<boolean>((resolve) => {
    const settle = (result: boolean) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle(false), PENDING_UPDATE_TIMEOUT_MS);
    autoUpdater.once("update-downloaded", () => settle(true));
    autoUpdater.once("update-not-available", () => settle(false));
    autoUpdater.once("error", () => settle(false));
    void autoUpdater.checkForUpdates().catch(() => settle(false));
  });

  if (downloaded) {
    autoUpdater.quitAndInstall();
  }
  return downloaded;
}

/**
 * Runs only in a packaged build: electron-updater reads `app-update.yml`, which esbuild's dev
 * output never has. `autoInstallOnAppQuit` is off (see `installPendingUpdate`), so a download
 * finishing here only drops the marker acted on at the start of the next launch; never
 * `quitAndInstall` mid-session, a terminal tab being a live agent session.
 *
 * Two platforms can only be told, not updated, and fall back to "update-available" plus a link:
 * - macOS: Squirrel.Mac refuses to replace an unsigned, unnotarized bundle, which this one is.
 * - Linux outside the AppImage: electron-updater's Linux updater only replaces an AppImage
 *   (recognised by the `APPIMAGE` env var electron-builder's AppImage sets at launch); a deb
 *   install would otherwise fail every check behind the silent error handler below.
 */
export function startAutoUpdate(
  notify: (severity: NoticeSeverity, message: string, progress?: number) => void
): void {
  if (!app.isPackaged) {
    return;
  }

  const canInstall = canInstallOnThisPlatform();
  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = false;

  if (canInstall) {
    // Ticks the same notice's progress in place — Notices.tsx tracks the in-flight one by id.
    autoUpdater.on("download-progress", (info) => {
      notify("info", `Downloading update ${Math.round(info.percent)}%`, info.percent);
    });
    autoUpdater.on("update-downloaded", (info) => {
      fs.writeFileSync(pendingUpdateMarkerPath(), "");
      notify("info", `Update ${info.version} downloaded, installs on next restart`, 100);
    });
  } else {
    autoUpdater.on("update-available", (info) => {
      notify("info", `Update ${info.version} available: ${RELEASES_URL}`);
    });
  }
  // Silent: an offline machine or a rate-limited check would otherwise put the same notice up
  // every four hours for something nobody asked for.
  autoUpdater.on("error", () => undefined);

  void autoUpdater.checkForUpdates().catch(() => undefined);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), CHECK_INTERVAL_MS);
}
