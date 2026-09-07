import * as os from "node:os";
import { isAgentInstalled } from "./terminals/terminal-session";

/**
 * Whether Docker Sandboxes' `sbx` CLI is on PATH — cached the same way an agent's own
 * `--version` check is (`isAgentInstalled`), and deliberately not part of `Requirements.met`:
 * sbx is opt-in per project, never a reason to block the workspace from opening.
 */
export function checkSbxInstalled(): Promise<boolean> {
  return isAgentInstalled("sbx", ["--version"], os.tmpdir());
}
