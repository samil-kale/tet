import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectPlatform } from "../../src/renderer/platform";

describe("renderer platform detection", () => {
  it("detects macOS across navigator properties", () => {
    assert.equal(detectPlatform({ platform: "MacIntel" }), "darwin");
    assert.equal(detectPlatform({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }), "darwin");
    assert.equal(detectPlatform({ platform: "", userAgent: "", userAgentData: { platform: "macOS" } }), "darwin");
  });

  it("detects Windows across navigator properties", () => {
    assert.equal(detectPlatform({ platform: "Win32" }), "win32");
    assert.equal(detectPlatform({ platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }), "win32");
    assert.equal(detectPlatform({ platform: "", userAgent: "", userAgentData: { platform: "Windows" } }), "win32");
  });

  it("detects Linux as fallback", () => {
    assert.equal(detectPlatform({ platform: "Linux x86_64" }), "linux");
    assert.equal(detectPlatform({ platform: "", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
    assert.equal(detectPlatform({ platform: "", userAgent: "", userAgentData: { platform: "Linux" } }), "linux");
  });
});
