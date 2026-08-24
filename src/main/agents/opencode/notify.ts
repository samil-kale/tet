import { exec } from "node:child_process";
import * as path from "node:path";
import { buildNotifyCommand } from "../../terminals/os-notify";
import type { NotificationSettings } from "../../../shared/types";

/**
 * What opencode calls a finished turn. Named here rather than spelled out twice: the toast
 * below and the mark on the tab answer the same event, and two copies of the string could
 * drift into disagreeing about when a session is done.
 */
export const SESSION_FINISHED_EVENT = "session.idle";

/**
 * The other end of a turn: `session.status` with a `busy` status. Verified against the
 * binary's own `SessionStatus`, a tagged union whose other branches describe a provider
 * rather than work in progress — so the tag is what decides, not the event on its own.
 */
export const SESSION_STATUS_EVENT = "session.status";
export const SESSION_BUSY_STATUS = "busy";

/**
 * The turn stopped part-way for an answer only the user can give. Named here for the same
 * reason as the event above — the toast and the mark on the tab answer the same events.
 *
 * `session.error` is deliberately not one of them, although it shares the toast below: an error
 * is something that happened, not a question standing open, and marking a tab for it would put
 * a state on screen that nothing can ever answer.
 */
export const SESSION_WAITING_EVENTS = ["permission.asked", "question.asked"] as const;

/**
 * Fires the OS notifications for opencode. No hooks and no generated plugin: the server's own
 * event stream carries what a notification would be about, and tet is already subscribed
 * to it for everything else — opencode's configuration stays untouched.
 */
export function createOpencodeNotifier(
  storageDir: string,
  cwd: string,
  displayName: string,
  notifications: NotificationSettings
): (eventType: string) => void {
  const repositoryName = path.basename(cwd);
  const commands = new Map<string, string>();

  if (notifications.finished) {
    const command = buildNotifyCommand(
      storageDir,
      "stop",
      `${displayName}: Finished`,
      `Finished in ${repositoryName}`
    );
    commands.set(SESSION_FINISHED_EVENT, command);
  }
  if (notifications.needsYou) {
    const command = buildNotifyCommand(
      storageDir,
      "needs-you",
      `${displayName}: Action needed`,
      `Waiting for input in ${repositoryName}`
    );
    for (const type of [...SESSION_WAITING_EVENTS, "session.error"]) {
      commands.set(type, command);
    }
  }

  return (eventType) => {
    const command = commands.get(eventType);
    if (command) {
      exec(command, () => {
        // Notification failures must never disturb the session.
      });
    }
  };
}
