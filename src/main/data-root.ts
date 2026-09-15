import * as os from "node:os";
import * as path from "node:path";

/**
 * `~/.tet` on every platform, like the agents' `~/.claude`, `~/.codex`, `~/.pi`: settings,
 * projects, accounts, logs, the tet-ctl launcher, updates, agent-data. Electron's `userData` keeps
 * only Chromium's profile. One fixed path lets an sbx organization allow tet's mounted folders with
 * one rule (sbx.ts's readSbxBlockers) and keeps logs out of a roaming Windows profile.
 * `--user-data-dir` (the tests' profile, main.ts) puts both in that folder.
 */
export function resolveDataRoot(userDataArg: string | undefined): string {
  return userDataArg ? path.resolve(userDataArg) : path.join(os.homedir(), ".tet");
}
