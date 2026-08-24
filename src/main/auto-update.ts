import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { NoticeSeverity } from "../shared/types";

/**
 * How often to check after the first, startup check. A closed tab's session and a running
 * terminal both survive an update fine — it only installs at the start of the next launch — so
 * there is no urgency to check more often than this.
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const RELEASES_URL = "https://github.com/samil-kale/tet/releases/latest";

/**
 * How long `installPendingUpdate` waits for the cached download to be re-validated before giving
 * up and letting the app start normally. Generous but bounded: revalidating a cached file only
 * costs the small manifest fetch, never a re-download, so this should resolve in well under a
 * second on any reachable network.
 */
const PENDING_UPDATE_TIMEOUT_MS = 8000;

/** The filename is the whole message, same idiom as the session turn markers in marker-watch.ts. */
function pendingUpdateMarkerPath(): string {
  return path.join(app.getPath("userData"), "update-pending-install");
}

function canInstallOnThisPlatform(): boolean {
  return process.platform === "win32" || Boolean(process.env.APPIMAGE);
}

/**
 * Installs an update that finished downloading in a previous session, if any — called before
 * the first window opens. A full download used to install via `autoInstallOnAppQuit`'s detached,
 * unmonitored installer process, spawned on quit and left to run after the app already exited:
 * racy, since a user who reopens tet before that installer finishes launches the not-yet-replaced
 * binary, which the installer then force-closes to be able to replace it. Installing here instead
 * — before any project or terminal exists — means there is nothing yet to lose: quitAndInstall's
 * own relaunch brings up the new version by itself.
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
 * output never has, and would just fail every check.
 *
 * `autoInstallOnAppQuit` is turned off — see `installPendingUpdate` above for why installing on
 * quit is racy — so a download finishing here only drops the marker `installPendingUpdate` acts
 * on at the start of the next launch. Never calls `quitAndInstall` itself mid-session — a
 * terminal tab is a live agent session, same reason this app never restarts itself elsewhere
 * (see CLAUDE.md, "Do not restart the app yourself").
 *
 * Two platforms can only be told, not updated, so they fall back to "update-available" plus a
 * link to the releases page instead of downloading:
 * - macOS: Squirrel.Mac refuses to replace an unsigned, unnotarized bundle, which this one is
 *   (see CLAUDE.md on code signing — deliberately skipped).
 * - Linux when not running from the AppImage: electron-updater's Linux updater only knows how
 *   to replace an AppImage (recognised by the `APPIMAGE` env var electron-builder's AppImage
 *   sets at launch); a deb install has no such mechanism, and would otherwise fail every check
 *   behind the silent error handler below, never telling that user anything.
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
    // Ticks the same notice's progress in place rather than a fresh notice per event — see
    // Notices.tsx, which tracks the one in-flight progress notice by id for exactly this.
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
  // every four hours for something nobody asked for, same reasoning as Repository.autoFetch.
  autoUpdater.on("error", () => undefined);

  void autoUpdater.checkForUpdates().catch(() => undefined);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), CHECK_INTERVAL_MS);
}
