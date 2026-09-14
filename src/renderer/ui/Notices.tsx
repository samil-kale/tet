import { useSyncExternalStore } from "react";
import type { NoticeSeverity } from "../../shared/types";
import { SeverityIcon } from "./icons";

/** Long enough to read a line, short enough not to sit in the way. Same for every severity. */
const DISMISS_MS = 8000;

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
  setTimeout(() => dismissNotice(id), DISMISS_MS);
}

function dismissNotice(id: number): void {
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
          title="Dismiss"
        >
          <SeverityIcon className="notice-icon" severity={notice.severity} />
          <span className="notice-message">{notice.message}</span>
        </button>
      ))}
    </div>
  );
}
