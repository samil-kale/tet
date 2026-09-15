import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DialogFrame } from "./DialogFrame";
import { CloseIcon, PinIcon, SparkleIcon, SpinnerIcon } from "./icons";
import { notify } from "./Notices";

export interface ConfirmOptions {
  title: string;
  /** The question, in one line. */
  message: string;
  /** What it means, when the question does not say. */
  detail?: string;
  /** The button that goes through; the other is always "Cancel". */
  confirmLabel: string;
  /** An option carried along, e.g. "delete it on the remote too". */
  checkboxLabel?: string;
}

export interface ConfirmAnswer {
  confirmed: boolean;
  /** Whether the checkbox was ticked; always false when the question had none. */
  checked: boolean;
}

export interface PromptHistoryLists {
  /** Pin order is display order. */
  pinned: string[];
  /** Newest first. */
  recent: string[];
}

/**
 * Past answers for a prompt's field, shown under it once clicked in. The callbacks persist at once
 * and return the updated lists, so housekeeping survives a Cancel.
 */
export interface PromptHistory extends PromptHistoryLists {
  /** Pin limit; the pin buttons disable there rather than ask. */
  maxPinned: number;
  onDelete: (text: string) => PromptHistoryLists;
  onTogglePin: (text: string) => PromptHistoryLists;
}

export interface PromptOptions {
  title: string;
  /** The field's label. */
  label: string;
  /** What it is for, when the label does not say — e.g. the branch a new one starts from. */
  detail?: string;
  /** The initial value, selected so typing replaces it. */
  value: string;
  confirmLabel: string;
  maxLength?: number;
  /** Further fields; each may be empty, unlike the answer's own field. */
  extras?: { label: string; placeholder?: string; value?: string }[];
  /** Where the answer's field sits among the extras, first by default. */
  valueIndex?: number;
  /** The wider dialog (`.dialog.wide`), for fields holding lines rather than words. */
  wide?: boolean;
  /** A yes/no under the fields, e.g. the push after a commit. See ConfirmOptions. */
  checkboxLabel?: string;
  /** Past answers under the field. See PromptHistory. */
  history?: PromptHistory;
  /** An async way to fill the answer's field, shown as a wand beside it. */
  suggestion?: {
    title: string;
    run: () => Promise<string>;
  };
}

export interface PromptAnswer {
  value: string;
  /** The extra fields' values in declared order, "" where blank. */
  extras: string[];
  /** Whether the checkbox was ticked; always false when the question had none. */
  checked: boolean;
}

type Pending =
  | ({ kind: "confirm"; answer: (answer: ConfirmAnswer) => void } & ConfirmOptions)
  | ({ kind: "prompt"; answer: (answer: PromptAnswer | null) => void } & PromptOptions);

/**
 * Asking the user, as `notify` tells them: a function anything can call, and one mounted component
 * drawing what is pending, in the window rather than Electron's `dialog.showMessageBox`.
 *
 * `confirm` is for the irreversible only. `prompt` is for a name, and is where every rename
 * happens: a tab is too narrow to name inline, and a commit-on-blur field loses typing to a stray
 * click.
 */
let pending: Pending | null = null;
const listeners = new Set<() => void>();

function publish(next: Pending | null): void {
  pending = next;
  for (const listener of listeners) {
    listener();
  }
}

/** One at a time: the overlay swallows the clicks that could start a second question. */
function ask<T>(build: (answer: (value: T) => void) => Pending, cancelled: T): Promise<T> {
  if (pending) {
    return Promise.resolve(cancelled);
  }
  return new Promise((resolve) => {
    // Answered once: a second call (an Escape between the click and the listener's removal) would
    // clear whatever dialog is up by then, possibly the next one.
    let answered = false;
    publish(
      build((value) => {
        if (answered) {
          return;
        }
        answered = true;
        publish(null);
        resolve(value);
      })
    );
  });
}

export function confirm(options: ConfirmOptions): Promise<ConfirmAnswer> {
  return ask<ConfirmAnswer>(
    (answer) => ({ kind: "confirm", ...options, answer }),
    { confirmed: false, checked: false }
  );
}

