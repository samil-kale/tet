import * as git from "./git";

/**
 * The git process: all of `git.ts` runs here, in its own `utilityProcess`; the main process sends
 * only a method name and arguments (`git-client.ts`). Nothing here touches Electron, so it may
 * block as long as git does.
 */
export interface GitRequest {
  id: number;
  method: string;
  args: unknown[];
}

export interface GitResponse {
  id: number;
  value?: unknown;
  error?: string;
}

const api = git as unknown as Record<string, (...args: unknown[]) => unknown>;

process.parentPort.on("message", (event) => {
  const { id, method, args } = event.data as GitRequest;
  void (async () => {
    const respond = (response: GitResponse): void => process.parentPort.postMessage(response);
    const call = api[method];
    if (typeof call !== "function") {
      respond({ id, error: `Unknown git method: ${method}` });
      return;
    }
    try {
      respond({ id, value: await call(...args) });
    } catch (error) {
      // An Error doesn't survive a structured clone, so only its message crosses.
      respond({ id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
