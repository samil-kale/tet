import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import * as originalFs from "original-fs";
import * as semver from "semver";
import writeFileAtomic from "write-file-atomic";
import { assetName, installCommand, installRoot, rootExecutable, runningUpdater, updateLockPath } from "../shared/release";
import type { UpdateResult } from "../shared/release";
import type { NoticeSeverity } from "../shared/types";
import { readJson } from "./json-file";
import { resumableDownload } from "./resumable-download";
import { runProcess } from "./run-process";

/** Not urgent: an update installs only once tet quits. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const CHECK_TIMEOUT_MS = 15_000;
/** Generous for a large archive. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** An updater lives for a minute or two at most (tet-update.ts's waits). */
const UPDATER_POLL_MS = 2000;

type Notify = (severity: NoticeSeverity, message: string) => void;

/** Unpacked this session, for `installPendingUpdate`. */
let pending: { version: string; root: string } | undefined;

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
function reportLastUpdate(notify: Notify): void {
  const file = resultPath();
  const result = readJson(file) as UpdateResult | undefined;
  if (result === undefined) {
    return;
  }
  fs.rmSync(file, { force: true });
  if (result.ok) {
    notify("info", `Updated to ${result.version}`);
  } else {
    console.error(`[tet] update to ${result.version} failed:\n${result.output}`);
    notify("error", `Update to ${result.version} failed, update with: ${installCommand(process.platform)}`);
  }
}

/**
 * Removes earlier sessions' unpacked updates. Best effort: on win32 the updater may still hold its
 * executable briefly after writing its result. Awaited before the first check, whose `stage` may
 * unpack into the swept folder. Removed with original-fs: electron's fs opens `app.asar` as an
 * archive and fails its rm with EBUSY. A download cut short stays for `stage` to continue.
 */
async function sweepUpdateDir(asset: string): Promise<void> {
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

/** Read off the redirect of `<releases>/latest` — no API request, no rate limit. */
async function latestVersion(releasesUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${releasesUrl}/latest`, { redirect: "manual", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const tag = /\/tag\/v?([^/?#]+)$/.exec(response.headers.get("location") ?? "")?.[1];
    return tag && semver.valid(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** Also unpacks the zip: Windows' tar is bsdtar. */
async function unpack(archive: string, into: string): Promise<void> {
  const tar =
    process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const result = await runProcess(tar, ["-xf", archive, "-C", into]);
  if (result.code !== 0) {
    throw result.error ?? new Error(`tar exited with ${result.code}: ${result.stderr}`);
  }
}

/** The install root inside an unpacked archive: at its top, or one folder down. */
function findRoot(dir: string): string | undefined {
  const candidates = [dir, ...fs.readdirSync(dir).map((entry) => path.join(dir, entry))];
  for (const candidate of candidates) {
    const root = process.platform === "darwin" ? path.join(candidate, "TET.app") : candidate;
    if (fs.existsSync(rootExecutable(root))) {
      return root;
    }
  }
  return undefined;
}

/**
 * Fetches and unpacks a version for the quit. Plain fetch, never electron's download manager: on
 * macOS it quarantines the file, and Gatekeeper would refuse the ad-hoc signed bundle. A failed
 * download keeps its part for the next try; once unpacked, or refused by tar, the archive goes.
 */
async function stage(releasesUrl: string, asset: string, version: string): Promise<string> {
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
  await resumableDownload(`${releasesUrl}/download/v${version}/${asset}`, archive, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
  try {
    await unpack(archive, dir);
  } finally {
    await fs.promises.rm(archive, { force: true });
  }
  const root = findRoot(dir);
  if (!root) {
    throw new Error(`no ${path.basename(rootExecutable("."))} in ${asset}`);
  }
  return root;
}

/**
 * Installs only (`app.isPackaged`). Checks at startup and every four hours; a newer version is
 * fetched and unpacked at once, announced once, and installed on quit (`installPendingUpdate`) —
 * never mid-session, a tab being a live agent session. If tet cannot replace its own folder, the
 * notice carries the install command instead.
 *
 * `releasesUrl` is `RELEASES_URL` except for test/install.test.ts.
 */
export function startAutoUpdate(installed: boolean, releasesUrl: string, tetDataRoot: string, notify: Notify): void {
  dataRoot = tetDataRoot;
  const asset = assetName(process.platform, process.arch);
  if (!installed || !asset) {
    return;
  }
  const root = installRoot(process.execPath);
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
        notify("info", `Update ${latest} available, update with: ${installCommand(process.platform)}`);
        return;
      }
      try {
        pending = { version: latest, root: await stage(releasesUrl, asset, latest) };
        announced = latest;
        notify("info", `Update ${latest} available, installs when you quit TET`);
      } catch (error) {
        // Tried again at the next check.
        console.error(`[tet] could not fetch the update to ${latest}:`, error);
      }
    } finally {
      checking = false;
    }
  };

  void updaterDone().then(async () => {
    reportLastUpdate(notify);
    await sweepUpdateDir(asset);
    await check();
    setInterval(() => void check(), CHECK_INTERVAL_MS);
  });
}

/**
 * Starts the pending update to run after this process exits: at the end of a quit, not a restart
 * (a relaunched tet would hold the folder being replaced). Run by the *new* binary as node from its
 * unpack folder — no node on the machine to count on, and the installed binary gets replaced.
 */
export function installPendingUpdate(): void {
  if (!pending) {
    return;
  }
  console.error(`[tet] quit: starting the update to ${pending.version}`);
  try {
    const resources = process.platform === "darwin" ? path.join(pending.root, "Contents", "Resources") : path.join(pending.root, "resources");
    const script = path.join(resources, "app.asar.unpacked", "dist", "tet-update.js");
    const args = [script, String(process.pid), pending.version, pending.root, installRoot(process.execPath), resultPath()];
    const child = spawn(rootExecutable(pending.root), args, {
      cwd: updateDir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    child.on("error", (error) => console.error("[tet] could not start the update:", error));
    child.unref();
    // Written here, not by the updater: a tet started right after this quit must already see it.
    if (child.pid !== undefined) {
      writeFileAtomic.sync(updateLockPath(updateDir()), String(child.pid));
    }
  } catch (error) {
    console.error("[tet] could not start the update:", error);
  }
}
