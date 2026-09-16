import * as crypto from "node:crypto";

/**
 * A tab's control token: this run's token keyed to the tab's project and tab id. A terminal gets
 * only its own (pty.ts's buildEnv), never the run's, and the server takes a caller's ids only with
 * the token made for them — so a tab cannot speak for another by changing `TET_PROJECT_ID` or
 * `TET_TAB_ID`. It does not stop a process of the same user reading another tab's environment on
 * the host; a sandbox sees no host process.
 */
export function tabControlToken(runToken: string, projectId: string, tabId: string): string {
  return crypto.createHmac("sha256", runToken).update(JSON.stringify([projectId, tabId])).digest("base64url");
}
