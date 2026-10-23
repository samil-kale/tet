import { memo, useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

/** One tab of the active repository or worktree, as the list names it. */
export interface StatusSession {
  tabId: string;
  label: string;
  icon: ReactNode;
}

interface SessionsCenterProps {
  sessions: StatusSession[];
  /** The tab the focused pane shows; absent while it has none. */
  activeSessionId: string | undefined;
  /** A click shows the tab; the list closes. */
  onSelect: (tabId: string) => void;
  onClose: () => void;
}

/**
 * The status bar's list of sessions, laid out as the notification center is (`NoticesCenter`): over
 * the left edge, above the bar, the active repository's or worktree's tabs in the strip's order. A
 * click on one shows it. Closed by the status bar's button, its own X or a press outside it.
 */
export const SessionsCenter = memo(function SessionsCenter({ sessions, activeSessionId, onSelect, onClose }: SessionsCenterProps) {
  const center = useRef<HTMLDivElement>(null);

  // A press outside closes it; the status bar's button toggles it itself.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element;
      if (!center.current?.contains(target) && !target.closest(".status-bar-sessions")) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [onClose]);

  return (
    <div ref={center} className="sessions-center">
      <div className="section-header sessions-center-header">
        <span className="section-title">SESSIONS</span>
        <span className="section-header-actions">
          <button type="button" className="icon-button" title="Hide Sessions" onClick={onClose}>
            <CloseIcon />
          </button>
        </span>
      </div>
      <div className="sessions-center-list">
        {sessions.map((session) => (
          <div
            key={session.tabId}
            className={`sessions-center-item${session.tabId === activeSessionId ? " active" : ""}`}
            onClick={() => {
              onClose();
              onSelect(session.tabId);
            }}
          >
            {session.icon}
            <span className="sessions-center-label">{session.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
