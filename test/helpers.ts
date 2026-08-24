import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";

/** The built CLI — the tests run what ships, not the source. */
export const CLI = path.join(__dirname, "..", "dist", "tet-ctl.js");

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout, when the CLI printed a result. */
  result: unknown;
}

/**
 * Runs the built CLI the way a terminal of tet would — the channel in its environment.
 * Asynchronously, and not for style: in control.test.ts the server it talks to runs on this
 * very event loop, and a `spawnSync` would hold that loop until the child gave up waiting.
 */
export function tetCtl(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (status) => {
      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = undefined;
      }
      resolve({ status: status ?? -1, stdout, stderr, result });
    });
  });
}

/**
 * Polls until `check` holds, or fails with `what` after `ms`. `what` can be a thunk so a
 * message built from state gathered while polling (e.g. accumulated stderr) reflects that state
 * at failure time, not whatever it was when `eventually` was first called.
 */
export async function eventually(
  what: string | (() => string),
  check: () => boolean | Promise<boolean>,
  ms = 1000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, ms / 20)));
  }
  assert.ok(await check(), `${typeof what === "function" ? what() : what} — not within ${ms}ms`);
}
