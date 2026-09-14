import { nonEmptyString } from "./transcript";

/**
 * The session a hook report is about, as the report's payload names it. Claude Code and Codex
 * put `session_id` into every hook's stdin, the id their transcript is listed under (measured,
 * 2.1.270 and 0.154.0); opencode's plugin and pi's extension send the same field from inside
 * their own process. A payload that is not JSON, or names no session, is undefined.
 */
export function hookSessionId(payload: string): string | undefined {
  try {
    return nonEmptyString((JSON.parse(payload) as { session_id?: unknown } | null)?.session_id);
  } catch {
    return undefined;
  }
}
