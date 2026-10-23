import { memo, useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

/** One entry of a status bar list: a project, a tab, a branch. */
export interface StatusListItem {
  id: string;
  label: string;
  icon: ReactNode;
}

interface StatusListProps {
  /** Its header, as the status bar's button names it: "Sessions". */
  title: string;
  items: StatusListItem[];
  /** The entry that is open now; absent while none is. */
  activeId: string | undefined;
  /** The class of the status bar button that opens it, which toggles it itself. */
  trigger: string;
  /** A click on an entry; the list closes. */
  onSelect: (id: string) => void;
  onClose: () => void;
}

/**
 * The status bar's lists (projects, sessions, branches), laid out as the notification center is
 * (`NoticesCenter`): over the left edge, above the bar. Closed by the status bar's button, its own
 * X or a press outside it.
 */
export const StatusList = memo(function StatusList({ title, items, activeId, trigger, onSelect, onClose }: StatusListProps) {
  const list = useRef<HTMLDivElement>(null);

  // A press outside closes it; the status bar's button toggles it itself.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element;
      if (!list.current?.contains(target) && !target.closest(`.${trigger}`)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [trigger, onClose]);

  return (
    <div ref={list} className="status-list">
      <div className="section-header status-list-header">
        <span className="section-title">{title.toUpperCase()}</span>
        <span className="section-header-actions">
          <button type="button" className="icon-button" title={`Hide ${title}`} onClick={onClose}>
            <CloseIcon />
          </button>
        </span>
      </div>
      <div className="status-list-items">
        {items.map((item) => (
          <div
            key={item.id}
            className={`status-list-item${item.id === activeId ? " active" : ""}`}
            onClick={() => {
              onClose();
              onSelect(item.id);
            }}
          >
            {item.icon}
            <span className="status-list-label">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
