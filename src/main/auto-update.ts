import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { app } from "electron";
import * as semver from "semver";
import { assetName, installCommand, installRoot, rootExecutable } from "../shared/release";
import type { UpdateResult } from "../shared/release";
import type { NoticeSeverity } from "../shared/types";

/** How often to look again after the check at startup. Nothing is urgent: an update installs only
 *  once tet quits. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

/** Asking which release is the newest is one small request. */
const CHECK_TIMEOUT_MS = 15_000;
/** The archive is over 100 MB, on whatever connection the machine has. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

type Notify = (severity: NoticeSeverity, message: string) => void;

/** The update found and unpacked this session, for `installPendingUpdate` to run. */
let pending: { version: string; root: string } | undefined;

/** tet's data folder (data-root.ts), handed over by startAutoUpdate; `pending` is only ever set
 *  after it. */
let dataRoot = "";

function updateDir(): string {
  return path.join(dataRoot, "update");
}

function resultPath(): string {
  return path.join(updateDir(), "result.json");
}

/** What the last update left behind, reported once and deleted. */
function reportLastUpdate(notify: Notify): void {
  const file = resultPath();
  let result: UpdateResult;
  try {
    result = JSON.parse(fs.readFileSync(file, "utf8")) as UpdateResult;
  } catch {
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
 * Whatever an earlier session unpacked: installed by now, or given up on. Best effort — on win32 the
 * update that ran from one of these may still hold its executable a moment after writing its result.
 * Awaited before the first check, whose `stage` may unpack into the very folder being swept.
 */
async function sweepUpdateDir(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(updateDir());
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry !== path.basename(resultPath()))
      .map((entry) => fs.promises.rm(path.join(updateDir(), entry), { recursive: true, force: true }).catch(() => undefined))
  );
}

/** Whether the update can write where tet is installed, without asking for more rights. */
function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The newest release's version, off the redirect GitHub answers `<releases>/latest` with — no API
 * request, so no API rate limit. Undefined on any failure.
 */
async function latestVersion(releasesUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${releasesUrl}/latest`, { redirect: "manual", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const tag = /\/tag\/v?([^/?#]+)$/.exec(response.headers.get("location") ?? "")?.[1];
    return tag && semver.valid(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** `tar` unpacks the zip as well: the one Windows ships (since 10 1803) is bsdtar. */
function unpack(archive: string, into: string): Promise<void> {
  const tar =
    process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ["-xf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${stderr}`))));
  });
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
 * Fetches and unpacks a version beside tet, ready for the quit. Fetched by this process into a
 * plain file, never through electron's download manager: on macOS that one marks what it saves as
 * quarantined, and Gatekeeper would then refuse the ad-hoc signed bundle it holds.
 */
async function stage(releasesUrl: string, asset: string, version: string): Promise<string> {
  const dir = path.join(updateDir(), version);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  const archive = path.join(updateDir(), `${version}-${asset}`);
  try {
    const response = await fetch(`${releasesUrl}/download/v${version}/${asset}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) {
      throw new Error(`download answered ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), fs.createWriteStream(archive));
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
 * Only for tet running as an install (`app.isPackaged`), never `npm start`. Asks the GitHub
 * Release at startup and every four hours; a newer version is fetched and unpacked right away,
 * announced once, and installed when tet quits (`installPendingUpdate`) — never in the middle of a
 * session, a terminal tab being a live agent session. Where tet cannot replace its own folder, the
 * notice carries the install command instead.
 *
 * `releasesUrl` is `RELEASES_URL` but for test/install.test.ts, which serves its own.
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
      // Silent on failure: an offline machine would otherwise put the same notice up every four
      // hours for something nobody asked for.
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

  reportLastUpdate(notify);
  void sweepUpdateDir().then(check);
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}

/**
 * Starts the update found this session, to run once this process is gone: called at the very end
 * of a quit, not a restart (a relaunched tet would hold the very folder being replaced). Run by the
 * *new* version's binary as node, from the folder it was unpacked into — there is no node on the
 * machine to count on, and the installed binary is what gets replaced.
 */
export function installPendingUpdate(): void {
  if (!pending) {
    return;
  }
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
  } catch (error) {
    console.error("[tet] could not start the update:", error);
  }
}
