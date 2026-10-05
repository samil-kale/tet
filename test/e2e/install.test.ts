import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as semver from "semver";
import { findControlPort } from "../../src/main/ctl/ctl-port";
import { PLATFORM } from "../../src/main/util/host-platform";
import { CONTROL_ENV } from "../../src/shared/ctl";
import { assetName, preparedRoot, rootExecutable } from "../../src/shared/release";
import type { UpdateResult } from "../../src/shared/release";
import type { NoticeReport } from "../../src/shared/types/app";
import { eventually, killApp, processAlive, ROOT, tempDir, tetCtl } from "../helpers";

/**
 * Install with the script, start, find a newer version, quit, start the update. Releases are
 * served from here in place of GitHub's (TET_RELEASES_URL): the archive `npm run dist` built, and
 * the same build packaged again one patch version up.
 *
 * Only with TET_INSTALL_TEST=1, after `npm run dist`. The install lands in a throwaway HOME (or
 * LOCALAPPDATA), but on Windows the Start menu entry, desktop icon and PATH entry are the
 * account's own. Needs a display.
 */

const ENABLED = process.env.TET_INSTALL_TEST === "1";
const STARTUP_MS = 120_000;
const TOKEN = "install-test-token";
const ASSET = assetName(PLATFORM, process.arch)!;

let work: string;
let home: string;
let userData: string;
let server: http.Server;
let releasesUrl: string;
let env: NodeJS.ProcessEnv;
let current: string;
let next: string;
/** What `/latest` answers, raised once the first version is installed. */
let served: string;
const archives = new Map<string, string>();
/**
 * Found once before TET starts: asked while TET listens, `findControlPort` names the next free
 * port. Both starts share the profile, so TET takes the same port again.
 */
let port: number;

/** Where the script puts TET, under the throwaway home. */
function installedRoot(): string {
  switch (PLATFORM.id) {
    case "win32":
      return path.join(home, "Programs", "TET");
    case "darwin":
      return path.join(home, "Applications", "TET.app");
    case "linux":
      return path.join(home, ".local", "share", "tet");
  }
}

/** Async because the releases it fetches are served from this event loop. */
async function install(): Promise<void> {
  const [command, args] =
    PLATFORM.id === "win32"
      ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "install.ps1")]]
      : ["sh", [path.join(ROOT, "scripts", "install.sh")]];
  const child = spawn(command, args, { env });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(status, 0, `install script\n${output}`);
}

/** Both starts' stdout and stderr, for a failure's message. */
function tetLog(): string {
  try {
    return fs.readFileSync(path.join(work, "tet.log"), "utf8");
  } catch {
    return "";
  }
}

/** `what`, followed by what TET wrote so far. */
function withLog(what: string): () => string {
  return () => `${what}\n--- TET's output ---\n${tetLog()}`;
}

/**
 * Started directly: `open` on macOS would not pass this environment. Always shown, never
 * `WINDOW_ARGS`: `quit` closes the window, which a hidden one on win32 never receives.
 */
function startTet(): void {
  const args = [`--user-data-dir=${userData}`, "--allow-shell-only"];
  if (PLATFORM.id === "linux") {
    args.push("--no-sandbox");
  }
  const log = fs.openSync(path.join(work, "tet.log"), "a");
  const child: ChildProcess = spawn(rootExecutable(installedRoot(), PLATFORM), args, {
    env: { ...env, ELECTRON_RUN_AS_NODE: undefined },
    detached: true,
    stdio: ["ignore", log, log]
  });
  child.unref();
  fs.closeSync(log);
}

/** A verb's result, or undefined when TET does not answer. */
async function ask(args: string[]): Promise<unknown> {
  // No caller ids, which a run from a TET tab inherits: the run's token speaks for no tab.
  const answer = await tetCtl(args, {
    [CONTROL_ENV.port]: String(port),
    [CONTROL_ENV.token]: TOKEN,
    [CONTROL_ENV.projectId]: undefined,
    [CONTROL_ENV.tabId]: undefined
  });
  return answer.status === 0 ? answer.result : undefined;
}

async function version(): Promise<{ version: string; pid: number } | undefined> {
  return (await ask(["version"])) as { version: string; pid: number } | undefined;
}

/**
 * The update armed for the quit, as TET announces it: its notice is sent only once the update is
 * unpacked and pending. Its files on disk come a moment earlier, and a quit in between installs
 * nothing.
 */
async function updateArmed(): Promise<boolean> {
  const notices = (await ask(["notices-list"])) as NoticeReport[] | undefined;
  return notices?.some((notice) => notice.message === `Update ${next} ready, installs when you quit TET`) ?? false;
}

