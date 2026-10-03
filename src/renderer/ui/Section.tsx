import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";
import { ProgressBar } from "./ProgressBar";

interface SectionProps {
  title: string;
  /** Beside the title in parentheses, dimmed; left out while there is nothing to count yet. */
  count?: ReactNode;
  /** The count says something went wrong instead (a SEARCH regex that will not parse). */
  countError?: boolean;
  /** Draws the section's one progress bar along the header's bottom edge. */
  busy?: boolean;
  /** Given, the sash beside it sizes the section; left out, it takes the rest of the column. */
  height?: number;
  /** The section's icon buttons, at the header's right edge. */
  actions?: ReactNode;
  children: ReactNode;
}

/** What drags the column a section stands in by its header, where it can be dragged (a pinned
 *  side column's `handleProps`). */
export const SectionHandle = createContext<HTMLAttributes<HTMLElement> | undefined>(undefined);

/**
 * A titled section of a column — the sidebar's, the git view's, the files view's: a header with its
 * title, count and actions, then what it holds, a filter field included where it has one.
 */
export function Section({ title, count, countError, busy, height, actions, children }: SectionProps) {
  const handle = useContext(SectionHandle);
  return (
    <div className={`section${height === undefined ? " grows" : ""}`} style={height === undefined ? undefined : { height }}>
      <div className="section-header" {...handle}>
        <span className="section-title">
          {title}
          {count !== undefined && (
            <>
              {" "}
              <span className={`count-badge${countError ? " error" : ""}`}>({count})</span>
            </>
          )}
        </span>
        {actions && <span className="section-header-actions">{actions}</span>}
        {busy && <ProgressBar />}
      </div>
      {children}
    </div>
  );
}
