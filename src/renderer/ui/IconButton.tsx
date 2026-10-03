import type { HTMLAttributes, ReactNode } from "react";

/**
 * An action as an icon (`.icon-button`), its `title` the words. `active` marks a toggle that is on;
 * `isolated` keeps the click from the row it sits in, which acts on a click of its own (selects,
 * activates). Anything else, a drag's handlers say, goes onto the button as it is.
 */
export function IconButton({
  title,
  onClick,
  disabled,
  active,
  isolated,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLButtonElement>, "onClick"> & {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  isolated?: boolean;
  /** Beside `icon-button`, for a caller's own placement. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={["icon-button", active && "active", className].filter(Boolean).join(" ")}
      title={title}
      disabled={disabled}
      {...rest}
      onClick={(event) => {
        if (isolated) {
          event.stopPropagation();
        }
        onClick();
      }}
    >
      {children}
    </button>
  );
}
