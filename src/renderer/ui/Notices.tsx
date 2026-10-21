import { createPortal } from "react-dom";
import type { Notice, NoticeProgress, NoticeSeverity } from "../../shared/types/app";
import { refKeyOf } from "../../shared/types/project";
import type { TabDescriptor, TabRef } from "../../shared/types/terminals";
import { SeverityIcon } from "./icons";
import { TabMark } from "./TabMark";
import { ProgressBar } from "./ProgressBar";
import { createStore, useStore } from "./store";
import { useTopDialog } from "./window-covered";

/** VS Code's durations. */
const DISMISS_MS: Record<NoticeSeverity, number> = { info: 10_000, warning: 12_000, error: 15_000 };

/** The notification center keeps this many, the oldest dropped first. */
const CENTER_MAX = 100;

/** How long a notice takes to enter or leave, and the notification center to close; the stylesheet's `.notice-item` transition. */
const LEAVE_MS = 200;

export interface ShownNotice extends Omit<Notice, "toast"> {
  id: number;
  /** Whether its toast still stands; the entry stays in the notification center without it. */
  toast: boolean;
  /** Seen in the notification center. */
  read: boolean;
  /** Fading out of the notification center, removed once it has. `center`: the last one, which takes the whole center along. */
  leaving?: "item" | "center";
  /** Its toast fading out; the entry stays in the notification center. */
  dismissing?: true;
  /** A progress notice's (`showProgress`). */
  progress?: { key: string; fraction: number | null };
}

/**
 * How the user is told something, unless a dialog on screen says it (`DialogFrame`, `Field`); no
 * other view keeps a message of its own. A plain function,
 * not a hook or prop, so anything anywhere can report without a threaded callback — modelled on
 * VS Code's `window.showErrorMessage`. The main process says things through `app:notice`. Every
 * notice stays listed in the notification center (`NoticesCenter`) until removed there; the toast
 * is only its first showing.
 */
const shown = createStore<ShownNotice[]>([]);
const centerOpen = createStore(false);
/** Fading out, closed once it has. */
const centerClosing = createStore(false);
/** What waits for the notification center to have closed (`closeCenter`). */
const afterClose: (() => void)[] = [];
let nextId = 0;
/** The newest notice when the notification center last opened: a later one enters it with its transition. */
let newestAtOpen = 0;
/** The notice under the pointer, kept while hovered. */
let hovered: number | undefined;

export function useNoticeList(): ShownNotice[] {
  return useStore(shown);
}

/** The notices standing, read outside a component. */
export function listNotices(): ShownNotice[] {
  return shown.get();
}

export function useCenterClosing(): boolean {
  return useStore(centerClosing);
}

/** Listed after the notification center opened, so it enters with its own transition. */
export function enteredOpenCenter(notice: ShownNotice): boolean {
  return notice.id > newestAtOpen;
}

export function useCenterOpen(): boolean {
  return useStore(centerOpen);
}

/** Opening the center reads everything in it. */
export function toggleCenter(): void {
  if (centerOpen.get()) {
    closeCenter();
    return;
  }
  newestAtOpen = nextId;
  centerOpen.set(true);
  shown.set(shown.get().map((notice) => (notice.read ? notice : { ...notice, read: true })));
}

/**
 * Every way of closing the notification center fades it out whole, in `LEAVE_MS`; `then` runs once
 * it is closed (at once, if it is not open).
 */
export function closeCenter(then?: () => void): void {
  if (then) {
    afterClose.push(then);
  }
  if (!centerOpen.get()) {
    runAfterClose();
    return;
  }
  if (centerClosing.get()) {
    return;
  }
  centerClosing.set(true);
  setTimeout(() => {
    centerClosing.set(false);
    centerOpen.set(false);
    runAfterClose();
  }, LEAVE_MS);
}

function runAfterClose(): void {
  for (const run of afterClose.splice(0)) {
    run();
  }
}

export function notify(severity: NoticeSeverity, message: string, options: Pick<Notice, "toast" | "target" | "mark"> = {}): void {
  const { toast, target, mark } = options;
  const same = shown
    .get()
    .find((notice) => notice.severity === severity && notice.message === message && targetKey(notice.target) === targetKey(target));
  // An identical notice's toast already standing is not stacked.
  if (same?.toast && toast !== false) {
    return;
  }
  const id = ++nextId;
  const entry: ShownNotice = { id, severity, message, toast: toast !== false, read: centerOpen.get(), target, mark };
  shown.set([...shown.get().filter((notice) => notice !== same), entry].slice(-CENTER_MAX));
  if (entry.toast) {
    scheduleDismiss(id, severity);
  }
  report(severity, message);
}

function targetKey(target: TabRef | undefined): string {
  return target ? `${refKeyOf(target.ref)}\u0000${target.tabId}` : "";
}

/** Every notice shown, for `tet-ctl notices-list`. */
function report(severity: NoticeSeverity, message: string): void {
  window.tet.app.reportNotice({ severity, message, at: Date.now() });
}

/**
 * A download's progress, one notice per `key` updated in place: it stands, with a bar along its
 * bottom edge as VS Code's, until the progress ends or a click dismisses its toast. Ended on `done`,
 * it stays in its place as a plain info with its toast anew; ended otherwise, it goes.
 */
