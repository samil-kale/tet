import { useLayoutEffect, useRef, useState } from "react";
import { DialogError } from "./Field";
import { IconButton } from "./IconButton";
import { CircleAlertIcon, CloseIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { useEscape } from "./use-escape";
import { useRunning } from "./use-running";
import { useCoversWindow } from "./window-covered";

/**
 * A dialog's answer as it runs (`PromptOptions.submit`): `run` answers what refused it, or nothing
 * once it went through, and `onDone` follows (closing the dialog). `busy` is the frame's bar
 * meanwhile; `refused` is the frame's `error` (or a field's), held so what was typed can be
 * corrected, and cleared by the next change — which is about to make it wrong: every edit goes
 * through a setter wrapped in `changing`. The one rule for every dialog, question and card alike.
 */
export function useSubmit(
  run: () => Promise<string | undefined>,
  onDone?: () => void
): {
  busy: boolean;
  refused: string | undefined;
  submit: () => Promise<void>;
  changing: <A extends unknown[]>(set: (...args: A) => void) => (...args: A) => void;
} {
  const { running: busy, run: holdBusy } = useRunning();
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const submit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setRefused(undefined);
    const message = await holdBusy(run);
    if (message === undefined) {
      onDone?.();
    } else {
      setRefused(message);
    }
  };
  const changing =
    <A extends unknown[]>(set: (...args: A) => void) =>
    (...args: A): void => {
      set(...args);
      setRefused(undefined);
    };
  return { busy, refused, submit, changing };
}

/** A card dialog's cancel for ×, its Cancel button and Escape alike: nothing while `locked` (the
 *  frame's), so what runs finishes before the dialog goes. What runs and may be cut short instead
 *  is `abort`ed first (the SBX dialog's setup, a suggested commit message). */
export function useCancel(cancel: () => void, locked: boolean, abort?: () => void): () => void {
  const guarded = (): void => {
    if (!locked) {
      abort?.();
      cancel();
    }
  };
  useEscape(guarded);
  return guarded;
}

/** A card dialog's Save, `blocked` by why it cannot go yet: by class, not `disabled`, so that reason
 *  shows as its tooltip (.button.disabled). `disabled` while something runs. */
export function SaveButton({ blocked, disabled, onSave }: { blocked: string | undefined; disabled: boolean; onSave: () => void }) {
  return (
    <button
      type="button"
      className={blocked === undefined ? "button" : "button disabled"}
      disabled={disabled}
      title={blocked}
      onClick={() => blocked === undefined && onSave()}
    >
      Save
    </button>
  );
}

interface DialogTab<T extends string> {
  id: T;
  label: string;
  /** Given, the tab cannot be chosen and says why on hover. */
  disabled?: string;
  /** Given, something in the pane needs a look: an error mark beside the label, saying what. */
  mark?: string;
}

/**
 * What heads the dialog, one of two shapes: a title bar, optionally with a close button, or a tab
 * strip in place of the title for a dialog with several panes.
 */
type DialogHeader<T extends string> =
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
  /** × is disabled while it holds, and the caller's Cancel and Escape with it. Defaults to `busy`:
   *  what runs finishes before the dialog goes, unless it is aborted (`useCancel`). */
  locked?: boolean;
  /** What refused the dialog's Save, on the button row's left (`DialogError`): for a card whose
   *  fields — several, or across tabs — no one of them can be blamed. A field that can writes it
   *  itself, under the control (`Field`). Shown in `message`'s place while it stands. */
  error?: string;
  /** Beside the buttons, on the row's left: what the dialog says about its unsaved edits as a whole
   *  (`RestartNote`), never a failure — that is `error`. */
  message?: React.ReactNode;
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
 * Escape is the caller's (`useCancel`), RequirementsDialog's none. While one is up, no tab is in front (`window-covered.ts`).
 *
 * A modal `<dialog>`: the rest of the window is inert, so Tab cannot leave for the terminal or the
 * editor behind, and a question over another dialog is the one on top. `closedby="none"`, since
 * Escape stays the caller's.
 */
export function DialogFrame<T extends string>({
  header,
  busy,
  locked = busy,
  error,
  message,
  className,
  onSubmit,
  buttons,
  children
}: DialogFrameProps<T>) {
  const overlay = useRef<HTMLDialogElement>(null);
  useCoversWindow(overlay);
  // What had focus before the dialog (the terminal, a field of the dialog below), read at the first
  // render: a child's `autoFocus` takes it before any effect runs. Handed back on unmount.
  const [opener] = useState(() => document.activeElement);
  // A layout effect, before a child's effect focuses its field. showModal focuses the first
  // focusable (the close button), so a child focused through `autoFocus` gets it back.
  useLayoutEffect(() => {
    const dialog = overlay.current;
    if (!dialog) {
      return;
    }
    const focused = document.activeElement;
    dialog.showModal();
    if (focused instanceof HTMLElement && dialog.contains(focused)) {
      focused.focus();
    }
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement) {
        opener.focus();
      }
    };
  }, [opener]);
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
              title={entry.disabled ?? entry.mark}
              onClick={() => {
                if (!entry.disabled) {
                  header.onSelect(entry.id);
                }
              }}
            >
              {entry.label}
              {entry.mark && (
                <span className="dialog-tab-mark">
                  <CircleAlertIcon />
                </span>
              )}
            </button>
          ))}
          {header.onClose && (
            <IconButton className="dialog-tabs-close" title="Close" disabled={locked} onClick={header.onClose}>
              <CloseIcon />
            </IconButton>
          )}
          {busy && <ProgressBar />}
        </div>
      ) : (
        <div className="dialog-bar">
          <span className="dialog-title">{header.title}</span>
          {header.onClose && (
            <IconButton title="Close" disabled={locked} onClick={header.onClose}>
              <CloseIcon />
            </IconButton>
          )}
          {busy && <ProgressBar />}
        </div>
      )}
      <div className="dialog-body">{children}</div>
      <div className="dialog-buttons">
        {error !== undefined ? (
          <div className="dialog-buttons-message">
            <DialogError message={error} />
          </div>
        ) : (
          message && <div className="dialog-buttons-message">{message}</div>
        )}
        {buttons}
      </div>
    </>
  );
  return (
    <dialog ref={overlay} className="dialog-overlay" closedby="none">
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
    </dialog>
  );
}
