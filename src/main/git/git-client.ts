import * as path from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { GitRequest, GitResponse } from "./git-host";

/** `git.ts` as seen from the main process: the same functions, each asynchronous. */
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

/** Starts the git process, or hands back the running one. Restarted on the next call after a crash
 *  rather than supervised: git commands are short-lived and independent, so no state is lost. */
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
      // A fork that failed or a port already gone; without this the caller waits forever.
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Forwards every property as a call to the git process, so a new `git.ts` function needs no line here. */
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
