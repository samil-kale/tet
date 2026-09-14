import { useSyncExternalStore } from "react";
import type { NoticeSeverity } from "../../shared/types";
import { SeverityIcon } from "./icons";

/** VS Code's own durations (notificationsToasts.ts): the more serious, the longer it stays. */
const DISMISS_MS: Record<NoticeSeverity, number> = { info: 10_000, warning: 12_000, error: 15_000 };

interface ShownNotice {
  id: number;
  severity: NoticeSeverity;
  message: string;
}

/**
 * Everything the user is told goes through here — there is no second way to say something in
 * this app, and views keep no messages of their own. A plain function rather than a hook or a
 * prop, so whatever fails, wherever, can report it without a callback threaded to it first.
 */
let shown: ShownNotice[] = [];
const listeners = new Set<() => void>();
let nextId = 0;
/** The notice under the pointer, which is not taken away while it is being read. */
let hovered: number | undefined;

function publish(next: ShownNotice[]): void {
  shown = next;
  for (const listener of listeners) {
    listener();
  }
}

export function notify(severity: NoticeSeverity, message: string): void {
  const id = ++nextId;
  // An identical message already standing is dropped, not stacked.
  if (shown.some((notice) => notice.message === message && notice.severity === severity)) {
    return;
  }
  publish([...shown, { id, severity, message }]);
  scheduleDismiss(id, severity);
}

/**
 * As VS Code does: a notice due while hovered gets its whole time again, and one due while the
 * window is out of focus waits for the focus to return and then gets its whole time — it would
 * otherwise be gone before anyone looked.
 */
function scheduleDismiss(id: number, severity: NoticeSeverity): void {
  setTimeout(() => {
    if (!shown.some((notice) => notice.id === id)) {
      return;
    }
    if (hovered === id) {
      scheduleDismiss(id, severity);
    } else if (!document.hasFocus()) {
      window.addEventListener("focus", () => scheduleDismiss(id, severity), { once: true });
    } else {
      dismissNotice(id);
    }
  }, DISMISS_MS[severity]);
}

function dismissNotice(id: number): void {
  // A removed element never reports the pointer leaving it.
  if (hovered === id) {
    hovered = undefined;
  }
  publish(shown.filter((notice) => notice.id !== id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stacked over the window's bottom right corner, newest at the bottom, each dismissed by clicking it. */
export function Notices() {
  const notices = useSyncExternalStore(subscribe, () => shown);
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notices">
      {notices.map((notice) => (
        <button
          key={notice.id}
          className={`notice ${notice.severity}`}
          onClick={() => dismissNotice(notice.id)}
          onMouseEnter={() => (hovered = notice.id)}
          onMouseLeave={() => (hovered = undefined)}
          title="Dismiss"
        >
          <SeverityIcon className="notice-icon" severity={notice.severity} />
          <span className="notice-message">{notice.message}</span>
        </button>
      ))}
    </div>
  );
}