export function showProgress({ key, message, fraction, done }: NoticeProgress): void {
  const standing = shown.get().find((notice) => notice.progress?.key === key);
  if (fraction === undefined) {
    if (!standing) {
      if (done) {
        notify("info", message);
      }
    } else if (done) {
      const ended: ShownNotice = { id: standing.id, severity: "info", message, toast: true, read: centerOpen.get() };
      shown.set(shown.get().map((notice) => (notice === standing ? ended : notice)));
      scheduleDismiss(standing.id, "info");
      report("info", message);
    } else {
      leaveNotice(standing.id);
    }
    return;
  }
  if (standing) {
    shown.set(shown.get().map((notice) => (notice === standing ? { ...notice, message, progress: { key, fraction } } : notice)));
    return;
  }
  const entry: ShownNotice = { id: ++nextId, severity: "info", message, toast: true, read: centerOpen.get(), progress: { key, fraction } };
  shown.set([...shown.get(), entry].slice(-CENTER_MAX));
  report("info", message);
}

/**
 * As in VS Code: a notice due while hovered gets its full time again; one due while the window is
 * unfocused waits for focus, then gets its full time.
 */
function scheduleDismiss(id: number, severity: NoticeSeverity): void {
  setTimeout(() => {
    if (!shown.get().some((notice) => notice.id === id && notice.toast)) {
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

/** Takes the toast down with its leaving transition; the notice stays in the notification center. */
function dismissNotice(id: number): void {
  // A removed element never reports the pointer leaving it.
  if (hovered === id) {
    hovered = undefined;
  }
  shown.set(shown.get().map((notice) => (notice.id === id ? { ...notice, dismissing: true } : notice)));
  setTimeout(() => {
    shown.set(shown.get().map((notice) => (notice.id === id ? { ...notice, toast: false, dismissing: undefined } : notice)));
  }, LEAVE_MS);
}

export function removeNotice(id: number): void {
  if (hovered === id) {
    hovered = undefined;
  }
  shown.set(shown.get().filter((notice) => notice.id !== id));
}

/** Removes a notice with its leaving transition; the last one closes the notification center instead. */
export function leaveNotice(id: number): void {
  const last = shown.get().every((notice) => notice.id === id || notice.leaving);
  shown.set(shown.get().map((notice) => (notice.id === id ? { ...notice, leaving: last ? "center" : "item" } : notice)));
  if (last) {
    closeCenter();
  }
  setTimeout(() => removeNotice(id), LEAVE_MS);
}

/**
 * Closing a notice in the notification center clears its tab's finished mark, unless another
 * finished notice of that tab is still listed. A waiting mark stays until the question is answered.
 */
export function closeNotice(id: number): void {
  const notice = shown.get().find((entry) => entry.id === id);
  leaveNotice(id);
  if (notice?.mark === "finished" && notice.target) {
    const { ref, tabId } = notice.target;
    const key = targetKey(notice.target);
    const listed = shown
      .get()
      .some((entry) => entry.id !== id && !entry.leaving && entry.mark === "finished" && targetKey(entry.target) === key);
    if (!listed) {
      window.tet.tabs.seen(ref, tabId);
    }
  }
}

/**
 * A turn's notice (`mark`) lives as long as its tab's mark: gone once the tab is closed, its
 * question answered or its finished turn seen (a tab on screen is, `useTabMarks`).
 */
export function removeStaleNotices(tabs: Record<string, TabDescriptor[]>): void {
  for (const notice of shown.get()) {
    if (!notice.mark || notice.leaving || !notice.target) {
      continue;
    }
    const { ref, tabId } = notice.target;
    const tab = tabs[refKeyOf(ref)]?.find((entry) => entry.tabId === tabId);
    if ((notice.mark === "finished" ? tab?.finishedAt : tab?.waitingAt) === undefined) {
      leaveNotice(notice.id);
    }
  }
}

export function clearNotices(): void {
  for (const { mark, target } of shown.get()) {
    if (mark === "finished" && target) {
      window.tet.tabs.seen(target.ref, target.tabId);
    }
  }
  hovered = undefined;
  // The center fades out whole, the notices in it; one arriving meanwhile stays.
  const cleared = new Set(shown.get().map((notice) => notice.id));
  closeCenter(() => shown.set(shown.get().filter((notice) => !cleared.has(notice.id))));
}

/** A notice's icon, message and progress bar, in a toast and in the notification center alike. */
export function NoticeBody({ notice }: { notice: ShownNotice }) {
  return (
    <>
      {notice.mark ? (
        <TabMark kind={notice.mark} className="notice-icon" />
      ) : (
        <SeverityIcon className="notice-icon" severity={notice.severity} />
      )}
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
    </>
  );
}

/**
 * Stacked in the bottom right corner, newest at the bottom, dismissed by a click. Inside the dialog
 * on top while one is up (`useTopDialog`): outside it they would lie under its dim, inert. None
 * while the notification center is open, which lists them.
 */
export function Notices() {
  const notices = useStore(shown).filter((notice) => notice.toast);
  const open = useStore(centerOpen);
  const dialog = useTopDialog();
  if (notices.length === 0 || open) {
    return null;
  }
  const stack = (
    <div className="notices">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice-item${notice.leaving || notice.dismissing ? " leaving" : ""}`}>
          <button
            className={`notice ${notice.severity}`}
            onClick={() => dismissNotice(notice.id)}
            onMouseEnter={() => (hovered = notice.id)}
            onMouseLeave={() => (hovered = undefined)}
            title="Dismiss"
          >
            <NoticeBody notice={notice} />
          </button>
        </div>
      ))}
    </div>
  );
  return dialog ? createPortal(stack, dialog) : stack;
}
