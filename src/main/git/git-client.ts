import * as path from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { GitRequest, GitResponse } from "./git-host";

/**
 * `git.ts` as seen from the main process: the same functions, each asynchronous now that it
 * answers from another process. Everything it exports already returns a promise, so no
 * signature actually changes.
 */
type GitModule = typeof import("./git");
export type GitApi = {
  [K in keyof GitModule]: GitModule[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let child: UtilityProcess | undefined;
const pending = new Map<number, Pending>();
let nextId = 0;

function fail(message: string): void {
  for (const request of pending.values()) {
    request.reject(new Error(message));
  }
  pending.clear();
}

/**
 * Starts the git process, or hands back the one already running. It is restarted on the next
 * call after a crash rather than kept alive by a supervisor: git commands are all short-lived
 * and independent, so there is no state in there worth preserving.
 */
function host(): UtilityProcess {
  if (child) {
    return child;
  }
  const started = utilityProcess.fork(path.join(__dirname, "git-host.js"), [], { serviceName: "tet-git" });
  started.on("message", (message: GitResponse) => {
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error === undefined) {
      request.resolve(message.value);
    } else {
      request.reject(new Error(message.error));
    }
  });
  started.on("exit", (code) => {
    child = undefined;
    fail(`The git process stopped (exit code ${code})`);
  });
  child = started;
  return started;
}

function call(method: string, args: unknown[]): Promise<unknown> {
  const id = ++nextId;
  const request: GitRequest = { id, method, args };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      host().postMessage(request);
    } catch (error) {
      // A process that could not be forked, or a port that is already gone: without this the
      // entry would sit in `pending` for a reply that is never coming, and the caller with it.
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Forwards every property as a call to the git process. A proxy rather than one hand-written
 * line per function: they would all be the same line, and each new function in `git.ts` would
 * need another one before it could be used.
 */
export const git: GitApi = new Proxy({} as GitApi, {
  get:
    (_target, method: string) =>
    (...args: unknown[]) =>
      call(method, args)
});

/** Starts the process up front, so the first repository does not wait for it to boot. */
export function startGitProcess(): void {
  host();
}

export function stopGitProcess(): void {
  child?.kill();
  child = undefined;
  fail("The git process was shut down");
}
