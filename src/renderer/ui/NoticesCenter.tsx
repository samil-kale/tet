import { memo, useRef } from "react";
import { ClearIcon, CloseIcon } from "./icons";
import {
  centerOrder,
  clearNotices,
  closeCenter,
  enteredOpenCenter,
  leaveNotice,
  NoticeBody,
  noticeClass,
  noticeOpen,
  removable,
  useCenterClosing,
  useCenterOpen,
  useNoticeList,
  type NoticeOpeners,
} from "./Notices";
import { usePressOutside } from "./use-press-outside";

/**
 * VS Code's notification center, opened by the status bar's button: every notice since it was last
 * cleared, toasts and desktop notifications alike, those that follow their tab's state first
 * (`centerOrder`), else newest first. A click on one with a tab shows the tab, on one about an issue
 * or change request opens its tab (`noticeOpen`); the X removes it,
 * except one that follows its tab (`removable`). Closed by that button, its own X or a press
 * outside it.
 */
export const NoticesCenter = memo(function NoticesCenter(openers: NoticeOpeners) {
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
      <div className="section-header">
        <span className="section-title">Notifications</span>
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
          const open = noticeOpen(notice, openers);
          return (
            <div
              key={notice.id}
              className={`notice-item${notice.leaving === "item" ? " leaving" : ""}${enteredOpenCenter(notice) ? " entering" : ""}`}
            >
              <div
                className={`${noticeClass(notice)}${open ? " clickable" : ""}`}
                onClick={
                  open
                    ? () => {
                        closeCenter();
                        open();
                      }
                    : undefined
                }
              >
                <NoticeBody notice={notice}>
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
                </NoticeBody>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
