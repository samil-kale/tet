import * as crypto from "node:crypto";
import type { ControlSide } from "../../shared/control-side";
import type { ProjectRef } from "../../shared/types/project";

/**
 * A tab's control token: this run's token keyed to the tab's project and worktree, tab id and the
 * side it runs on (ControlSide.key). A terminal gets only its own (pty.ts's buildEnv), never the
 * run's, and the server takes a caller's ids only with the token made for them — so a tab cannot
 * speak for another by changing `TET_PROJECT_ID`, `TET_WORKTREE` or `TET_TAB_ID`. It does not stop a
 * process of the same user reading another tab's environment on the host; a sandbox sees no host
 * process.
 *
 * The side is in the token rather than looked up when a request arrives: the token stays valid
 * for the run, so a tab closed with its repository or worktree must still be answered by the rules
 * it started under, and the server reads the side back by trying each (control-server's `handle`).
 */
export function tabControlToken(runToken: string, ref: ProjectRef, tabId: string, side: ControlSide): string {
  return crypto
    .createHmac("sha256", runToken)
    .update(JSON.stringify([ref.projectId, ref.worktree ?? null, tabId, side.key]))
    .digest("base64url");
}
