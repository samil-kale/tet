import { createPortal } from "react-dom";
import type { NoticeSeverity } from "../../shared/types";
import { SeverityIcon } from "./icons";
import { createStore, useStore } from "./store";
import { useTopDialog } from "./window-covered";

/** VS Code's durations (notificationsToasts.ts). */
const DISMISS_MS: Record<NoticeSeverity, number> = { info: 10_000, warning: 12_000, error: 15_000 };

interface ShownNotice {
  id: number;
  severity: NoticeSeverity;
  message: string;
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
        </button>
      ))}
    </div>
  );
  return dialog ? createPortal(stack, dialog) : stack;
}
