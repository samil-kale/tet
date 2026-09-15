import { nonEmptyString } from "./transcript";

/**
 * The session a hook payload names. Claude Code and Codex put `session_id` — their transcript's
 * id — into every hook's stdin (measured, 2.1.270 and 0.154.0); opencode's plugin and pi's
 * extension send the same field. Undefined for non-JSON or no session.
 */
export function hookSessionId(payload: string): string | undefined {
  try {
    return nonEmptyString((JSON.parse(payload) as { session_id?: unknown } | null)?.session_id);
  } catch {
    return undefined;
  }
}
