import { memo, useRef } from "react";
import type { ProjectRef } from "../../shared/types/project";
import { ClearIcon, CloseIcon } from "./icons";
import {
  centerOrder,
  clearNotices,
  closeCenter,
  enteredOpenCenter,
  leaveNotice,
  NoticeBody,
  noticeClass,
  removable,
  useCenterClosing,
  useCenterOpen,
  useNoticeList,
} from "./Notices";
import { usePressOutside } from "./use-press-outside";

interface NoticesCenterProps {
  /** Shows the tab a notice is about. */
  onShowTab: (ref: ProjectRef, tabId: string) => void;
}

/**
 * VS Code's notification center, opened by the status bar's button: every notice since it was last
 * cleared, toasts and desktop notifications alike, those that follow their tab's state first
 * (`centerOrder`), else newest first. A click on one with a tab shows the tab; the X removes it,
 * except one that follows its tab (`removable`). Closed by that button, its own X or a press
 * outside it.
 */
export const NoticesCenter = memo(function NoticesCenter({ onShowTab }: NoticesCenterProps) {
  const open = useCenterOpen();
  const closing = useCenterClosing();
  const notices = useNoticeList();
  const center = useRef<HTMLDivElement>(null);

  usePressOutside(center, "status-bar-notices", closeCenter, open);

  if (!open) {
    return null;
  }
  return (
    <div ref={center} className={`notices-center${closing ? " closing" : ""}`}>
      <div className="section-header popup-header">
        <span className="section-title">NOTIFICATIONS</span>
        <span className="toolbar">
          <button type="button" className="icon-button" title="Clear All" disabled={!notices.some(removable)} onClick={clearNotices}>
            <ClearIcon />
          </button>
          <button type="button" className="icon-button" title="Hide Notifications" onClick={() => closeCenter()}>
            <CloseIcon />
          </button>
        </span>
      </div>
      <div className="popup-items">
        {notices.length === 0 && <div className="popup-empty">No new notifications</div>}
        {centerOrder(notices).map((notice) => {
          const { target } = notice;
          return (
            <div
              key={notice.id}
              className={`notice-item${notice.leaving === "item" ? " leaving" : ""}${enteredOpenCenter(notice) ? " entering" : ""}`}
            >
              <div
                className={`${noticeClass(notice)}${target ? " clickable" : ""}`}
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
                {removable(notice) && (
                  <button
                    type="button"
                    className="icon-button"
                    title="Remove"
                    onClick={(event) => {
                      event.stopPropagation();
                      leaveNotice(notice.id);
                    }}
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
