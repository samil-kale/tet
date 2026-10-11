import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { LINUX, MAC, WINDOWS } from "../../src/shared/platform";
import { assetName, preparedRoot, resourcesDir, rootIn, runningUpdater, updateLockPath } from "../../src/shared/release";
import { processAlive, tempDir } from "../helpers";

/** shared/release.ts: where a release's archive, install root and updater's lock lie. */

describe("a release's archive", () => {
  it("is named per platform and architecture, and none for an architecture nothing is built for", () => {
    for (const platform of [WINDOWS, MAC, LINUX]) {
      assert.equal(assetName(platform, "x64"), `${platform.assetPrefix}-x64.${platform.assetExtension}`);
      assert.equal(assetName(platform, "arm64"), `${platform.assetPrefix}-arm64.${platform.assetExtension}`);
      assert.equal(assetName(platform, "ia32"), undefined);
    }
  });
});

describe("the install root", () => {
  it("is prepared beside itself, and its entry in an archive is the bundle within it on macOS only", () => {
    assert.equal(preparedRoot(path.join("/opt", "tet")), `${path.join("/opt", "tet")}.new`);
    assert.equal(rootIn("/unpacked", MAC), path.join("/unpacked", "TET.app"));
    assert.equal(rootIn("/unpacked", LINUX), "/unpacked");
    assert.equal(rootIn("/unpacked", WINDOWS), "/unpacked");
  });

  it("holds its resources where the platform's layout puts them", () => {
    assert.equal(resourcesDir("/r", MAC), path.join("/r", "Contents", "Resources"));
    assert.equal(resourcesDir("/r", LINUX), path.join("/r", "resources"));
    assert.equal(resourcesDir("/r", WINDOWS), path.join("/r", "resources"));
  });
});

describe("the updater's lock", () => {
  it("names the running updater by its pid, and nobody for no lock, a dead pid, a stale or a broken lock", () => {
    const dir = tempDir("tet-lock-");
    const lock = updateLockPath(dir);
    assert.equal(runningUpdater(lock), undefined, "no lock");

    fs.writeFileSync(lock, String(process.pid));
    assert.equal(runningUpdater(lock), process.pid);

    fs.writeFileSync(lock, "not a pid");
    assert.equal(runningUpdater(lock), undefined);
    fs.writeFileSync(lock, "-4");
    assert.equal(runningUpdater(lock), undefined);

    fs.writeFileSync(lock, String(process.pid));
    const longAgo = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(lock, longAgo, longAgo);
    assert.equal(runningUpdater(lock), undefined, "a lock older than any updater lives belongs to one that died");
  });

  it("is no lock when its process is gone", () => {
    const dir = tempDir("tet-lock-");
    const lock = updateLockPath(dir);
    // A pid no process holds: the highest a pid can be.
    const gone = 2 ** 22 - 1;
    assert.equal(processAlive(gone), false);
    fs.writeFileSync(lock, String(gone));
    assert.equal(runningUpdater(lock), undefined);
  });
});
