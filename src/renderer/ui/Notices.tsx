import { useSyncExternalStore } from "react";
import type { NoticeSeverity } from "../../shared/types";
import { SeverityIcon } from "./icons";

/** VS Code's durations (notificationsToasts.ts). */
const DISMISS_MS: Record<NoticeSeverity, number> = { info: 10_000, warning: 12_000, error: 15_000 };

interface ShownNotice {
  id: number;
  severity: NoticeSeverity;
  message: string;
}

/**
 * The only way to tell the user something; views keep no messages of their own. A plain function,
 * not a hook or prop, so anything anywhere can report without a threaded callback.
 */
let shown: ShownNotice[] = [];
const listeners = new Set<() => void>();
let nextId = 0;
/** The notice under the pointer, kept while hovered. */
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
  window.tet.app.reportNotice({ severity, message, at: Date.now() });
}

/**
 * As in VS Code: a notice due while hovered gets its full time again; one due while the window is
 * unfocused waits for focus, then gets its full time.
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

/** Stacked in the bottom right corner, newest at the bottom, dismissed by a click. */
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
