import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as semver from "semver";
import { findControlPort } from "../src/main/control/control-server";
import { CONTROL_ENV } from "../src/shared/control";
import { assetName, rootExecutable } from "../src/shared/release";
import type { UpdateResult } from "../src/shared/release";
import { eventually, tetCtl } from "./helpers";

/**
 * What a user does with tet, on the platform this runs on: install it with the install script,
 * start it, let it find a newer version, quit, and start what the update installed. The releases
 * are served from here, standing in for GitHub's (TET_RELEASES_URL): the archive `npm run dist`
 * built into release/, and the same build packaged again one patch version up — what changes is
 * only what the update sees.
 *
 * Only with TET_INSTALL_TEST=1 (the release workflow's package job), after `npm run dist`. The
 * install lands in a throwaway folder (HOME, or LOCALAPPDATA on Windows), but on Windows the Start
 * menu entry, the desktop icon and the PATH entry are the account's own. Needs a display, like
 * app.test.ts.
 */

const ENABLED = process.env.TET_INSTALL_TEST === "1";
const ROOT = path.join(__dirname, "..");
const STARTUP_MS = 120_000;
const TOKEN = "install-test-token";
const ASSET = assetName(process.platform, process.arch) as string;

let work: string;
let home: string;
let userData: string;
let server: http.Server;
let releasesUrl: string;
let env: NodeJS.ProcessEnv;
let current: string;
let next: string;
/** The version `/latest` answers with, raised once the first one is installed. */
let served: string;
const archives = new Map<string, string>();
/**
 * Worked out once, before tet first starts, as app.test.ts does: `findControlPort` looks for a
 * free port, and asked again while tet listens it names the one after. Both starts share the
 * profile, so tet takes the same port again.
 */
let port: number;

/** Where the script puts tet, under the throwaway home. */
function installedRoot(): string {
  switch (process.platform) {
    case "win32":
      return path.join(home, "Programs", "TET");
    case "darwin":
      return path.join(home, "Applications", "TET.app");
    default:
      return path.join(home, ".local", "share", "tet");
  }
}

/** Asynchronously, and not for style: the releases it fetches are served from this very event loop. */
async function install(): Promise<void> {
  const [command, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "install.ps1")]]
      : ["sh", [path.join(ROOT, "scripts", "install.sh")]];
  const child = spawn(command, args, { env });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(status, 0, `install script\n${output}`);
}

/** The installed executable, started directly: `open` on macOS would not hand tet this environment. */
function startTet(): void {
  const args = [`--user-data-dir=${userData}`, "--allow-shell-only"];
  if (process.platform === "linux") {
    args.push("--no-sandbox");
  }
  const child: ChildProcess = spawn(rootExecutable(installedRoot()), args, {
    env: { ...env, ELECTRON_RUN_AS_NODE: undefined },
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function version(): Promise<{ version: string; pid: number } | undefined> {
  const answer = await tetCtl(["version"], { [CONTROL_ENV.port]: String(port), [CONTROL_ENV.token]: TOKEN });
  return answer.status === 0 ? (answer.result as { version: string; pid: number }) : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The quit a user gives, per platform: closing the window, SIGTERM, Cmd+Q's Apple Event. */
function quit(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid)], { stdio: "ignore" });
  } else if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", 'tell application id "com.samilkale.tet" to quit'], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGTERM");
  }
}

function kill(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * This checkout packaged again with its version raised, for this platform and architecture alone.
 * A target named on the command line overrides the config's list of architectures.
 */
function packageNext(): string {
  const output = path.join(work, "next");
  const platformFlag = { win32: "--win", darwin: "--mac", linux: "--linux" }[process.platform as "win32" | "darwin" | "linux"];
  const target = process.platform === "win32" ? "zip" : "tar.gz";
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

describe("tet installed by its script, and updated", { skip: !ENABLED, timeout: 20 * 60_000 }, () => {
  before(async () => {
    const built = path.join(ROOT, "release", ASSET);
    assert.ok(fs.existsSync(built), `${built} — run \`npm run dist\` first`);
    work = fs.mkdtempSync(path.join(os.tmpdir(), "tet-install-"));
    home = path.join(work, "home");
    userData = path.join(work, "user-data");
    fs.mkdirSync(home);
    current = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    next = semver.inc(current, "patch") as string;
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
      const file = download && download[2] === ASSET ? archives.get(download[1]) : undefined;
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
      ...(process.platform === "win32" ? { LOCALAPPDATA: home } : { HOME: home })
    };
    port = await findControlPort(userData);
  });

  after(async () => {
    const running = await version().catch(() => undefined);
    if (running) {
      kill(running.pid);
      await eventually("tet gone", () => !alive(running.pid), 30_000).catch(() => undefined);
    }
    server?.close();
    // A killed tet's processes and a pty's console host hold its files a while longer on win32.
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
    assert.ok(fs.existsSync(rootExecutable(installedRoot())), "the executable in place");
    if (process.platform === "win32") {
      const startMenu = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "TET.lnk");
      const link = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `$l = (New-Object -ComObject WScript.Shell).CreateShortcut('${startMenu}'); $l.TargetPath + '|' + $l.Arguments`],
        { encoding: "utf8" }
      );
      const [target, args] = link.stdout.trim().split("|");
      // Real paths on both sides: a runner's temp directory can come as an 8.3 short name.
      assert.equal(fs.realpathSync.native(target), fs.realpathSync.native(rootExecutable(installedRoot())), "the Start menu entry, on TET.exe");
      assert.equal(args, "", "the Start menu entry, without arguments");
      assert.ok(fs.existsSync(path.join(installedRoot(), "bin", "tet.cmd")), "the tet command");
    } else {
      assert.ok(fs.existsSync(path.join(home, ".local", "bin", "tet")), "the tet command");
    }
    if (process.platform === "linux") {
      assert.ok(fs.existsSync(path.join(home, ".local", "share", "applications", "tet.desktop")), "the desktop entry");
    }
    served = next;
    startTet();
    await eventually("tet answering", async () => (await version())?.version === current, STARTUP_MS);
  });

  it("fetches the newer version, and installs it once tet has quit", async () => {
    const running = await version();
    assert.ok(running, "tet running");
    // Unpacked beside tet, and the archive gone: what arms the update for the quit.
    const staged = path.join(userData, "update", next);
    await eventually(
      "the update unpacked",
      () => fs.existsSync(staged) && !fs.readdirSync(path.join(userData, "update")).some((entry) => entry.endsWith(ASSET)),
      5 * 60_000
    );
    quit(running.pid);
    await eventually("tet gone", () => !alive(running.pid), 60_000);
    const resultFile = path.join(userData, "update", "result.json");
    await eventually("the update's result", () => fs.existsSync(resultFile), 5 * 60_000);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as UpdateResult;
    assert.equal(result.ok, true, result.output);
    assert.equal(result.version, next);
  });

  it("starts the updated version, which reports the update", async () => {
    startTet();
    await eventually("the new version answering", async () => (await version())?.version === next, STARTUP_MS);
    await eventually("the result reported", () => !fs.existsSync(path.join(userData, "update", "result.json")), 30_000);
  });
});
