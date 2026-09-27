import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useEscape } from "./use-escape";
import { useLatest } from "./use-latest";

/** One entry of a context menu; an action without a `run` renders disabled. */
interface ContextMenuAction {
  label: string;
  /** Leads the label, e.g. an agent's icon in the new-session menu. */
  icon?: ReactNode;
  run?: () => void;
}

/** Divides the menu's action groups. */
export const SEPARATOR = "separator";

export type ContextMenuEntry = ContextMenuAction | typeof SEPARATOR;

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

export function ContextMenu({ x, y, entries, onClose, className, width, maxHeight }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);

  // Clamped into the window, written to the node rather than state so nothing paints unclamped.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
    element.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;
  }, [x, y]);

  // Opened last, so over a dialog a `Dropdown` sits in: Escape closes the menu alone.
  useEscape(onClose);
  // Callers pass inline arrows, and the listeners must not re-attach on every parent render.
  const close = useLatest(onClose);

  useEffect(() => {
    const onClose = (): void => close.current();
    const onMouseDown = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("blur", onClose);
    // Anchored to pointer coordinates, so after a resize it points at nothing.
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [close]);

  return (
    <div
      ref={menu}
      className={`context-menu${className ? ` ${className}` : ""}`}
      style={{
        left: x,
        top: y,
        ...(width !== undefined ? { width } : {}),
        ...(maxHeight !== undefined ? { maxHeight } : {})
      }}
    >
      {entries.map((entry, index) =>
        entry === SEPARATOR ? (
          <div key={index} className="context-menu-separator" />
        ) : (
          <div
            key={index}
            className={`context-menu-item${entry.run ? "" : " disabled"}`}
            onClick={() => {
              if (entry.run) {
                onClose();
                entry.run();
              }
            }}
          >
            {entry.icon}
            {entry.label}
          </div>
        )
      )}
    </div>
  );
}