/** Resolves to what the user typed, or null when they cancelled. */
export function prompt(options: PromptOptions): Promise<PromptAnswer | null> {
  return ask<PromptAnswer | null>((answer) => ({ kind: "prompt", ...options, answer }), null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface FrameProps {
  title: string;
  confirmLabel: string;
  /** Nothing to go through with yet, e.g. an empty name. */
  disabled?: boolean;
  /** See PromptOptions.wide. */
  wide?: boolean;
  /** The confirm button takes the focus, for a dialog with no field. */
  focusSubmit?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

function Frame({ title, confirmLabel, disabled, wide, focusSubmit, onSubmit, onCancel, children }: FrameProps) {
  return (
    <DialogFrame
      header={{ title, onClose: onCancel }}
      className={wide ? "wide" : undefined}
      // A form, so Enter answers from the field or the checkbox alike.
      onSubmit={() => {
        if (!disabled) {
          onSubmit();
        }
      }}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={disabled} autoFocus={focusSubmit}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </DialogFrame>
  );
}

function ConfirmDialog({ dialog }: { dialog: Extract<Pending, { kind: "confirm" }> }) {
  const [checked, setChecked] = useState(false);
  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      // Opened from a context menu, focus would otherwise stay in the terminal and Enter answer
      // nothing.
      focusSubmit
      onSubmit={() => dialog.answer({ confirmed: true, checked })}
      onCancel={() => dialog.answer({ confirmed: false, checked: false })}
    >
      <p className="dialog-message">{dialog.message}</p>
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
      {dialog.checkboxLabel && (
        <label className="dialog-checkbox">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>{dialog.checkboxLabel}</span>
        </label>
      )}
    </Frame>
  );
}

/**
 * Asked first by `Dialogs`' Escape handler while a history dropdown is open, so one press closes
 * the dropdown and the next cancels. A claim, not a second listener: listener registration order
 * is no ordering to rely on.
 */
let claimEscape: (() => boolean) | null = null;

function HistoryDropdown({
  history,
  lists,
  onPick,
  onLists
}: {
  history: PromptHistory;
  lists: PromptHistoryLists;
  onPick: (text: string) => void;
  onLists: (next: PromptHistoryLists) => void;
}) {
  const atCap = lists.pinned.length >= history.maxPinned;
  const row = (text: string, pinned: boolean) => (
    // The row is the pick; its buttons stop the click. `type="button"`, or they submit the form.
    <div key={(pinned ? "p:" : "r:") + text} className="dialog-history-row" title={text} onClick={() => onPick(text)}>
      <span className="dialog-history-text">{text}</span>
      <button
        type="button"
        className={pinned ? "icon-button pinned" : "icon-button"}
        title={pinned ? "Unpin" : atCap ? "Unpin a message first" : "Pin"}
        disabled={!pinned && atCap}
        onClick={(event) => {
          event.stopPropagation();
          onLists(history.onTogglePin(text));
        }}
      >
        <PinIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        title="Delete"
        onClick={(event) => {
          event.stopPropagation();
          onLists(history.onDelete(text));
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
  return (
    // Preventing mousedown keeps focus in the field; a mousedown elsewhere blurs it, closing the
    // dropdown.
    <div className="dialog-history" onMouseDown={(event) => event.preventDefault()}>
      {lists.pinned.map((text) => row(text, true))}
      {lists.pinned.length > 0 && lists.recent.length > 0 && <div className="dialog-history-separator" />}
      {lists.recent.map((text) => row(text, false))}
    </div>
  );
}

function PromptDialog({ dialog }: { dialog: Extract<Pending, { kind: "prompt" }> }) {
  const [value, setValue] = useState(dialog.value);
  const [extras, setExtras] = useState<string[]>(() => (dialog.extras ?? []).map((field) => field.value ?? ""));
  const [checked, setChecked] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Seeded once: the options are frozen in `pending`, so the callbacks hand the lists back.
  const [lists, setLists] = useState<PromptHistoryLists>(() => ({
    pinned: dialog.history?.pinned ?? [],
    recent: dialog.history?.recent ?? []
  }));
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  // False during the mount effect's own focus, so the dropdown waits for the user's click.
  const interactive = useRef(false);

  // Focus and select the first field once on mount; per render would swallow keystrokes. The flag
  // is set after, since `focus()` fires its event synchronously.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
    interactive.current = true;
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    claimEscape = () => {
      if (!openRef.current) {
        return false;
      }
      setOpen(false);
      return true;
    };
    return () => {
      claimEscape = null;
    };
  }, []);

  const suggest = async (): Promise<void> => {
    if (!dialog.suggestion || suggesting) {
      return;
    }
    setSuggesting(true);
    setOpen(false);
    try {
      const suggested = (await dialog.suggestion.run()).trim();
      if (suggested.length > 0) {
        setValue(suggested);
        requestAnimationFrame(() => {
          field.current?.focus();
          field.current?.select();
        });
      }
    } catch (error) {
      notify("error", `Could not suggest a value: ${String(error)}`);
    } finally {
      setSuggesting(false);
    }
  };

  // Optional: only the answer's own field can hold the dialog back.
  const fields = (dialog.extras ?? []).map((entry, index) => (
    <label key={entry.label} className="dialog-field">
      <span>{entry.label}</span>
      <input
        type="text"
        value={extras[index] ?? ""}
        placeholder={entry.placeholder}
        onChange={(event) =>
          setExtras((current) => current.map((held, position) => (position === index ? event.target.value : held)))
        }
      />
    </label>
  ));
  const hasEntries = lists.pinned.length + lists.recent.length > 0;
  const input = (
    <input
      type="text"
      value={value}
      maxLength={dialog.maxLength}
      disabled={suggesting}
      // The dropdown shows only while the field is empty.
      onChange={(event) => {
        setValue(event.target.value);
        setOpen(event.target.value.length === 0 && hasEntries);
      }}
      // Mousedown, not click: it reopens after an Escape left the field focused, and the wrapping
      // label forwards clicks on the rows as synthetic *clicks*, which must not reopen after a pick.
      onMouseDown={dialog.history && (() => value.length === 0 && hasEntries && setOpen(true))}
      onFocus={dialog.history && (() => interactive.current && value.length === 0 && hasEntries && setOpen(true))}
      onBlur={dialog.history && (() => setOpen(false))}
      ref={field}
    />
  );
  // The dropdown's anchor wraps the field alone; the suggest button sits one level up.
  const anchored = dialog.history ? (
    <div className="dialog-history-anchor">
      {input}
      {open && hasEntries && (
        <HistoryDropdown
          history={dialog.history}
          lists={lists}
          onPick={(text) => {
            setValue(text);
            setOpen(false);
          }}
          onLists={(next) => {
            setLists(next);
            if (next.pinned.length + next.recent.length === 0) {
              setOpen(false);
            }
          }}
        />
      )}
    </div>
  ) : (
    input
  );
  fields.splice(
    dialog.valueIndex ?? 0,
    0,
    <label key="value" className="dialog-field">
      <span>{dialog.label}</span>
      {dialog.suggestion ? (
        // Paired like a path field and its Browse button; the spinner replaces the wand while
        // suggesting.
        <div className="dialog-field-row">
          {anchored}
          <button
            type="button"
            className="button secondary dialog-suggest"
            title={dialog.suggestion.title}
            disabled={suggesting}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void suggest()}
          >
            {suggesting ? <SpinnerIcon className="spinning" /> : <SparkleIcon />}
          </button>
        </div>
      ) : (
        anchored
      )}
    </label>
  );

  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      disabled={suggesting || value.trim().length === 0}
      wide={dialog.wide}
      onSubmit={() => dialog.answer({ value: value.trim(), extras: extras.map((entry) => entry.trim()), checked })}
      onCancel={() => dialog.answer(null)}
    >
      {fields}
      {dialog.checkboxLabel && (
        <label className="dialog-checkbox">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>{dialog.checkboxLabel}</span>
        </label>
      )}
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
    </Frame>
  );
}

/** Mounted once, next to `Notices`. */
export function Dialogs() {
  const dialog = useSyncExternalStore(subscribe, () => pending);

  useEffect(() => {
    if (!dialog) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Captured and swallowed so the ESC never reaches the terminal. On `window`, not
        // `document`: dialogs a question is asked from capture on `document`, and
        // `stopPropagation` does not stop listeners on the same node.
        event.preventDefault();
        event.stopPropagation();
        // An open history dropdown takes the press first.
        if (claimEscape?.()) {
          return;
        }
        if (dialog.kind === "confirm") {
          dialog.answer({ confirmed: false, checked: false });
        } else {
          dialog.answer(null);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dialog]);

  if (!dialog) {
    return null;
  }
  return dialog.kind === "confirm" ? <ConfirmDialog dialog={dialog} /> : <PromptDialog dialog={dialog} />;
}
