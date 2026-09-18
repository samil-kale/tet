import type { ReactNode } from "react";

interface ActionLinkProps {
  onClick: () => void;
  children: ReactNode;
}

/** An action drawn as a link, in the theme's link color: for a secondary step beside a form. */
export function ActionLink({ onClick, children }: ActionLinkProps) {
  return (
    <button type="button" className="action-link" onClick={onClick}>
      {children}
    </button>
  );
}
