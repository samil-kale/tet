import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronIcon } from "./icons";
import { useEscape } from "./use-escape";
import { useLatest } from "./use-latest";

/** One entry of a context menu; an action with neither `run` nor `entries` renders disabled. */
interface ContextMenuAction {
  label: string;
  /** Leads the label, e.g. an agent's icon in the new-tab menu. */
  icon?: ReactNode;
  run?: () => void;
  /** A submenu, opened on hover or click, in place of a `run`. */
  entries?: ContextMenuEntry[];
}

/** Divides the menu's action groups. */
export const SEPARATOR = "separator";

export type ContextMenuEntry = ContextMenuAction | typeof SEPARATOR;

/** How long the pointer rests on an entry before its submenu opens or another one closes, so a
 *  pointer crossing entries on its way into an open submenu leaves it open (VS Code's delay). */
const SUBMENU_DELAY_MS = 250;
/** The menu's top padding and border: a submenu's first entry lines up with its parent entry. */
const SUBMENU_OFFSET = 5;

interface ContextMenuProps {
  /** Where the pointer was; the menu is clamped to the window from there. */
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  onClose: () => void;
  /** Appended to "context-menu" for a caller's own look. */
  className?: string;
  /** Matches a trigger's width, e.g. `Dropdown` standing in for a `<select>`. */
  width?: number;
  /** Caps the height, which then scrolls; kept within the window, it is never clamped upward. */
  maxHeight?: number;
  /** A submenu's: its parent entry's left edge, which it ends at when the window has no room right
   *  of `x`. */
  flipX?: number;
  /** The button a menu was opened from: a press on it is no press outside, its own handler closes
   *  the menu. */
  anchor?: HTMLElement;
}

/**
 * A menu opened at the pointer on one of a view's rows: `open` from the row's `onContextMenu`, with
 * what it was opened on; `render` where the menu goes, with the entries for that. `open` and `close`
 * are stable, for memoized rows.
 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<{ x: number; y: number; target: T } | null>(null);
  const open = useCallback((event: React.MouseEvent, target: T): void => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, target });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  const render = (entries: (target: T) => ContextMenuEntry[]): ReactNode =>
    menu && <ContextMenu x={menu.x} y={menu.y} entries={entries(menu.target)} onClose={close} />;
  return { open, close, render, target: menu?.target };
}

/** Where a menu opened from a button goes, worked out from the button's box. */
type AnchoredPlace = Pick<ContextMenuProps, "x" | "y" | "width" | "maxHeight">;

/**
 * A menu opened from a button: `open` as the button's `onMouseDown`, `place` saying where from its
 * box; `render` where the menu goes, with its entries. A press on the button while the menu is up
 * closes it.
 */
export function useAnchoredMenu(place: (anchor: DOMRect) => AnchoredPlace) {
  const [menu, setMenu] = useState<(AnchoredPlace & { anchor: HTMLElement }) | null>(null);
  const open = (event: React.MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
    const anchor = event.currentTarget;
    setMenu((current) => (current ? null : { ...place(anchor.getBoundingClientRect()), anchor }));
  };
  const close = useCallback(() => setMenu(null), []);
  const render = (entries: () => ContextMenuEntry[], className: string): ReactNode =>
    menu && <ContextMenu {...menu} entries={entries()} onClose={close} className={className} />;
  return { open, render, isOpen: menu !== null };
}

export function ContextMenu({ x, y, entries, onClose, className, width, maxHeight, flipX, anchor }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clamped into the window, written to the node rather than state so nothing paints unclamped.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) {
      return;
    }
    const { width: menuWidth, height } = element.getBoundingClientRect();
    const left = flipX !== undefined && x + menuWidth > window.innerWidth ? flipX - menuWidth : x;
    element.style.left = `${Math.max(0, Math.min(left, window.innerWidth - menuWidth))}px`;
    element.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;
  }, [x, y, flipX]);

  // Opened last, so over a dialog a `Dropdown` sits in: Escape closes the menu alone.
  useEscape(onClose);
  // Callers pass inline arrows, and the listeners must not re-attach on every parent render.
  const close = useLatest(onClose);

  useEffect(() => {
    const closeMenu = (): void => close.current();
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !anchor?.contains(target)) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("blur", closeMenu);
    // Anchored to pointer coordinates, so after a resize it points at nothing.
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [close, anchor]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const openSubmenu = (index: number, item: HTMLElement): void => {
    const rect = item.getBoundingClientRect();
    setSubmenu({ index, x: rect.right, y: rect.top - SUBMENU_OFFSET, flipX: rect.left });
  };

  // Hovering an entry opens its submenu, or closes another's, once the pointer rests there.
  const hover = (index: number, entry: ContextMenuAction, item: HTMLElement): void => {
    clearTimeout(hoverTimer.current);
    if (!entry.entries?.length && submenu === null) {
      return;
    }
    hoverTimer.current = setTimeout(() => {
      if (entry.entries?.length) {
        openSubmenu(index, item);
      } else {
        setSubmenu(null);
      }
    }, SUBMENU_DELAY_MS);
  };

  const opened = submenu && entries[submenu.index];

  return (
    <div ref={menu} className={`context-menu${className ? ` ${className}` : ""}`} style={{ left: x, top: y, width, maxHeight }}>
      {entries.map((entry, index) =>
        entry === SEPARATOR ? (
          <div key={index} className="context-menu-separator" />
        ) : (
          <div
            key={index}
            className={`context-menu-item${entry.run || entry.entries?.length ? "" : " disabled"}${submenu?.index === index ? " open" : ""}`}
            onMouseEnter={(event) => hover(index, entry, event.currentTarget)}
            onClick={(event) => {
              if (entry.entries?.length) {
                clearTimeout(hoverTimer.current);
                openSubmenu(index, event.currentTarget);
              } else if (entry.run) {
                onClose();
                entry.run();
              }
            }}
          >
            {entry.icon}
            {entry.label}
            {entry.entries?.length ? <ChevronIcon expanded={false} className="context-menu-chevron" /> : null}
          </div>
        ),
      )}
      {submenu && opened !== SEPARATOR && opened?.entries && (
        // Inside this menu's node, so a click in it is no click outside; the pointer reaching it
        // keeps a pending hover elsewhere from closing it.
        <div onMouseEnter={() => clearTimeout(hoverTimer.current)}>
          <ContextMenu
            x={submenu.x}
            y={submenu.y}
            flipX={submenu.flipX}
            // Escape or a click elsewhere closes the submenu alone; a choice in it closes both.
            onClose={() => setSubmenu(null)}
            entries={opened.entries.map((child) =>
              child === SEPARATOR || !child.run
                ? child
                : {
                    ...child,
                    run: () => {
                      onClose();
                      child.run?.();
                    },
                  },
            )}
          />
        </div>
      )}
    </div>
  );
}
