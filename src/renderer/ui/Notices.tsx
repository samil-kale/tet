import { useSyncExternalStore } from "react";
import type { NoticeSeverity } from "../../shared/types";
import { SeverityIcon } from "./icons";

/** Long enough to read a line, short enough not to sit in the way. Same for every severity — a
 *  notice you didn't click away still shouldn't outlive the moment it was about. */
const DISMISS_MS = 8000;

/** How long a progress notice sits at 100% before it closes itself — long enough to read that
 *  it finished, short enough not to need a click. */
const PROGRESS_DONE_MS = 2000;

interface ShownNotice {
  id: number;
  severity: NoticeSeverity;
  message: string;
  /** 0-100 while tracking a download; undefined for a plain notice. Presence, not severity,
   *  decides whether a notice renders its bar and skips click-to-dismiss. */
  progress?: number;
}

/**
 * Everything the user is told goes through here — there is no second way to say something in
 * this app, and views keep no messages of their own. A plain function rather than a hook or a
 * prop, the way VS Code's `window.showErrorMessage` is: whatever fails, wherever, can report it
 * without a callback threaded to it first.
 */
let shown: ShownNotice[] = [];
const listeners = new Set<() => void>();
let nextId = 0;
// The one progress notice in flight, if any. A download's percent changes on every tick, so
// each tick updates this notice in place rather than stacking a new one under a new message.
let progressNoticeId: number | null = null;

function publish(next: ShownNotice[]): void {
  shown = next;
  for (const listener of listeners) {
    listener();
  }
}

export function notify(severity: NoticeSeverity, message: string, progress?: number): void {
  if (progress !== undefined) {
    notifyProgress(severity, message, progress);
    return;
  }
  const id = ++nextId;
  // A failure that repeats (a checkout retried on the same dirty tree, say) says nothing new
  // the second time — better one message standing than a wall of identical ones.
  if (shown.some((notice) => notice.message === message && notice.severity === severity)) {
    return;
  }
  publish([...shown, { id, severity, message }]);
  setTimeout(() => dismissNotice(id), DISMISS_MS);
}

function notifyProgress(severity: NoticeSeverity, message: string, progress: number): void {
  const clamped = Math.max(0, Math.min(100, progress));
  const existing = progressNoticeId !== null && shown.some((notice) => notice.id === progressNoticeId);
  if (existing) {
    publish(
      shown.map((notice) =>
        notice.id === progressNoticeId ? { ...notice, severity, message, progress: clamped } : notice
      )
    );
  } else {
    progressNoticeId = ++nextId;
    publish([...shown, { id: progressNoticeId, severity, message, progress: clamped }]);
  }
  if (clamped >= 100) {
    setTimeout(() => dismissNotice(progressNoticeId!), PROGRESS_DONE_MS);
  }
}

function dismissNotice(id: number): void {
  if (id === progressNoticeId) {
    progressNoticeId = null;
  }
  publish(shown.filter((notice) => notice.id !== id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Stacked over the window's bottom right corner, newest at the bottom, each dismissed by
 * clicking it — except a progress notice, which tracks a download and closes itself once it
 * reaches 100% rather than waiting to be clicked away.
 */
export function Notices() {
  const notices = useSyncExternalStore(subscribe, () => shown);
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notices">
      {notices.map((notice) =>
        notice.progress === undefined ? (
          <button
            key={notice.id}
            className={`notice ${notice.severity}`}
            onClick={() => dismissNotice(notice.id)}
            title="Dismiss"
          >
            <SeverityIcon className="notice-icon" severity={notice.severity} />
            <span className="notice-message">{notice.message}</span>
          </button>
        ) : (
          <div key={notice.id} className={`notice notice-progress ${notice.severity}`}>
            <div className="notice-row">
              <SeverityIcon className="notice-icon" severity={notice.severity} />
              <span className="notice-message">{notice.message}</span>
            </div>
            <div className="notice-progress-track">
              <div className="notice-progress-fill" style={{ width: `${notice.progress}%` }} />
            </div>
          </div>
        )
      )}
    </div>
  );
}
