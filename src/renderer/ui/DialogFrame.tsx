import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../../shared/errors";
import { DialogError } from "./Field";
import { IconButton } from "./IconButton";
import { CircleAlertIcon, CloseIcon } from "./icons";
import { ProgressBar } from "./ProgressBar";
import { useEscape } from "./use-escape";
import { useBusy } from "./use-busy";
import { useCoversWindow } from "./window-covered";

/**
 * A dialog's answer as it runs (`PromptOptions.submit`): `run` answers what refused it, or throws
 * it, or nothing once it went through, and `onDone` follows (closing the dialog). `busy` is the
 * frame's bar meanwhile; `refused` is the frame's `error` (or a field's), held so what was typed can be
 * corrected, and cleared by the next change — which is about to make it wrong: every edit goes
 * through a setter wrapped in `changing`. The one rule for every dialog, question and card alike.
 */
export function useSubmit(
  run: () => Promise<string | undefined>,
  onDone?: () => void,
): {
  busy: boolean;
  refused: string | undefined;
  submit: () => Promise<void>;
  changing: <A extends unknown[]>(set: (...args: A) => void) => (...args: A) => void;
} {
  const { busy, run: holdBusy } = useBusy();
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const submit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setRefused(undefined);
    const message = await holdBusy(run).catch((error: unknown) => errorMessage(error));
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

/** A dialog's cancel for ×, its Cancel button and Escape alike (`DialogFrame`'s `onCancel`): nothing
 *  while `locked`, so what runs finishes before the dialog goes. What runs and may be cut short
 *  instead is `abort`ed first (the SBX Settings's setup, a suggested commit message). */
function useCancel(cancel: () => void, locked: boolean, abort?: () => void): () => void {
  const guarded = (): void => {
    if (!locked) {
      abort?.();
      cancel();
    }
  };
  useEscape(guarded);
  return guarded;
}

/** The button a dialog is for — Save, Rename, Clone — last in the row, and what Enter runs. */
export interface DialogPrimary {
  label: string;
  /** Why it cannot go yet: by class, not `disabled`, so that reason shows as its tooltip
   *  (.button.disabled) — for a dialog whose rows say what holds it back. */
  blocked?: string;
  /** Not ready, and plain to see why — an empty name, a value left out — so nothing is told. */
  disabled?: boolean;
  run: () => void;
}

/** A button beside the primary one, e.g. "Check again". */
interface DialogAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  /** Drawn as Cancel is, for one that leaves rather than goes through (RequirementsDialog's Quit). */
  secondary?: boolean;
}

/** The open tab's first field: what is typed into, a checkbox, a picker's input. */
const FIELD = "input:not([type=hidden]):not(:disabled):not([readonly]), textarea:not(:disabled):not([readonly]), select:not(:disabled)";

interface DialogTab<T extends string> {
  id: T;
  label: string;
  /** Given, the tab cannot be chosen and says why on hover. */
  disabled?: string;
  /** Given, something on the tab needs a look: an error mark beside the label, saying what. */
  mark?: string;
}

/**
 * What heads the dialog, one of two shapes: a title bar, or a tab strip in place of the title for a
 * dialog with several tabs. Either carries × when `onCancel` is given.
 */
type DialogHeader<T extends string> =
  | { title: string }
  | {
      tabs: readonly DialogTab<T>[];
      active: T;
      onSelect: (id: T) => void;
    };

interface DialogFrameProps<T extends string> {
  header: DialogHeader<T>;
  /** Draws the header's progress bar, the dialog's one indicator. */
  busy?: boolean;
  /** A held run: ×, Cancel, the `actions` and Escape wait, and the body's fields are disabled, so
   *  nothing is edited under a Save. Defaults to `busy`: what runs finishes before the dialog goes,
   *  unless it is aborted (`abort`). */
  locked?: boolean;
  /** What ×, Cancel and Escape mean. Left out for a wall that stays up until it is answered
   *  (RequirementsDialog): no ×, no Cancel, and Escape does nothing. */
  onCancel?: () => void;
  /** What a cancel cuts short first: a stopped run (AGENTS.md), whose answer is then dropped. */
  abort?: () => void;
  /** Before the primary button, after Cancel. */
  actions?: readonly DialogAction[];
  /** Enter runs it from anywhere in the dialog, unless it is blocked, disabled or a run holds. */
  primary?: DialogPrimary;
  /** The first field's text is selected as it takes the focus: a rename's name, typed over. */
  selectField?: boolean;
  /** What refused the dialog's Save, on the button row's left (`DialogError`): for a card whose
   *  fields — several, or across tabs — no one of them can be blamed. A field that can writes it
   *  itself, under the control (`Field`). Shown in `message`'s place while it stands. */
  error?: string;
  /** Beside the buttons, on the row's left: what the dialog says about its unsaved edits as a whole
   *  (`RestartNote`), never a failure — that is `error`. */
  message?: React.ReactNode;
  /** Variants on `.dialog`: `wide`, or the dialog's own class. */
  className?: string;
  children: React.ReactNode;
}

