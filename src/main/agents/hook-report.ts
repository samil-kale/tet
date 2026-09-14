import { CONTROL_ENV } from "../../shared/control";

/**
 * The source of `report(event, sessionId)` for an agent that reports its turns from inside its own
 * process — opencode's generated plugin and pi's generated extension — rather than through a
 * `tet-ctl` hook process. The same wire contract tet-ctl speaks (src/shared/control.ts). The file
 * it is spliced into must import `node:http` as `http`.
 *
 * node:http rather than fetch: measured through both runtimes opencode ships as, and one
 * assumption fewer about the runtime pi brings. Never awaited: both agents wait for a handler to
 * return, and a turn mark must not hold up the TUI. The session goes along in the payload, as
 * Claude Code's and Codex's hooks carry it: it is what binds the tab to its session
 * (`hookSessionId`). `agentName` only names who is left uninformed when a report fails.
 */
export function renderHookReport(agentName: string): string {
  return `// The names only: the port and token behind them are new on every start of tet, and baking
// them in would change this file on every start.
const CONTROL = ${JSON.stringify(CONTROL_ENV)};

// This tab's own turn, reported to tet over its control channel, from inside this process.
function report(event: string, sessionId: string | undefined): void {
  const port = process.env[CONTROL.port];
  const token = process.env[CONTROL.token];
  if (!port || !token) {
    return;
  }
  const payload = JSON.stringify(sessionId ? { session_id: sessionId } : {});
  const body = JSON.stringify({
    token,
    verb: "hook",
    args: { event, payload },
    caller: { projectId: process.env[CONTROL.projectId], tabId: process.env[CONTROL.tabId] },
    // Now, not when it arrives: nothing here is awaited, so two reports of one turn race.
    at: Date.now()
  });
  try {
    const request = http.request(
      {
        host: process.env[CONTROL.host] || "127.0.0.1",
        port: Number(port),
        method: "POST",
        path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close" }
      },
      (response: any) => response.resume()
    );
    request.on("error", () => undefined);
    request.end(body);
  } catch {
    // Nothing to tell ${agentName} about; a missed report is a tab that has to be looked at.
  }
}`;
}
