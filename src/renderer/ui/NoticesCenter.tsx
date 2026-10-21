import { memo, useEffect, useRef } from "react";
import type { ProjectRef } from "../../shared/types/project";
import { ClearIcon, CloseIcon } from "./icons";
import { clearNotices, closeCenter, closeNotice, NoticeBody, useCenterClosing, useCenterOpen, useNoticeList } from "./Notices";

interface NoticesCenterProps {
  /** Shows the tab a notice is about. */
  onShowTab: (ref: ProjectRef, tabId: string) => void;
}

/**
 * VS Code's notification center, opened by the status bar's bell: every notice since it was last
 * cleared, newest first, toasts and desktop notifications alike. A click on one with a tab shows
 * the tab; the X removes it. Closed by the bell, its own X or a press outside it.
 */
export const NoticesCenter = memo(function NoticesCenter({ onShowTab }: NoticesCenterProps) {
  const open = useCenterOpen();
  const closing = useCenterClosing();
  const notices = useNoticeList();
  const center = useRef<HTMLDivElement>(null);

  // A press outside closes it; the bell toggles it itself.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element;
      if (!center.current?.contains(target) && !target.closest(".status-bar-bell")) {
        closeCenter();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [open]);

  if (!open) {
    return null;
  }
  return (
    <div ref={center} className={`notices-center${closing ? " closing" : ""}`}>
      <div className="section-header notices-center-header">
        <span className="section-title">NOTIFICATIONS</span>
        <span className="section-header-actions">
          <button type="button" className="icon-button" title="Clear All" disabled={notices.length === 0} onClick={clearNotices}>
            <ClearIcon />
          </button>
          <button type="button" className="icon-button" title="Hide Notifications" onClick={closeCenter}>
            <CloseIcon />
          </button>
        </span>
      </div>
      <div className="notices-center-list">
        {notices.length === 0 && <div className="notices-center-empty">No new notifications</div>}
        {[...notices].reverse().map((notice) => {
          const { target } = notice;
          return (
            <div key={notice.id} className={`notices-center-item${notice.leaving === "item" ? " leaving" : ""}`}>
              <div
                className={`notice ${notice.severity}${target ? " clickable" : ""}`}
                onClick={
                  target
                    ? () => {
                        closeCenter();
                        onShowTab(target.ref, target.tabId);
                      }
                    : undefined
                }
              >
                <NoticeBody notice={notice} />
                <button
                  type="button"
                  className="icon-button"
                  title="Remove"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeNotice(notice.id);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
