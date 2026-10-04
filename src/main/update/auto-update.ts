import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app, net } from "electron";
import * as originalFs from "original-fs";
import * as semver from "semver";
import writeFileAtomic from "write-file-atomic";
import { assetName, installRoot, preparedRoot, resourcesDir, rootExecutable, rootIn, runningUpdater, updateLockPath } from "../../shared/release";
import { PLATFORM } from "../util/host-platform";
import type { UpdateResult } from "../../shared/release";
import type { NoticeProgress, NoticeSeverity } from "../../shared/types/app";
import { isRecord, readJson } from "../util/json-file";
import { resumableDownload } from "./resumable-download";
import { runProcess } from "../util/process";
import { logError } from "../util/error-log";

/** Not urgent: an update installs only once TET quits. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const CHECK_TIMEOUT_MS = 15_000;
/** Generous for a large archive. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** An updater lives for a minute or two at most (tet-update.ts's waits). */
const UPDATER_POLL_MS = 2000;

type Notice = (severity: NoticeSeverity, message: string) => void;
type ShowProgress = (progress: NoticeProgress) => void;

/**
 * Unpacked (`root`) and copied beside the install (`prepared`) this session, for
 * `installPendingUpdate`. Set only once the copy is whole, cleared before another one begins.
 */
let pending: { version: string; root: string; prepared: string } | undefined;

/** Set by startAutoUpdate, always before `pending`. */
let dataRoot = "";

function updateDir(): string {
  return path.join(dataRoot, "update");
}

function resultPath(): string {
  return path.join(updateDir(), "result.json");
}

/** Kept until unpacked: a download cut short continues from it (`resumableDownload`). */
function archivePath(version: string, asset: string): string {
  return path.join(updateDir(), `${version}-${asset}`);
}

/**
 * Resolves once no updater runs: until then its unpack folder, which the sweep and `stage` would
 * remove, is the one it runs from, and its result is not written yet.
 */
async function updaterDone(): Promise<void> {
  while (runningUpdater(updateLockPath(updateDir())) !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, UPDATER_POLL_MS));
  }
}

/** The last update's result, reported once and deleted. */
function reportLastUpdate(notice: Notice): void {
  const file = resultPath();
  const result = readJson(file) as UpdateResult | undefined;
  if (result === undefined) {
    return;
  }
  fs.rmSync(file, { force: true });
  if (!isRecord(result)) {
    return;
  }
  if (result.ok) {
    notice("info", `Updated to ${result.version}`);
  } else {
    logError(`update to ${result.version} failed:\n${result.output}`);
    notice("error", `Update to ${result.version} failed, update with: ${PLATFORM.installCommand}`);
  }
}

/**
 * Removes earlier sessions' unpacked updates and a copy beside the install a quit left unfinished
 * or uninstalled. Best effort: on win32 the updater may still hold its executable briefly after
 * writing its result. Awaited before the first check, whose `stage` may write into the swept
 * folders. Removed with original-fs: electron's fs opens `app.asar` as an archive and fails its rm
 * with EBUSY. A download cut short stays for `stage` to continue.
 */
async function sweepUpdateDir(asset: string, root: string): Promise<void> {
  await originalFs.promises.rm(preparedRoot(root), { recursive: true, force: true }).catch(() => undefined);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(updateDir());
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry !== path.basename(resultPath()) && !entry.endsWith(`-${asset}`))
      .map((entry) => originalFs.promises.rm(path.join(updateDir(), entry), { recursive: true, force: true }).catch(() => undefined))
  );
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read off the redirect of `<releases>/latest` — no API request, no rate limit. `net.request`, not
 * `net.fetch`: the latter throws on `redirect: "manual"` and leaves a followed response's `url`
 * empty.
 */
function latestVersion(releasesUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = net.request({ url: `${releasesUrl}/latest`, redirect: "manual" });
    const timer = setTimeout(() => request.abort(), CHECK_TIMEOUT_MS);
    const done = (location: string | undefined) => {
      clearTimeout(timer);
      const tag = location === undefined ? undefined : /\/tag\/v?([^/?#]+)$/.exec(location)?.[1];
      resolve(tag && semver.valid(tag) ? tag : undefined);
    };
    request.on("redirect", (_status, _method, location) => {
      request.abort();
      done(location);
    });
    request.on("response", () => {
      request.abort();
      done(undefined);
    });
    request.on("abort", () => done(undefined));
    request.on("error", () => done(undefined));
    request.end();
  });
}

/** Also unpacks the zip: Windows' tar is bsdtar. */
async function unpack(archive: string, into: string): Promise<void> {
  const tar = PLATFORM.tarExecutable(process.env);
  const result = await runProcess(tar, ["-xf", archive, "-C", into]);
  if (result.code !== 0) {
    throw result.error ?? new Error(`tar exited with ${result.code}: ${result.stderr}`);
  }
}

/** The install root inside an unpacked archive: at its top, or one folder down. */
function findRoot(dir: string): string | undefined {
  const candidates = [dir, ...fs.readdirSync(dir).map((entry) => path.join(dir, entry))];
  for (const candidate of candidates) {
    const root = rootIn(candidate, PLATFORM);
    if (fs.existsSync(rootExecutable(root, PLATFORM))) {
      return root;
    }
  }
  return undefined;
}

/**
 * Fetches and unpacks a version, then copies it beside the install root (`preparedRoot`), so the
 * quit only swaps the two and a TET started right after it rarely finds the old one. The unpacked
 * folder stays: the updater runs from it, and on win32 a folder a process runs from cannot be
 * renamed into place. Plain fetch, never electron's download manager: on macOS it quarantines the
 * file, and Gatekeeper would refuse the ad-hoc signed bundle. A failed download keeps its part for
 * the next try; once unpacked, or refused by tar, the archive goes; a failed copy goes whole.
 */
