import { isRecord } from "../../json-file";
import { execInSandbox } from "../../sbx";
import { runAgent } from "../ask";

/**
 * How long a host run may take: ten times its measured boot, as generous as Codex's app-server
 * call for the same one-offs (app-server-client.ts), so a hung opencode fails a delete instead of
 * holding it forever.
 */
const RUN_TIMEOUT_MS = 15_000;

/**
 * Runs `opencode <args>` to completion where the session lives: here, or in the named sandbox.
 * Each run boots opencode (~1.5 s measured, writing to the database), so only for one-offs —
 * delete, export, the background question's cleanup — never from a tab's output or a timer.
 * Resolves with stdout on exit 0, rejects with stderr otherwise, or on the timeout.
 */
export function runOpencode(executable: string, cwd: string, sandbox: string | null | undefined, args: string[]): Promise<string> {
  if (sandbox) {
    return execInSandbox(sandbox, cwd, ["opencode", ...args]);
  }
  return runAgent("opencode", executable, cwd, args, RUN_TIMEOUT_MS);
}

/** `session list --format json` (measured, 1.18.4: an array of `{id, title, …}`); undefined when
 *  it prints nothing or something else, which says nothing about a session. Rejects as runOpencode
 *  does. */
export async function listOpencodeSessions(
  executable: string,
  cwd: string,
  sandbox: string | null
): Promise<Record<string, unknown>[] | undefined> {
  const output = await runOpencode(executable, cwd, sandbox, ["session", "list", "--format", "json"]);
  const listed: unknown = output.trim() ? JSON.parse(output) : undefined;
  return Array.isArray(listed) ? listed.filter(isRecord) : undefined;
}
