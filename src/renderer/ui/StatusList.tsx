import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAnchoredMenu, type ContextMenuEntry } from "./ContextMenu";
import { CloseIcon, PlusIcon } from "./icons";
import { usePressOutside } from "./use-press-outside";

/** The gap to the window's edge, as the lists' `left` in styles.css. */
const EDGE = 6;

/** One entry of a status bar list: a project, a tab, a branch, an archived session. */
export interface StatusListItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** When it was last active, ms since epoch, where a list sorts by it (`newestFirst`). */
  lastActive?: number;
}

/** Newest first; those without a time last, in the order they came. */
export function newestFirst(items: StatusListItem[]): StatusListItem[] {
  return [...items].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
}

interface StatusListProps {
  /** Its header, as the status bar's button names it: "Tabs". */
  title: string;
  items: StatusListItem[];
  /** The entry that is open now; absent while none is. */
  activeId: string | undefined;
  /** The class of the status bar button that opens it, which toggles it itself. */
  trigger: string;
  /** A click on an entry; the list closes. */
  onSelect: (id: string) => void;
  /** Fading out, gone once it has. */
  closing: boolean;
  onClose: () => void;
  /** The tabs' list alone: the menu of its header's plus. */
  newTabEntries?: () => ContextMenuEntry[];
  /** The projects' list alone: a click on its header's plus. */
  onAddRepository?: () => void;
  /** What it says while it has no entries. */
  emptyText?: string;
  /** Lists its entries `newestFirst` as it opens, not in the order they come. */
  sorted?: boolean;
}

/**
 * The status bar's lists (projects, tabs, branches, archive), laid out as the notification center is
 * (`NoticesCenter`): above the bar, over the button that opens it. Closed by the status bar's button,
 * its own X or a press outside it.
 */
export const StatusList = memo(function StatusList({
  title,
  items,
  activeId,
  trigger,
  onSelect,
  closing,
  onClose,
  newTabEntries,
  onAddRepository,
  emptyText,
  sorted,
}: StatusListProps) {
  const list = useRef<HTMLDivElement>(null);
  // Once, as it opens, so a row never moves under the pointer; one added since comes first.
  const [openedOrder] = useState(() => newestFirst(items).map((item) => item.id));
  const rows = sorted ? [...items].sort((a, b) => openedOrder.indexOf(a.id) - openedOrder.indexOf(b.id)) : items;
  // Above the list, which stands right over the status bar and leaves no room below its header.
  const plusMenu = useAnchoredMenu((rect) => ({
    x: rect.left,
    y: (list.current?.getBoundingClientRect().top ?? rect.top) - 2,
    above: true,
  }));

  // It opens above the button that opens it, kept inside the window.
  useLayoutEffect(() => {
    const element = list.current;
    const button = document.querySelector(`.${trigger}`);
    if (!element || !button) {
      return;
    }
    const origin = element.offsetParent?.getBoundingClientRect().left ?? 0;
    const room = window.innerWidth - element.offsetWidth - EDGE;
    element.style.left = `${Math.max(EDGE, Math.min(button.getBoundingClientRect().left, room)) - origin}px`;
  }, [trigger]);

  usePressOutside(list, trigger, onClose);

  return (
    <div ref={list} className={`status-list${closing ? " closing" : ""}`}>
      <div className="section-header popup-header">
        <span className="section-title">{title.toUpperCase()}</span>
        <span className="toolbar">
          {newTabEntries && (
            <button type="button" className="icon-button" title="New tab" onMouseDown={plusMenu.open}>
              <PlusIcon />
            </button>
          )}
          {onAddRepository && (
            <button type="button" className="icon-button" title="Add repository" onClick={onAddRepository}>
              <PlusIcon />
            </button>
          )}
          <button type="button" className="icon-button" title={`Hide ${title}`} onClick={onClose}>
            <CloseIcon />
          </button>
        </span>
      </div>
      <div className="popup-items">
        {items.length === 0 && emptyText && <div className="popup-empty">{emptyText}</div>}
        {rows.map((item) => (
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
      {/* Inside the list's node, so a press in the menu is no press outside it. */}
      {newTabEntries && plusMenu.render(newTabEntries, "new-tab-menu")}
    </div>
  );
});