async function stage(
  releasesUrl: string,
  asset: string,
  version: string,
  installed: string,
  onProgress: (fraction: number) => void,
  onPreparing: () => void
): Promise<{ root: string; prepared: string }> {
  const dir = path.join(updateDir(), version);
  await originalFs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  const archive = archivePath(version, asset);
  // Parts of versions overtaken.
  for (const entry of await fs.promises.readdir(updateDir())) {
    if (entry.endsWith(`-${asset}`) && entry !== path.basename(archive)) {
      await fs.promises.rm(path.join(updateDir(), entry), { force: true });
    }
  }
  await resumableDownload(`${releasesUrl}/download/v${version}/${asset}`, archive, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), onProgress);
  onPreparing();
  try {
    await unpack(archive, dir);
  } finally {
    await fs.promises.rm(archive, { force: true });
  }
  const root = findRoot(dir);
  if (!root) {
    throw new Error(`no ${path.basename(rootExecutable(".", PLATFORM))} in ${asset}`);
  }
  const prepared = preparedRoot(installed);
  try {
    await originalFs.promises.rm(prepared, { recursive: true, force: true });
    // original-fs, as in the sweep: electron's fs reads app.asar as a folder.
    await originalFs.promises.cp(root, prepared, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    await originalFs.promises.rm(prepared, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { root, prepared };
}

/**
 * Installs only (`app.isPackaged`). Checks at startup and every four hours; a newer version is
 * fetched, unpacked and copied beside the install at once — one notice from the download's share
 * to the announcement it ends on, which goes silently if any step fails — announced once, and
 * installed on quit (`installPendingUpdate`) —
 * never mid-session, a tab being a live agent session. If TET cannot replace its own folder, the
 * notice carries the install command instead.
 *
 * `releasesUrl` is `RELEASES_URL` except for test/e2e/install.test.ts.
 */
export function startAutoUpdate(
  installed: boolean,
  releasesUrl: string,
  tetDataRoot: string,
  notice: Notice,
  showProgress: ShowProgress
): void {
  dataRoot = tetDataRoot;
  const asset = assetName(PLATFORM, process.arch);
  if (!installed || !asset) {
    return;
  }
  const root = installRoot(process.execPath, PLATFORM);
  const writable = isWritable(root) && isWritable(path.dirname(root));
  let announced: string | undefined;
  let checking = false;

  const check = async () => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      // Silent on failure, or an offline machine gets a notice every four hours.
      const latest = await latestVersion(releasesUrl);
      if (!latest || !semver.gt(latest, app.getVersion()) || latest === announced) {
        return;
      }
      if (!writable) {
        announced = latest;
        notice("info", `Update ${latest} available, update with: ${PLATFORM.installCommand}`);
        return;
      }
      // The copy beside the install is about to change: no quit installs it until it is whole again.
      pending = undefined;
      const message = `Downloading update ${latest}`;
      let percent = 0;
      showProgress({ key: "update", message, fraction: 0 });
      let staged: { root: string; prepared: string };
      try {
        staged = await stage(
          releasesUrl,
          asset,
          latest,
          root,
          (fraction) => {
            // One message per percent, not per chunk.
            if (Math.floor(fraction * 100) > percent) {
              percent = Math.floor(fraction * 100);
              showProgress({ key: "update", message, fraction });
            }
          },
          () => showProgress({ key: "update", message: `Preparing update ${latest}`, fraction: null })
        );
      } catch (error) {
        // Tried again at the next check.
        logError(`could not fetch the update to ${latest}`, error);
        showProgress({ key: "update", message, fraction: undefined });
        return;
      }
      pending = { version: latest, ...staged };
      announced = latest;
      showProgress({ key: "update", message: `Update ${latest} ready, installs when you quit TET`, fraction: undefined, done: true });
    } finally {
      checking = false;
    }
  };

  void updaterDone().then(async () => {
    // A failed report or sweep must not end the checks for the session.
    try {
      reportLastUpdate(notice);
      await sweepUpdateDir(asset, root);
    } catch (error) {
      logError("could not prepare the update folder", error);
    }
    await check();
    setInterval(() => void check(), CHECK_INTERVAL_MS);
  });
}

/**
 * Starts the pending update to run after this process exits: at the end of a quit, not a restart
 * (a relaunched TET would hold the folder being replaced). Run by the *new* binary as node from its
 * unpack folder — no node on the machine to count on, and the installed binary gets replaced — and
 * handed the copy beside the install to swap in.
 */
export function installPendingUpdate(): void {
  if (!pending) {
    return;
  }
  try {
    const resources = resourcesDir(pending.root, PLATFORM);
    const script = path.join(resources, "app.asar.unpacked", "dist", "tet-update.js");
    const args = [
      script,
      String(process.pid),
      pending.version,
      pending.root,
      installRoot(process.execPath, PLATFORM),
      resultPath(),
      pending.prepared
    ];
    const child = spawn(rootExecutable(pending.root, PLATFORM), args, {
      cwd: updateDir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    child.on("error", (error) => logError("could not start the update", error));
    child.unref();
    // Written here, not by the updater: a TET started right after this quit must already see it.
    if (child.pid !== undefined) {
      writeFileAtomic.sync(updateLockPath(updateDir()), String(child.pid));
    }
  } catch (error) {
    logError("could not start the update", error);
  }
}
