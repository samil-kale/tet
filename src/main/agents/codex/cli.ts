import { runAgent } from "../ask";

/** As generous as the app-server call for the same one-offs (app-server-client.ts). */
const RUN_TIMEOUT_MS = 15_000;

/**
 * Runs `codex <args>` to completion on the host, for one-offs only. Resolves on exit 0, rejects
 * with stderr otherwise, or on the timeout. Unlike the app-server, parallel runs are fine
 * (measured, 0.156.1: six `codex delete` at once, against an existing and a fresh `CODEX_HOME`).
 */
export async function runCodex(executable: string, cwd: string, args: string[]): Promise<void> {
  await runAgent("codex", executable, cwd, args, RUN_TIMEOUT_MS);
}
