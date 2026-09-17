import { CloseIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { useCoversWindow } from "./window-covered";

export interface DialogTab<T extends string> {
  id: T;
  label: string;
  /** Given, the tab cannot be chosen and says why on hover. */
  disabled?: string;
}

/**
 * What heads the dialog, one of two shapes: a title bar, optionally with a close button, or a tab
 * strip in place of the title for a dialog with several panes.
 */
export type DialogHeader<T extends string> =
  | {
      title: string;
      /** Left out for a dialog that must stay up (RequirementsDialog). */
      onClose?: () => void;
    }
  | {
      tabs: readonly DialogTab<T>[];
      active: T;
      onSelect: (id: T) => void;
      /** Close button at the tab strip's right edge. */
      onClose?: () => void;
    };

interface DialogFrameProps<T extends string> {
  header: DialogHeader<T>;
  /** Draws the header's progress bar, the dialog's one indicator. */
  busy?: boolean;
  /** Variants on `.dialog`: `wide`, or the dialog's own class. */
  className?: string;
  /**
   * Given, the card is a form and Enter submits from anywhere in it. A caller not ready checks
   * that itself; the frame only prevents the browser's own submit.
   */
  onSubmit?: () => void;
  /** The button row, the suggested button last. */
  buttons: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The shell of every card dialog — the questions in `Dialog.tsx` and everything under `dialogs/`:
 * overlay, card, header, body, button row.
 *
 * Escape is the caller's: a question listens on `window`, the others on `document` (`useEscape`),
 * RequirementsDialog on neither. While one is up, no tab is in front (`window-covered.ts`).
 */
export function DialogFrame<T extends string>({ header, busy, className, onSubmit, buttons, children }: DialogFrameProps<T>) {
  useCoversWindow();
  const cardClass = className ? `dialog ${className}` : "dialog";
  const content = (
    <>
      {"tabs" in header ? (
        <div className="dialog-tabs">
          {header.tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              // The context menu's disabled entry, not the attribute: chromium swallows a
              // disabled control's tooltip, and the reason is the point.
              className={`dialog-tab${header.active === entry.id ? " active" : ""}${entry.disabled ? " disabled" : ""}`}
              title={entry.disabled}
              onClick={() => {
                if (!entry.disabled) {
                  header.onSelect(entry.id);
                }
              }}
            >
              {entry.label}
            </button>
          ))}
          {header.onClose && (
            <button type="button" className="icon-button dialog-tabs-close" title="Close" onClick={header.onClose}>
              <CloseIcon />
            </button>
          )}
          {busy && <ProgressBar />}
        </div>
      ) : (
        <div className="dialog-bar">
          <span className="dialog-title">{header.title}</span>
          {header.onClose && (
            <button type="button" className="icon-button" title="Close" onClick={header.onClose}>
              <CloseIcon />
            </button>
          )}
          {busy && <ProgressBar />}
        </div>
      )}
      <div className="dialog-body">{children}</div>
      <div className="dialog-buttons">{buttons}</div>
    </>
  );
  return (
    <div className="dialog-overlay">
      {onSubmit ? (
        <form
          className={cardClass}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {content}
        </form>
      ) : (
        <div className={cardClass}>{content}</div>
      )}
    </div>
  );
}
