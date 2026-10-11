import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { net } from "electron";
import {
  findRoot,
  installPendingUpdate,
  latestVersion,
  reportLastUpdate,
  startAutoUpdate,
  sweepUpdateDir,
} from "../../src/main/update/auto-update";
import { PLATFORM } from "../../src/main/util/host-platform";
import { preparedRoot, rootExecutable, rootIn } from "../../src/shared/release";
import { tempDir } from "../helpers";

/** update/auto-update.ts: what a start does with the last update and the folder it left, and how the newest version is read. */

/** The update folder under a fresh data root, which `startAutoUpdate` is handed (an uninstalled run only sets it). */
function updateDirIn(): string {
  const root = tempDir("tet-auto-update-");
  startAutoUpdate(
    false,
    "",
    root,
    () => undefined,
    () => undefined,
  );
  const dir = path.join(root, "update");
  fs.mkdirSync(dir);
  return dir;
}

function notices(): { said: [string, string][]; notice: (severity: string, message: string) => void } {
  const said: [string, string][] = [];
  return { said, notice: (severity, message) => said.push([severity, message]) };
}

describe("the last update's result", () => {
  it("is reported once and deleted: an update made, or the command to try again", () => {
    const dir = updateDirIn();
    const result = path.join(dir, "result.json");
    const { said, notice } = notices();

    fs.writeFileSync(result, JSON.stringify({ version: "1.2.3", ok: true, output: "" }));
    reportLastUpdate(notice);
    assert.deepEqual(said, [["info", "Updated to 1.2.3"]]);
    assert.equal(fs.existsSync(result), false);

    fs.writeFileSync(result, JSON.stringify({ version: "1.2.4", ok: false, output: "EBUSY" }));
    reportLastUpdate(notice);
    assert.deepEqual(said[1], ["error", `Update to 1.2.4 failed, update with: ${PLATFORM.installCommand}`]);
    assert.equal(fs.existsSync(result), false);

    reportLastUpdate(notice);
    assert.equal(said.length, 2, "nothing to report the next time");
  });

  it("says nothing of a result that is no result, and still deletes it", () => {
    const dir = updateDirIn();
    const result = path.join(dir, "result.json");
    const { said, notice } = notices();
    fs.writeFileSync(result, JSON.stringify(["not", "a", "record"]));
    reportLastUpdate(notice);
    assert.deepEqual(said, []);
    assert.equal(fs.existsSync(result), false);
  });
});

describe("the update folder at a start", () => {
  const asset = "tet-test-x64.tar.gz";

  it("keeps the last result and a download cut short, and removes what earlier sessions unpacked", async () => {
    const dir = updateDirIn();
    const root = path.join(tempDir("tet-install-"), "TET");
    fs.mkdirSync(path.join(dir, "1.0.0"));
    fs.writeFileSync(path.join(dir, "1.0.0", "file"), "x");
    fs.writeFileSync(path.join(dir, "result.json"), "{}");
    fs.writeFileSync(path.join(dir, `1.1.0-${asset}`), "part");
    fs.writeFileSync(path.join(dir, "stray.txt"), "x");
    fs.mkdirSync(preparedRoot(root), { recursive: true });

    await sweepUpdateDir(asset, root);

    assert.deepEqual(fs.readdirSync(dir).sort(), [`1.1.0-${asset}`, "result.json"]);
    assert.equal(fs.existsSync(preparedRoot(root)), false, "a copy a quit left unfinished goes");
  });

  it("has nothing to sweep before the first update", async () => {
    updateDirIn();
    const root = tempDir("tet-install-");
    fs.rmSync(path.join(root, "update"), { recursive: true, force: true });
    await sweepUpdateDir(asset, path.join(root, "TET"));
  });
});

describe("the install root inside an unpacked archive", () => {
  /** An archive's entry holding the root executable, as the platform lays it out. */
  function installAt(entry: string): string {
    const root = rootIn(entry, PLATFORM);
    const executable = rootExecutable(root, PLATFORM);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "");
    return root;
  }

  it("is found at the archive's top, or one folder down", () => {
    const top = tempDir("tet-unpacked-");
    assert.equal(findRoot(top), undefined, "an empty archive holds none");
    const root = installAt(top);
    assert.equal(findRoot(top), root);

    const nested = tempDir("tet-unpacked-");
    const inner = installAt(path.join(nested, "TET-1.2.3"));
    assert.equal(findRoot(nested), inner);
  });

  it("is not found where no executable lies", () => {
    const dir = tempDir("tet-unpacked-");
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs", "README"), "");
    assert.equal(findRoot(dir), undefined);
  });
});

describe("the newest version", () => {
  const original = (net as { request?: unknown }).request;
  afterEach(() => {
    (net as { request?: unknown }).request = original;
  });

  /** electron's `net.request` answering with one event once the request ends. */
  function answering(event: "redirect" | "response" | "error" | "abort", location?: string): { urls: string[]; redirects: unknown[] } {
    const seen = { urls: [] as string[], redirects: [] as unknown[] };
    (net as { request?: unknown }).request = (options: { url: string; redirect: string }) => {
      seen.urls.push(options.url);
      seen.redirects.push(options.redirect);
      const request = new EventEmitter() as EventEmitter & { abort(): void; end(): void };
      request.abort = () => undefined;
      request.end = () => {
        setImmediate(() => (event === "redirect" ? request.emit("redirect", 302, "GET", location) : request.emit(event)));
      };
      return request;
    };
    return seen;
  }

  it("is the tag `latest` redirects to, asked without following the redirect", async () => {
    const seen = answering("redirect", "https://github.com/o/r/releases/tag/v1.2.3");
    assert.equal(await latestVersion("https://github.com/o/r/releases"), "1.2.3");
    assert.deepEqual(seen.urls, ["https://github.com/o/r/releases/latest"]);
    assert.deepEqual(seen.redirects, ["manual"]);
  });

  it("takes a tag without its v, and none that is no version", async () => {
    answering("redirect", "https://github.com/o/r/releases/tag/2.0.0-beta.1");
    assert.equal(await latestVersion("u"), "2.0.0-beta.1");
    answering("redirect", "https://github.com/o/r/releases/tag/nightly");
    assert.equal(await latestVersion("u"), undefined);
    answering("redirect", "https://github.com/o/r/releases");
    assert.equal(await latestVersion("u"), undefined);
  });

  it("is none when there is no redirect, the request fails or is aborted", async () => {
    for (const event of ["response", "error", "abort"] as const) {
      answering(event);
      assert.equal(await latestVersion("u"), undefined, event);
    }
  });
});

describe("installing a pending update", () => {
  it("does nothing when no update is staged", () => {
    const dir = updateDirIn();
    installPendingUpdate();
    assert.deepEqual(fs.readdirSync(dir), [], "no updater was started, so no lock was written");
  });
});
