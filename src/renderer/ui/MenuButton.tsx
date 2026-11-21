import { useImperativeHandle, type ReactNode, type Ref, type RefObject } from "react";
import { useAnchoredMenu, type ContextMenuEntry } from "./ContextMenu";
import { listMaxHeight } from "./Dropdown";

export interface MenuButtonHandle {
  /** Closes the list, for a caller that takes a choice by its own means (Enter in a filter field). */
  close: () => void;
}

interface MenuButtonProps {
  /** The button's, with `open` beside it while the list is up. */
  className: string;
  title?: string;
  entries: ContextMenuEntry[];
  /** Appended to "context-menu" for the list's own look. */
  menuClassName: string;
  /** Caps the list's width in px: longer labels end in an ellipsis. */
  maxWidth?: number;
  /** Stays at the top while the entries scroll, e.g. a filter field. */
  header?: ReactNode;
  /** A press on the button, as the list opens. */
  onOpen?: () => void;
  /** The box drawn around the button, which the list lines up with instead of the button. */
  alignTo?: RefObject<HTMLElement | null>;
  ref?: Ref<MenuButtonHandle>;
  /** What the button shows. */
  children: ReactNode;
}

/** A button of the caller's own look and the list it opens below it, ending at the button's right
 *  edge where the window has no room to its right: every list opened from a section's icon. */
export function MenuButton({
  className,
  title,
  entries,
  menuClassName,
  maxWidth,
  header,
  onOpen,
  alignTo,
  ref,
  children,
}: MenuButtonProps) {
  const menu = useAnchoredMenu((rect) => {
    const box = alignTo?.current?.getBoundingClientRect() ?? rect;
    return {
      maxWidth,
      x: box.left,
      y: box.bottom,
      flipX: box.right,
      maxHeight: listMaxHeight(box),
    };
  });
  useImperativeHandle(ref, () => ({ close: menu.close }));
  return (
    <>
      <button
        type="button"
        className={menu.isOpen ? `${className} open` : className}
        title={title}
        onMouseDown={(event) => {
          menu.open(event);
          onOpen?.();
        }}
      >
        {children}
      </button>
      {menu.render(() => entries, menuClassName, header)}
    </>
  );
}