/** A user's quit per platform: closing the window, SIGTERM, Cmd+Q's Apple Event. */
function quit(pid: number): void {
  if (PLATFORM.id === "win32") {
    spawnSync("taskkill", ["/pid", String(pid)], { stdio: "ignore" });
  } else if (PLATFORM.id === "darwin") {
    spawnSync("osascript", ["-e", 'tell application id "com.samilkale.tet" to quit'], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGTERM");
  }
}

/**
 * This checkout packaged with its version raised, for this platform and arch only (a target on the
 * command line overrides the config's architectures).
 */
function packageNext(): string {
  const output = path.join(work, "next");
  const platformFlag = { win32: "--win", darwin: "--mac", linux: "--linux" }[PLATFORM.id];
  const target = PLATFORM.assetExtension;
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "electron-builder", "cli.js"),
      "--publish",
      "never",
      platformFlag,
      `${target}:${process.arch}`,
      `-c.extraMetadata.version=${next}`,
      `-c.directories.output=${output}`
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(result.status, 0, `electron-builder\n${result.stdout}${result.stderr}`);
  return path.join(output, ASSET);
}

describe("TET installed by its script, and updated", { skip: !ENABLED, timeout: 20 * 60_000 }, () => {
  before(async () => {
    const built = path.join(ROOT, "release", ASSET);
    assert.ok(fs.existsSync(built), `${built} — run \`npm run dist\` first`);
    work = tempDir("tet-install-");
    home = path.join(work, "home");
    userData = path.join(work, "user-data");
    fs.mkdirSync(home);
    current = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    next = semver.inc(current, "patch")!;
    archives.set(current, built);
    archives.set(next, packageNext());
    served = current;

    server = http.createServer((request, response) => {
      const url = request.url ?? "";
      if (url === "/latest") {
        response.writeHead(302, { location: `${releasesUrl}/tag/v${served}` }).end();
        return;
      }
      const download = /^\/download\/v([^/]+)\/([^/]+)$/.exec(url);
      const file = download?.[2] === ASSET ? archives.get(download[1]) : undefined;
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-length": fs.statSync(file).size });
      if (request.method === "HEAD") {
        response.end();
      } else {
        fs.createReadStream(file).pipe(response);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    releasesUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    env = {
      ...process.env,
      TET_RELEASES_URL: releasesUrl,
      [CONTROL_ENV.token]: TOKEN,
      ...(PLATFORM.id === "win32" ? { LOCALAPPDATA: home } : { HOME: home })
    };
    port = await findControlPort(userData);
  });

  after(async () => {
    const running = await version().catch(() => undefined);
    if (running) {
      killApp(running.pid, "SIGKILL");
      await eventually("TET gone", () => !processAlive(running.pid), 30_000).catch(() => undefined);
    }
    server?.close();
    // On win32 a killed TET's processes and a pty's console host hold files a while longer.
    await eventually(
      `${work} removed`,
      () => {
        try {
          fs.rmSync(work, { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      },
      60_000
    );
  });

  it("installs through the script and starts", async () => {
    await install();
    assert.ok(fs.existsSync(rootExecutable(installedRoot(), PLATFORM)), "the executable in place");
    if (PLATFORM.id === "win32") {
      const startMenu = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "TET.lnk");
      const link = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `$l = (New-Object -ComObject WScript.Shell).CreateShortcut('${startMenu}'); $l.TargetPath + '|' + $l.Arguments`],
        { encoding: "utf8" }
      );
      const [target, args] = link.stdout.trim().split("|");
      // Real paths on both sides: a runner's temp directory can be an 8.3 short name.
      assert.equal(fs.realpathSync.native(target), fs.realpathSync.native(rootExecutable(installedRoot(), PLATFORM)), "the Start menu entry, on TET.exe");
      assert.equal(args, "", "the Start menu entry, without arguments");
      assert.ok(fs.existsSync(path.join(installedRoot(), "bin", "tet.cmd")), "the tet command");
    } else {
      assert.ok(fs.existsSync(path.join(home, ".local", "bin", "tet")), "the tet command");
    }
    if (PLATFORM.id === "linux") {
      assert.ok(fs.existsSync(path.join(home, ".local", "share", "applications", "tet.desktop")), "the desktop entry");
    }
    served = next;
    startTet();
    await eventually(withLog("TET answering"), async () => (await version())?.version === current, STARTUP_MS);
  });

  it("fetches the newer version, and installs it once TET has quit", async () => {
    const running = await version();
    assert.ok(running, "TET running");
    await eventually(withLog("the update armed"), updateArmed, 5 * 60_000);
    assert.ok(fs.existsSync(rootExecutable(preparedRoot(installedRoot()), PLATFORM)), "the new version beside the install");
    quit(running.pid);
    await eventually(withLog("TET gone"), () => !processAlive(running.pid), 60_000);
    const resultFile = path.join(userData, "update", "result.json");
    await eventually(withLog("the update's result"), () => fs.existsSync(resultFile), 5 * 60_000);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as UpdateResult;
    assert.equal(result.ok, true, result.output);
    assert.equal(result.version, next);
    assert.equal(fs.existsSync(preparedRoot(installedRoot())), false, "the new version swapped in");
  });

  it("starts the updated version, which reports the update", async () => {
    startTet();
    await eventually(withLog("the new version answering"), async () => (await version())?.version === next, STARTUP_MS);
    await eventually("the result reported", () => !fs.existsSync(path.join(userData, "update", "result.json")), 30_000);
  });
});
