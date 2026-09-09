import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/** One entry of a context menu; an action without a `run` renders disabled. */
export interface ContextMenuAction {
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
  /** Appended to "context-menu", for a caller that needs its own look on top of the shared one. */
  className?: string;
  /** Matches the menu to a trigger's own width, e.g. `Dropdown` standing in for a `<select>`. */
  width?: number;
}

export function ContextMenu({ x, y, entries, onClose, className, width }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);

  // Anchored at the pointer, then clamped so a menu opened near an edge doesn't hang outside the
  // window. Written to the node rather than held in state: no first paint at the unclamped spot.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
    element.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;
  }, [x, y]);

  // Held in a ref: callers pass an inline arrow, and the listeners below must not be re-attached
  // on every parent render (a repository or tab push while the menu stands).
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onClose = (): void => close.current();
    const onMouseDown = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Capture phase and swallowed here, so dismissing the menu can't double as an ESC
        // keystroke for the (still focused) terminal's CLI.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    // Anchored to raw pointer coordinates, not a moving element, so a resize leaves it pointing
    // at nothing.
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, []);

  return (
    <div
      ref={menu}
      className={`context-menu${className ? ` ${className}` : ""}`}
      style={{ left: x, top: y, ...(width !== undefined ? { width } : {}) }}
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
