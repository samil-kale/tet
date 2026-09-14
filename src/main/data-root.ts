import * as os from "node:os";
import * as path from "node:path";

/**
 * tet's data folder: `~/.tet` on every platform, the way the agents keep `~/.claude`, `~/.codex`
 * and `~/.pi`. Everything tet itself stores lives here — settings, projects, provider accounts,
 * logs, the tet-ctl launcher, updates and agent-data — while Electron's `userData` keeps only
 * Chromium's own profile (caches, localStorage). One path on every machine is what lets an
 * organization governing sbx allow tet's mounted folders with one rule (sbx.ts's readSbxBlockers),
 * and it keeps transcripts and logs out of a roaming Windows profile. `--user-data-dir` (the tests'
 * own profile, main.ts) puts both in that one folder, so a test run touches nothing of the user's.
 */
export function resolveDataRoot(userDataArg: string | undefined): string {
  return userDataArg ? path.resolve(userDataArg) : path.join(os.homedir(), ".tet");
}
