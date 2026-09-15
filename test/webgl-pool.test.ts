import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_HIDDEN_WEBGL,
  WEBGL_LOSS_LIMIT,
  WEBGL_LOSS_WINDOW_MS,
  WebglPool,
  isSoftwareRenderer
} from "../src/renderer/terminal/webgl-pool";

/** Which terminals keep a WebGL context — the bookkeeping half of terminal-views.ts's renderer. */

function hideMany(pool: WebglPool, prefix: string, count: number): void {
  for (let i = 0; i < count; i++) {
    pool.hide(`${prefix} t${i}`);
  }
}

describe("WebglPool", () => {
  it("keeps the most recently hidden and releases the ones hidden longest", () => {
    const pool = new WebglPool();
    hideMany(pool, "p", MAX_HIDDEN_WEBGL);
    assert.deepEqual(pool.trim(), []);
    pool.hide("p new");
    pool.hide("p newer");
    assert.deepEqual(pool.trim(), ["p t0", "p t1"]);
    assert.deepEqual(pool.trim(), []);
  });

  it("takes a shown terminal out of the budget, and a hidden one again to the back", () => {
    const pool = new WebglPool();
    hideMany(pool, "p", MAX_HIDDEN_WEBGL);
    pool.show("p t0");
    pool.hide("p new");
    assert.deepEqual(pool.trim(), []);
    pool.hide("p t1");
    pool.hide("p t0");
    assert.deepEqual(pool.trim(), ["p t2"]);
  });

  it("keeps a split project warm across a switch away and back", () => {
    const pool = new WebglPool();
    // Two projects of four panes each, the hidden budget already full.
    hideMany(pool, "other", MAX_HIDDEN_WEBGL);
    hideMany(pool, "a", 4);
    assert.deepEqual(pool.trim(), ["other t0", "other t1", "other t2", "other t3"]);
    // Back from b to a: b's panes are hidden before a's are shown, then the pool is trimmed.
    hideMany(pool, "b", 4);
    for (let i = 0; i < 4; i++) {
      pool.show(`a t${i}`);
    }
    assert.deepEqual(pool.trim(), []);
  });

  it("frees the place of a hidden terminal that lost its context", () => {
    const pool = new WebglPool();
    hideMany(pool, "p", MAX_HIDDEN_WEBGL);
    pool.lost("p t3");
    pool.hide("p new");
    assert.deepEqual(pool.trim(), []);
  });

  it("forgets a closed terminal exactly, and a closed project by prefix", () => {
    const pool = new WebglPool();
    pool.hide("p t1");
    pool.hide("p t10");
    pool.hide("q t1");
    pool.forget("p t1");
    pool.forgetPrefix("q ");
    hideMany(pool, "r", MAX_HIDDEN_WEBGL);
    assert.deepEqual(pool.trim(), ["p t10"]);
  });

  it("stops retrying a terminal whose context keeps dying, until the window has passed", () => {
    const pool = new WebglPool();
    for (let i = 0; i < WEBGL_LOSS_LIMIT - 1; i++) {
      pool.recordLoss("p t", 1000 + i);
    }
    assert.equal(pool.mayRetry("p t", 2000), true);
    pool.recordLoss("p t", 2000);
    assert.equal(pool.mayRetry("p t", 2000), false);
    assert.equal(pool.mayRetry("p other", 2000), true);
    assert.equal(pool.mayRetry("p t", 1000 + WEBGL_LOSS_WINDOW_MS), true);
  });

  it("forgets the losses of a closed terminal", () => {
    const pool = new WebglPool();
    for (let i = 0; i < WEBGL_LOSS_LIMIT; i++) {
      pool.recordLoss("p t", i);
    }
    pool.forget("p t");
    assert.equal(pool.mayRetry("p t", WEBGL_LOSS_LIMIT), true);
  });
});

describe("isSoftwareRenderer", () => {
  it("names the software rasterizers and not a GPU", () => {
    assert.equal(isSoftwareRenderer("Mesa llvmpipe (LLVM 15.0.7, 256 bits)"), true);
    assert.equal(isSoftwareRenderer("Google Inc. (Google) ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"), true);
    assert.equal(isSoftwareRenderer("Google Inc. (NVIDIA) ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)"), false);
  });
});
