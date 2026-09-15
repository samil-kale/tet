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
 * Runs the built CLI with the channel in its environment, as a tet terminal would. Async because
 * in control.test.ts the server runs on this event loop, which a `spawnSync` would block.
 */
export function tetCtl(args: string[], env: Record<string, string | undefined>, input = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    // Always closed: a hook reads its payload here, and would wait forever on an open stdin.
    child.stdin.end(input);
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
 * Polls until `check` holds, or fails with `what` after `ms`. A thunk `what` is evaluated at
 * failure time, so it can include state gathered while polling (e.g. stderr).
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
