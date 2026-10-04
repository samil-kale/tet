import * as crypto from "node:crypto";
import { app, Notification } from "electron";
import { projectRef, projectRefKey } from "../../shared/types/project";
import type { ProjectRef } from "../../shared/types/project";
import { logError } from "./error-log";
import { PLATFORM } from "./host-platform";

/** The tab a notification is about, which a click shows. */
export interface NotificationTarget {
  ref: ProjectRef;
  tabId: string;
}

/** What the desktop notifications need of the app around them (the window, AppWindow, and the tabs; handed in by main.ts). */
interface NotificationDeps {
  /** Only an installed tet asks for the notification presenter: in a checkout it would write a
   *  Start menu entry reading "Electron". */
  installed: boolean;
  /** Brings the window back from minimized and focuses it. */
  revealWindow(): void;
  /** Flashes the taskbar until the window is focused. */
  attractAttention(): void;
  /** Brings a notification's tab to the front; false while that tab is not restored yet. */
  showTab(target: NotificationTarget & { sessionId?: string }): boolean;
  /** The target tab's session id, which outlives a quit (see `windowsToastXml`). */
  sessionIdOf(target: NotificationTarget): string | undefined;
}

let deps: NotificationDeps;

/**
 * A clicked notification's tab not yet restored (the click started tet). Looked for on each `onTabs` of
 * its repository or worktree; replaced by a later click.
 */
let notificationTargetAwaited: (NotificationTarget & { sessionId?: string }) | undefined;

/** An identical notification within this span is dropped, without extending it. The target tab is part of the identity: two untitled tabs of one agent read the same, and
 *  dropping the second would point its click at the first's tab. */
const NOTIFICATION_REPEAT_MS = 8000;
const recentNotifications = new Map<string, number>();

function repeatedNotification(title: string, body: string, target?: NotificationTarget): boolean {
  const now = Date.now();
  for (const [seen, at] of recentNotifications) {
    if (now - at >= NOTIFICATION_REPEAT_MS) {
      recentNotifications.delete(seen);
    }
  }
  const key = `${title}\u0000${body}\u0000${target ? projectRefKey(target.ref) : ""}\u0000${target?.tabId ?? ""}`;
  if (recentNotifications.has(key)) {
    return true;
  }
  recentNotifications.set(key, now);
  return false;
}

/**
 * Clickable notifications, held so their click handlers are not garbage-collected — outside win32, where
 * clicks arrive through `Notification.handleActivation`. Not released on `close`: that can be the
 * move to the notification center, where a click still arrives. Capped.
 */
const LIVE_NOTIFICATIONS_MAX = 50;
const liveNotifications = new Set<Notification>();

function holdNotification(notification: Notification): void {
  if (liveNotifications.size >= LIVE_NOTIFICATIONS_MAX) {
    // Insertion order, so this is the one held longest.
    const oldest = liveNotifications.values().next().value;
    if (oldest) {
      liveNotifications.delete(oldest);
    }
  }
  liveNotifications.add(notification);
}

/** For a notification clicked before its tab was restored. */
export function awaitedNotificationTab(ref: ProjectRef): void {
  if (
    notificationTargetAwaited !== undefined &&
    projectRefKey(notificationTargetAwaited.ref) === projectRefKey(ref) &&
    deps.showTab(notificationTargetAwaited)
  ) {
    notificationTargetAwaited = undefined;
  }
}

/**
 * Wires the notifications up and, on win32, takes every notification click — whether tet runs or the click
 * started it — carrying the `launch` string from `windowsToastXml`; Electron's own notification has none,
 * so no tab would be known.
 */
export function startNotifications(started: NotificationDeps): void {
  deps = started;
  if (!PLATFORM.windowsNotifications) {
    return;
  }
  void app.whenReady().then(() => {
    // Electron registers the COM activator only once its notification presenter exists, which the
    // first Notification or this call creates — asked at once, or a click that started tet reaches
    // no one. Installed only: the presenter also writes the Start menu entry ("Electron" in dev).
    if (deps.installed) {
      Notification.isSupported();
    }
    Notification.handleActivation((details) => {
      deps.revealWindow();
      const launch = new URLSearchParams(details.arguments);
      const projectId = launch.get("project");
      const tabId = launch.get("tab");
      if (!projectId || !tabId) {
        return;
      }
      const ref = projectRef(projectId, launch.get("worktree") || undefined);
      const target = { ref, tabId, sessionId: launch.get("session") || undefined };
      notificationTargetAwaited = deps.showTab(target) ? undefined : target;
    });
  });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Electron's notification plus a `launch` string Windows hands back on a click. `type` and `tag` are
 * Electron's keys, so it still finds the Notification while tet runs; the session id outlives a
 * quit (showNotificationTarget).
 */
function windowsToastXml(id: string, title: string, body: string, target?: NotificationTarget): string {
  const launch = new URLSearchParams({ type: "click", tag: id });
  if (target) {
    launch.set("project", target.ref.projectId);
    if (target.ref.worktree !== undefined) {
      launch.set("worktree", target.ref.worktree);
    }
    launch.set("tab", target.tabId);
    const sessionId = deps.sessionIdOf(target);
    if (sessionId) {
      launch.set("session", sessionId);
    }
  }
  return (
    `<toast launch="${escapeXml(launch.toString())}"><visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>` +
    `</binding></visual></notification>`
  );
}

/**
 * The desktop notification behind the `hook` and `notify` verbs — this process holds the desktop session
 * (a sandboxed hook has none). No `icon`: Windows takes tet's (APP_USER_MODEL_ID).
 *
 * A click brings the window and the notification's tab to the front — on win32 via
 * `Notification.handleActivation` (also after tet quit), elsewhere via the notification's `click`.
 */
export function showDesktopNotification(title: string, body: string, target?: NotificationTarget): void {
  if (repeatedNotification(title, body, target)) {
    return;
  }
  deps.attractAttention();
  if (!Notification.isSupported()) {
    return;
  }
  const id = crypto.randomUUID();
  const notification = new Notification(
    PLATFORM.windowsNotifications ? { id, title, body, toastXml: windowsToastXml(id, title, body, target) } : { title, body }
  );
  if (!PLATFORM.windowsNotifications) {
    holdNotification(notification);
    notification.on("click", () => {
      liveNotifications.delete(notification);
      deps.revealWindow();
      if (target) {
        deps.showTab(target);
      }
    });
  }
  // The only trace of notifications being off in Windows' settings: "Settings prevent the
  // notification from being delivered".
  notification.on("failed", (_event, error) => {
    liveNotifications.delete(notification);
    logError(`notification not delivered: ${error}`);
  });
  notification.show();
}
