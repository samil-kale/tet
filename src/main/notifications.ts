import * as crypto from "node:crypto";
import { app, Notification } from "electron";
import { projectRefKey, projectRef } from "../shared/types";
import type { ProjectRef } from "../shared/types";
import type { ToastTarget } from "./control/control-server";
import { logError } from "./uncaught";

/** What the desktop toasts need of the app around them (main.ts owns all of it). */
interface NotificationDeps {
  /** Only an installed tet asks for the notification presenter: in a checkout it would write a
   *  Start menu entry reading "Electron". */
  installed: boolean;
  /** Brings the window back from minimized and focuses it. */
  revealWindow(): void;
  /** Flashes the taskbar until the window is focused. */
  attractAttention(): void;
  /** Brings a toast's tab to the front; false while that tab is not restored yet. */
  showTab(target: ToastTarget & { sessionId?: string }): boolean;
  /** The target tab's session id, which outlives a quit (see `windowsToastXml`). */
  sessionIdOf(target: ToastTarget): string | undefined;
}

let deps: NotificationDeps;

/**
 * A clicked toast's tab not yet restored (the click started tet). Looked for on each `onTabs` of
 * its repository or worktree; replaced by a later click.
 */
let toastTargetAwaited: (ToastTarget & { sessionId?: string }) | undefined;

/** Like notices (Notices.tsx), an identical toast within this span is dropped, without extending
 *  it. The target tab is part of the identity: two untitled tabs of one agent read the same, and
 *  dropping the second would point its click at the first's tab. */
const TOAST_REPEAT_MS = 8000;
const recentToasts = new Map<string, number>();

function repeatedToast(title: string, body: string, target?: ToastTarget): boolean {
  const now = Date.now();
  for (const [seen, at] of recentToasts) {
    if (now - at >= TOAST_REPEAT_MS) {
      recentToasts.delete(seen);
    }
  }
  const key = `${title}\u0000${body}\u0000${target ? projectRefKey(target.ref) : ""}\u0000${target?.tabId ?? ""}`;
  if (recentToasts.has(key)) {
    return true;
  }
  recentToasts.set(key, now);
  return false;
}

/**
 * Clickable toasts, held so their click handlers are not garbage-collected — outside win32, where
 * clicks arrive through `Notification.handleActivation`. Not released on `close`: that can be the
 * move to the notification center, where a click still arrives. Capped.
 */
const LIVE_TOASTS_MAX = 50;
const liveToasts = new Set<Notification>();

function holdToast(toast: Notification): void {
  if (liveToasts.size >= LIVE_TOASTS_MAX) {
    // Insertion order, so this is the one held longest.
    const oldest = liveToasts.values().next().value;
    if (oldest) {
      liveToasts.delete(oldest);
    }
  }
  liveToasts.add(toast);
}

/** For a toast clicked before its tab was restored. */
export function awaitedToastTab(ref: ProjectRef): void {
  if (
    toastTargetAwaited !== undefined &&
    projectRefKey(toastTargetAwaited.ref) === projectRefKey(ref) &&
    deps.showTab(toastTargetAwaited)
  ) {
    toastTargetAwaited = undefined;
  }
}

/**
 * Wires the toasts up and, on win32, takes every toast click — whether tet runs or the click
 * started it — carrying the `launch` string from `windowsToastXml`; Electron's own toast has none,
 * so no tab would be known.
 */
export function startNotifications(started: NotificationDeps): void {
  deps = started;
  if (process.platform !== "win32") {
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
      toastTargetAwaited = deps.showTab(target) ? undefined : target;
    });
  });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Electron's toast plus a `launch` string Windows hands back on a click. `type` and `tag` are
 * Electron's keys, so it still finds the Notification while tet runs; the session id outlives a
 * quit (showToastTarget).
 */
function windowsToastXml(id: string, title: string, body: string, target?: ToastTarget): string {
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
    `</binding></visual></toast>`
  );
}

/**
 * The desktop toast behind the `hook` and `notify` verbs — this process holds the desktop session
 * (a sandboxed hook has none). No `icon`: Windows takes tet's (APP_USER_MODEL_ID).
 *
 * A click brings the window and the toast's tab to the front — on win32 via
 * `Notification.handleActivation` (also after tet quit), elsewhere via the toast's `click`.
 */
export function showDesktopNotification(title: string, body: string, target?: ToastTarget): void {
  if (repeatedToast(title, body, target)) {
    return;
  }
  deps.attractAttention();
  if (!Notification.isSupported()) {
    return;
  }
  const id = crypto.randomUUID();
  const toast = new Notification(
    process.platform === "win32" ? { id, title, body, toastXml: windowsToastXml(id, title, body, target) } : { title, body }
  );
  if (process.platform !== "win32") {
    holdToast(toast);
    toast.on("click", () => {
      liveToasts.delete(toast);
      deps.revealWindow();
      if (target) {
        deps.showTab(target);
      }
    });
  }
  // The only trace of notifications being off in Windows' settings: "Settings prevent the
  // notification from being delivered".
  toast.on("failed", (_event, error) => {
    liveToasts.delete(toast);
    logError(`toast not delivered: ${error}`);
  });
  toast.show();
}
