import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { installUncaughtHandler, UNCAUGHT_MARKER } from "../../src/main/uncaught";
import { tempDir } from "../helpers";

/** uncaught.ts: an exception nothing caught. */

/** The net under an unhandled fault — see uncaught.ts for why the main process survives one. */
describe("an uncaught exception", () => {
  it("logs the whole stack, tells the user once, and lets the process live", () => {
    const logFile = path.join(tempDir("tet-uncaught-"), "errors.log");
    const notices: string[] = [];
    const before = process.listenerCount("uncaughtException");
    installUncaughtHandler(logFile, (_severity, message) => notices.push(message));
    // Called directly, not via `process.emit`: node's test runner listens too and would count a crash.
    const handler = process.listeners("uncaughtException")[before];
    // The handler's stderr report would read like a crashed run; the log file is asserted on.
    const printed = console.error;
    console.error = () => undefined;
    try {
      const error = new Error("write EAGAIN");
      error.stack = "Error: write EAGAIN\n    at WriteWrap.onWriteComplete";
      handler(error, "uncaughtException");
      handler(error, "uncaughtException");
      const log = fs.readFileSync(logFile, "utf8");
      assert.ok(log.includes(`${UNCAUGHT_MARKER} (uncaughtException, #1)`), "marked, with its origin and count");
      assert.match(log, /#2/, "every occurrence is logged");
      assert.match(log, /at WriteWrap\.onWriteComplete/, "the stack, not just the message");
      assert.equal(notices.length, 1, "one notice per distinct error, however often it repeats");
      assert.match(notices[0], /write EAGAIN/);
    } finally {
      console.error = printed;
      process.off("uncaughtException", handler);
    }
  });
});
