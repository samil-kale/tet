import * as crypto from "node:crypto";
import type { ProjectRef } from "../../shared/types";

/**
 * A tab's control token: this run's token keyed to the tab's project and worktree, tab id
 * and whether it runs in a sandbox. A terminal gets only its own (pty.ts's buildEnv), never the
 * run's, and the server takes a caller's ids only with the token made for them — so a tab cannot
 * speak for another by changing `TET_PROJECT_ID`, `TET_WORKTREE` or `TET_TAB_ID`. It does not stop a
 * process of the same user reading another tab's environment on the host; a sandbox sees no host
 * process.
 *
 * `sandboxed` is in the token rather than looked up when a request arrives: the token stays valid
 * for the run, so a tab closed with its repository or worktree must still be answered by the rules
 * it started under, and the server reads the flag back by trying both (control-server's `handle`).
 */
export function tabControlToken(runToken: string, ref: ProjectRef, tabId: string, sandboxed: boolean): string {
  return crypto
    .createHmac("sha256", runToken)
    .update(JSON.stringify([ref.projectId, ref.worktree ?? null, tabId, sandboxed]))
    .digest("base64url");
}
