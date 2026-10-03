import { createPortal } from "react-dom";
import type { NoticeProgress, NoticeSeverity } from "../../shared/types/app";
import { SeverityIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { createStore, useStore } from "./store";
import { useTopDialog } from "./window-covered";

/** VS Code's durations. */
const DISMISS_MS: Record<NoticeSeverity, number> = { info: 10_000, warning: 12_000, error: 15_000 };

interface ShownNotice {
  id: number;
  severity: NoticeSeverity;
  message: string;
  /** A progress notice's (`showProgress`). */
  progress?: { key: string; fraction: number | null };
}

/**
 * How the user is told something, unless a dialog on screen says it (`DialogFrame`, `Field`); no
 * other view keeps a message of its own. A plain function,
 * not a hook or prop, so anything anywhere can report without a threaded callback — modelled on
 * VS Code's `window.showErrorMessage`. The main process says things through `app:notice`.
 */
const shown = createStore<ShownNotice[]>([]);
let nextId = 0;
/** The notice under the pointer, kept while hovered. */
let hovered: number | undefined;
/** Progresses whose notice the user dismissed: not shown again until they end. */
const dismissedProgress = new Set<string>();

export function notify(severity: NoticeSeverity, message: string): void {
  const id = ++nextId;
  // An identical message already standing is dropped, not stacked.
  if (shown.get().some((notice) => notice.message === message && notice.severity === severity)) {
    return;
  }
  shown.set([...shown.get(), { id, severity, message }]);
  scheduleDismiss(id, severity);
  window.tet.app.reportNotice({ severity, message, at: Date.now() });
}

/**
 * A download's progress, one notice per `key` updated in place: it stands, with a bar along its
 * bottom edge as VS Code's, until the progress ends or a click dismisses it. Ended on `done`, it
 * stays in its place as a plain info, dismissed as one; dismissed earlier, that info comes anew.
 */
export function showProgress({ key, message, fraction, done }: NoticeProgress): void {
  const standing = shown.get().find((notice) => notice.progress?.key === key);
  if (fraction === undefined) {
    if (standing && done) {
      shown.set(shown.get().map((notice) => (notice === standing ? { id: notice.id, severity: "info", message } : notice)));
      scheduleDismiss(standing.id, "info");
      window.tet.app.reportNotice({ severity: "info", message, at: Date.now() });
    } else if (standing) {
      dismissNotice(standing.id);
    } else if (done) {
      notify("info", message);
    }
    dismissedProgress.delete(key);
    return;
  }
  if (dismissedProgress.has(key)) {
    return;
  }
  if (standing) {
    shown.set(shown.get().map((notice) => (notice === standing ? { ...notice, message, progress: { key, fraction } } : notice)));
    return;
  }
  shown.set([...shown.get(), { id: ++nextId, severity: "info", message, progress: { key, fraction } }]);
  window.tet.app.reportNotice({ severity: "info", message, at: Date.now() });
}

/**
 * As in VS Code: a notice due while hovered gets its full time again; one due while the window is
 * unfocused waits for focus, then gets its full time.
 */
function scheduleDismiss(id: number, severity: NoticeSeverity): void {
  setTimeout(() => {
    if (!shown.get().some((notice) => notice.id === id)) {
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
  const progress = shown.get().find((notice) => notice.id === id)?.progress;
  if (progress) {
    dismissedProgress.add(progress.key);
  }
  shown.set(shown.get().filter((notice) => notice.id !== id));
}

/**
 * Stacked in the bottom right corner, newest at the bottom, dismissed by a click. Inside the dialog
 * on top while one is up (`useTopDialog`): outside it they would lie under its dim, inert.
 */
export function Notices() {
  const notices = useStore(shown);
  const dialog = useTopDialog();
  if (notices.length === 0) {
    return null;
  }
  const stack = (
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
          {notice.progress && (
            <span className="notice-progress">
              {notice.progress.fraction === null ? (
                <ProgressBar />
              ) : (
                <span className="notice-progress-fill" style={{ width: `${notice.progress.fraction * 100}%` }} />
              )}
            </span>
          )}
        </button>
      ))}
    </div>
  );
  return dialog ? createPortal(stack, dialog) : stack;
}