/**
 * The shell of every dialog — the questions in `Dialog.tsx` and everything under `dialogs/`:
 * overlay, card, header, body, and the button row it draws itself — Cancel, the `actions`, the
 * primary button — so each behaves the same everywhere. A form: Enter runs the primary button.
 *
 * The focus goes to the open tab's first field, on opening and on each tab switch — once one is
 * there, as a body that loads shows its fields later — and failing one to the primary button, so
 * Enter answers; the user's own click or key ends that. While one is up, no tab is on screen
 * (`window-covered.ts`).
 *
 * A modal `<dialog>`: the rest of the window is inert, so Tab cannot leave for the terminal or the
 * editor behind, and a question over another dialog is the one on top. `closedby="none"`, since
 * Escape is `onCancel`'s.
 */
export function DialogFrame<T extends string>({
  header,
  busy,
  locked = busy,
  error,
  message,
  className,
  onCancel,
  abort,
  actions = [],
  primary,
  selectField,
  children,
}: DialogFrameProps<T>) {
  const overlay = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLFieldSetElement>(null);
  const primaryButton = useRef<HTMLButtonElement>(null);
  const cancel = useCancel(() => onCancel?.(), locked || !onCancel, abort);
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
  // Pending from the opening and each tab switch until a field took it or the user acted.
  const focusPending = useRef(true);
  const activeTab = "tabs" in header ? header.active : undefined;
  useEffect(() => {
    focusPending.current = true;
  }, [activeTab]);
  // After every render: the field may only now be there, or no longer disabled.
  useEffect(() => {
    if (!focusPending.current) {
      return;
    }
    const field = body.current?.querySelector<HTMLInputElement>(FIELD);
    if (field) {
      field.focus();
      if (selectField) {
        field.select();
      }
      focusPending.current = false;
    } else if (!body.current?.contains(document.activeElement)) {
      primaryButton.current?.focus();
    }
  });
  // A held run disables the fields, which drops the focus: handed back to where it was once the
  // run ends, so a refused Save leaves the user where they typed.
  const beforeLock = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (locked) {
      beforeLock.current = document.activeElement;
      return;
    }
    const held = beforeLock.current;
    beforeLock.current = null;
    if (held instanceof HTMLElement && held.isConnected && !body.current?.contains(document.activeElement)) {
      held.focus();
    }
  }, [locked]);

  const primaryReady = primary !== undefined && primary.blocked === undefined && !primary.disabled && !locked;
  const cardClass = className ? `dialog ${className}` : "dialog";
  const content = (
    <>
      <div className={"tabs" in header ? "dialog-header dialog-tabs" : "dialog-header dialog-bar"}>
        {"tabs" in header ? (
          header.tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              // The context menu's disabled entry, not the attribute: chromium swallows a
              // disabled control's tooltip, and the reason is the point. A held run holds the tab
              // too: switching would unmount the form it answers into.
              className={`dialog-tab${header.active === entry.id ? " active" : ""}${entry.disabled || locked ? " disabled" : ""}`}
              title={entry.disabled ?? entry.mark}
              onClick={() => {
                if (!entry.disabled && !locked) {
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
          ))
        ) : (
          <span className="dialog-title">{header.title}</span>
        )}
        {onCancel && (
          <IconButton className={"tabs" in header ? "dialog-tabs-close" : undefined} title="Close" disabled={locked} onClick={cancel}>
            <CloseIcon />
          </IconButton>
        )}
        {busy && <ProgressBar />}
      </div>
      <fieldset ref={body} className="dialog-body" disabled={locked}>
        {children}
      </fieldset>
      <div className="dialog-buttons">
        {error !== undefined ? (
          <div className="dialog-buttons-message">
            <DialogError message={error} />
          </div>
        ) : (
          message && <div className="dialog-buttons-message">{message}</div>
        )}
        {onCancel && (
          <button type="button" className="button secondary" disabled={locked} onClick={cancel}>
            Cancel
          </button>
        )}
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.secondary ? "button secondary" : "button"}
            disabled={action.disabled || locked}
            onClick={action.run}
          >
            {action.label}
          </button>
        ))}
        {primary && (
          <button
            ref={primaryButton}
            type="submit"
            // Blocked by class, so its reason shows as the tooltip: chromium swallows a disabled
            // control's.
            className={primary.blocked === undefined ? "button" : "button disabled"}
            disabled={primary.disabled || locked}
            title={primary.blocked}
          >
            {primary.label}
          </button>
        )}
      </div>
    </>
  );
  return (
    <dialog ref={overlay} className="dialog-overlay" closedby="none">
      <form
        className={cardClass}
        onSubmit={(event) => {
          event.preventDefault();
          if (primaryReady) {
            primary.run();
          }
        }}
        // The user acts: the focus stays where they put it.
        onPointerDown={() => (focusPending.current = false)}
        onKeyDown={() => (focusPending.current = false)}
      >
        {content}
      </form>
    </dialog>
  );
}
