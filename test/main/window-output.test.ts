import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ipcMain } from "electron";
import { AppWindow } from "../../src/main/window";
import type { ProjectRef } from "../../src/shared/types/project";

/** window.ts: what a tab's output costs the terminal before its process is read again. */

const REF: ProjectRef = { projectId: "p" };

function windowOf() {
  const tabs = { open: true };
  Object.assign(ipcMain, { on: () => undefined });
  const paused: boolean[] = [];
  const window = new AppWindow({
    hidden: true,
    hasTab: () => tabs.open,
    setOutputPaused: (_ref, _tabId, value) => paused.push(value),
    onPageLoad: () => undefined,
  });
  return { window, paused, tabs };
}

describe("a tab's output flow control", () => {
  it("pauses the process above the high-water mark and resumes it once the terminal caught up", () => {
    const { window, paused } = windowOf();
    window.queueOutput(REF, "t", "x".repeat(300 * 1024));
    window.flushOutput();
    assert.deepEqual(paused, [true]);
    window.ackOutput(REF, "t", 100 * 1024);
    assert.deepEqual(paused, [true], "still above the low-water mark");
    window.ackOutput(REF, "t", 200 * 1024);
    assert.deepEqual(paused, [true, false]);
  });

  it("never pauses a tab that keeps up", () => {
    const { window, paused } = windowOf();
    for (let round = 0; round < 20; round += 1) {
      window.queueOutput(REF, "t", "x".repeat(100 * 1024));
      window.flushOutput();
      window.ackOutput(REF, "t", 100 * 1024);
    }
    assert.deepEqual(paused, []);
  });

  it("resumes a process whose acks never come, and when the page reloads or the tab is gone", (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const stuck = windowOf();
    stuck.window.queueOutput(REF, "t", "x".repeat(300 * 1024));
    stuck.window.flushOutput();
    context.mock.timers.tick(3500);
    assert.deepEqual(stuck.paused, [true, false]);

    const gone = windowOf();
    gone.window.queueOutput(REF, "t", "x".repeat(300 * 1024));
    gone.window.flushOutput();
    gone.tabs.open = false;
    gone.window.queueOutput(REF, "t", "more");
    gone.window.flushOutput();
    assert.deepEqual(gone.paused, [true, false]);
  });

  it("counts output still held here, so a process faster than the flushes is paused too", () => {
    const { window, paused } = windowOf();
    window.queueOutput(REF, "t", "x".repeat(300 * 1024));
    assert.deepEqual(paused, [true]);
  });

  it("takes late acks after giving up as paying off what was owed, and pauses again once paid", (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { window, paused } = windowOf();
    window.queueOutput(REF, "t", "x".repeat(300 * 1024));
    window.flushOutput();
    context.mock.timers.tick(3500);
    assert.deepEqual(paused, [true, false]);
    window.queueOutput(REF, "t", "x".repeat(100 * 1024));
    window.flushOutput();
    assert.deepEqual(paused, [true, false], "given up: not paused again while acks are owed");
    window.ackOutput(REF, "t", 400 * 1024);
    window.queueOutput(REF, "t", "x".repeat(300 * 1024));
    assert.deepEqual(paused, [true, false, true]);
  });

  it("hands over at most 64 KB of a tab per timed flush, the rest on the next", (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const sent: number[] = [];
    const { window } = windowOf();
    window.send = ((channel: string, payload: { data: string }[]) => {
      if (channel === "tabs:output") {
        sent.push(payload.reduce((sum, entry) => sum + entry.data.length, 0));
      }
    }) as typeof window.send;
    window.queueOutput(REF, "t", "x".repeat(150 * 1024));
    context.mock.timers.tick(10);
    assert.deepEqual(sent, [64 * 1024]);
    context.mock.timers.tick(70);
    context.mock.timers.tick(70);
    assert.deepEqual(sent, [64 * 1024, 64 * 1024, 22 * 1024]);
  });
});
