import * as git from "./git";

/**
 * The git process. Everything in `git.ts` runs here, in a `utilityProcess` of its own, and the
 * main process only sends it a method name and arguments — see `git-client.ts` for the other
 * half and CLAUDE.md for why the two are apart: a fetch against a slow remote would otherwise
 * be time a keystroke on its way to a terminal waits for.
 *
 * Nothing here touches Electron. A plain node process running the git CLI and reading files,
 * so it can block for as long as git does without anything noticing.
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
      // Errors do not survive a structured clone as errors, so only the message crosses over.
      respond({ id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
