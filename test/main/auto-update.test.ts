import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { findRoot } from "../../src/main/update/auto-update";
import { PLATFORM } from "../../src/main/util/host-platform";
import { rootExecutable, rootIn } from "../../src/shared/release";
import { tempDir } from "../helpers";

/** update/auto-update.ts: where an unpacked update's install root lies. */

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
