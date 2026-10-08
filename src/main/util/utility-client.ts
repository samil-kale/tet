import * as path from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { UtilityMessage, UtilityRequest, UtilityResponse } from "./utility-host";

/** A module as the main process sees it in its utility process: the same functions, each asynchronous. */
export type UtilityApi<Module> = {
  [K in keyof Module]: Module[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

export interface UtilityClient<Module> {
  /** Forwards every property as a call to the process, so a new function of the module needs no line here. */
  api: UtilityApi<Module>;
  /** Starts the process up front, so the first call doesn't wait for it to boot. */
  start: () => void;
  stop: () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * The module `<name>-host.js` serves (a bundle beside this one, esbuild.js's `hostConfig`, run
 * through utility-host.ts's `serveModule`) in a `utilityProcess` of its own, `tet-<name>`: off the
 * main process, which relays pty output, so work there would lag typing. Started on the first call. A process that dies rejects every call in flight and is
 * restarted on the next one, not supervised: the calls are independent, so no state is lost. An
 * AbortSignal among a call's arguments reaches the function as one of the host's own. `onStart`
 * sees each process forked, to hand it a port of its own (utility-host.ts's `serveModule`).
 */
export function utilityClient<Module>(name: string, onStart?: (child: UtilityProcess) => void): UtilityClient<Module> {
  let child: UtilityProcess | undefined;
  const pending = new Map<number, Pending>();
  let nextId = 0;

  const fail = (message: string): void => {
    for (const request of pending.values()) {
      request.reject(new Error(message));
    }
    pending.clear();
  };

  const host = (): UtilityProcess => {
    if (child) {
      return child;
    }
    const started = utilityProcess.fork(path.join(__dirname, `${name}-host.js`), [], { serviceName: `tet-${name}` });
    started.on("message", (message: UtilityResponse) => {
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
      // A process stop() let go of may exit after a newer one started; leave that one alone.
      if (child !== started) {
        return;
      }
      child = undefined;
      fail(`The ${name} process stopped (exit code ${code})`);
    });
    child = started;
    onStart?.(started);
    return started;
  };

  const call = (method: string, args: unknown[]): Promise<unknown> => {
    const id = ++nextId;
    const signalAt = args.findIndex((arg) => arg instanceof AbortSignal);
    const signal = signalAt === -1 ? undefined : (args[signalAt] as AbortSignal);
    const request: UtilityRequest = signal
      ? { id, method, args: args.map((arg, index) => (index === signalAt ? undefined : arg)), signalAt }
      : { id, method, args };
    const onAbort = (): void => {
      // Never starts a process: a call still pending runs in `child`, and one that died is rejected.
      if (!pending.has(id)) {
        return;
      }
      try {
        child?.postMessage({ id, abort: true } satisfies UtilityMessage);
      } catch {
        // Its port is gone: the exit rejects the call.
      }
    };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        host().postMessage(request);
      } catch (error) {
        // A fork that failed or a port already gone; without this the caller waits forever.
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    }).finally(() => signal?.removeEventListener("abort", onAbort));
  };

  return {
    api: new Proxy({} as UtilityApi<Module>, {
      get: (_target, method: string) =>
        // Not a method: `await api` would otherwise call "then" in the host.
        method === "then" ? undefined : (...args: unknown[]) => call(method, args),
    }),
    start: () => void host(),
    stop: () => {
      child?.kill();
      child = undefined;
      fail(`The ${name} process was shut down`);
    },
  };
}
