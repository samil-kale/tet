import { errorMessage } from "../../shared/errors";

/**
 * A module served in a `utilityProcess` of its own, which `utility-client.ts` starts and calls:
 * each request names one of its functions, answered once that settles. Nothing here imports
 * electron, so a module may block as long as it likes, and every value crossing must survive a
 * structured clone (an image as a data URL, an error as its message).
 */
export interface UtilityRequest {
  id: number;
  method: string;
  args: unknown[];
  /** Where an AbortSignal stood among `args`, which no structured clone carries: the function is
   *  handed one of the host's own there, fired by a `UtilityAbort`. */
  signalAt?: number;
}

/** Fires the signal of the request with this id; the request still answers what its function returns. */
export interface UtilityAbort {
  id: number;
  abort: true;
}

export type UtilityMessage = UtilityRequest | UtilityAbort;

export interface UtilityResponse {
  id: number;
  value?: unknown;
  error?: string;
}

/** Answers each message for `module` through `respond`: the host's loop, and the tests' in-process one. */
export function serving(module: object, respond: (response: UtilityResponse) => void): (message: UtilityMessage) => void {
  const api = module as Record<string, (...args: unknown[]) => unknown>;
  const aborts = new Map<number, AbortController>();
  return (message) => {
    if ("abort" in message) {
      aborts.get(message.id)?.abort();
      return;
    }
    const { id, method, args, signalAt } = message;
    const call = api[method];
    if (typeof call !== "function") {
      respond({ id, error: `Unknown method: ${method}` });
      return;
    }
    if (signalAt !== undefined) {
      const controller = new AbortController();
      aborts.set(id, controller);
      args[signalAt] = controller.signal;
    }
    void (async () => {
      try {
        respond({ id, value: await call(...args) });
      } catch (error) {
        // An Error doesn't survive a structured clone, so only its message crosses.
        respond({ id, error: errorMessage(error) });
      } finally {
        aborts.delete(id);
      }
    })();
  };
}

/** Serves `module` to the process that forked this one. */
export function serveModule(module: object): void {
  const handle = serving(module, (response) => process.parentPort.postMessage(response));
  process.parentPort.on("message", (event) => handle(event.data as UtilityMessage));
}
