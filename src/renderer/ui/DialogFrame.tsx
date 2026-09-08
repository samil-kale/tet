import { CloseIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";

export interface DialogTab<T extends string> {
  id: T;
  label: string;
}

/**
 * What heads the dialog — one of two shapes, nothing else. A title bar names one thing and may
 * carry a close button; a tab strip stands in for the title where the dialog has more than one
 * pane (the selected tab names what is below it, and the button that opened the dialog already
 * said what it is).
 */
export type DialogHeader<T extends string> =
  | {
      title: string;
      /** The bar's close button; left out for a dialog that must stay up (RequirementsDialog). */
      onClose?: () => void;
    }
  | {
      tabs: readonly DialogTab<T>[];
      active: T;
      onSelect: (id: T) => void;
    };

interface DialogFrameProps<T extends string> {
  header: DialogHeader<T>;
  /** Draws the header's progress bar — the dialog's one indicator, as with any other pane. */
  busy?: boolean;
  /** Variants on `.dialog` — `wide`, or the dialog's own class for its rules alone. */
  className?: string;
  /**
   * Given, the card is a form and Enter submits from wherever the focus sits — a field, a
   * checkbox. A caller that isn't ready yet checks that inside; the frame only prevents the
   * browser's own submit.
   */
  onSubmit?: () => void;
  /** What goes in the button row, the one being suggested last. */
  buttons: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The one shell every card dialog is drawn in: the overlay, the card, a header of one of the two
 * shapes above, the body, the button row. The questions in `Dialog.tsx` and every dialog under
 * `dialogs/` use it, so a header, a body gap or a button row can't drift between them. Not the
 * diff dialog, which is a whole-window surface with its own bar rather than a card.
 *
 * Escape is the caller's: a question listens on `window`, the others on `document`
 * (`useEscape`), and RequirementsDialog takes none at all.
 */
export function DialogFrame<T extends string>({ header, busy, className, onSubmit, buttons, children }: DialogFrameProps<T>) {
  const cardClass = className ? `dialog ${className}` : "dialog";
  const content = (
    <>
      {"tabs" in header ? (
        <div className="dialog-tabs">
          {header.tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={header.active === entry.id ? "dialog-tab active" : "dialog-tab"}
              onClick={() => header.onSelect(entry.id)}
            >
              {entry.label}
            </button>
          ))}
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
