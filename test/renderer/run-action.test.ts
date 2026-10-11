import * as assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { notifying, runWithFollowUp } from "../../src/renderer/git/run-action";
import { fakeWindow, keepGlobals } from "../helpers";
import type { GitActionResult } from "../../src/shared/types/git";

/** git/run-action.ts: how an action's follow-up question and failure are handled. */

type Action = () => Promise<GitActionResult>;

/** Lets the promise callbacks `runWithFollowUp` leaves running finish. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What `start` was handed, in order. */
function runner(): { started: Action[]; start: (action: Action) => void } {
  const started: Action[] = [];
  return { started, start: (action) => void started.push(action) };
}

describe("an action with a follow-up question", () => {
  it("hands back a result that needs no question as it is, and asks nothing", async () => {
    const { started, start } = runner();
    const asked: GitActionResult[] = [];
    const result: GitActionResult = { ok: false, error: "refused" };
    runWithFollowUp(
      start,
      async () => result,
      "uncommitted",
      async (answer) => asked.push(answer) < 0,
      async () => ({ ok: true }),
    );
    assert.equal(started.length, 1);
    assert.equal(await started[0](), result);
    await settled();
    assert.deepEqual(asked, []);
    assert.equal(started.length, 1);
  });

  it("ends the first run at the question, then runs the confirmed action anew on a yes", async () => {
    const { started, start } = runner();
    const answer: GitActionResult = { ok: false, needsConfirmation: "uncommitted" };
    const confirmed: Action = async () => ({ ok: true });
    let asked: GitActionResult | undefined;
    runWithFollowUp(
      start,
      async () => answer,
      "uncommitted",
      async (result) => {
        asked = result;
        return true;
      },
      confirmed,
    );
    // The run ends ok, so its bar and lock are released while the question is up.
    assert.deepEqual(await started[0](), { ok: true });
    await settled();
    assert.equal(asked, answer);
    assert.deepEqual(started, [started[0], confirmed]);
  });

  it("runs nothing more on a no", async () => {
    const { started, start } = runner();
    runWithFollowUp(
      start,
      async () => ({ ok: false, needsConfirmation: "rewrites-pushed" }),
      "rewrites-pushed",
      async () => false,
      async () => ({ ok: true }),
    );
    await started[0]();
    await settled();
    assert.equal(started.length, 1);
  });

  it("takes another confirmation than the one it was given for a plain result", async () => {
    const { started, start } = runner();
    const other: GitActionResult = { ok: false, needsConfirmation: "trash-failed" };
    runWithFollowUp(
      start,
      async () => other,
      "uncommitted",
      async () => true,
      async () => ({ ok: true }),
    );
    assert.equal(await started[0](), other);
    await settled();
    assert.equal(started.length, 1);
  });
});

describe("a runner whose failure is notified", () => {
  const reported: { severity: string; message: string }[] = [];
  keepGlobals("window");

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    reported.length = 0;
    fakeWindow({
      tet: { app: { reportNotice: (notice: (typeof reported)[number]) => reported.push(notice) } },
    });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("tells a refusal as an error notice, once", async () => {
    notifying(async () => "Could not push")();
    await settled();
    assert.deepEqual(
      reported.map(({ severity, message }) => ({ severity, message })),
      [{ severity: "error", message: "Could not push" }],
    );
  });

  it("tells nothing when the action went through, and hands the arguments on", async () => {
    const seen: unknown[][] = [];
    notifying(async (...args: unknown[]) => void seen.push(args))("a", 1);
    await settled();
    assert.deepEqual(seen, [["a", 1]]);
    assert.deepEqual(reported, []);
  });
});
