import * as git from "./git";
import { errorMessage } from "../../shared/errors";

/**
 * The git process: all of `git.ts` runs here, in its own `utilityProcess`; the main process sends
 * only a method name and arguments (`git-client.ts`). Nothing here or in `git.ts` may import
 * electron, so it may block as long as git does, and every value crossing must survive a structured
 * clone (an image as a data URL, an error as its message). Off the main process, which relays pty
 * output: git there would lag typing.
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
      respond({ id, error: errorMessage(error) });
    }
  })();
});
