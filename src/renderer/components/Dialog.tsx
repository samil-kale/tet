import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CloseIcon, PinIcon } from "./icons";

export interface ConfirmOptions {
  title: string;
  /** The question itself, in one line. */
  message: string;
  /** What it means, when that is not obvious from the question. */
  detail?: string;
  /** The button that goes through with it; "Cancel" is always the other one. */
  confirmLabel: string;
  /** An option the question carries along, e.g. "delete it on the remote too". */
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
 * Past answers for a prompt's own field, shown under it once the user clicks in — the pinned
 * ones first, then the rest, each with a pin and a delete of its own. The callbacks persist
 * immediately and return the lists as they now stand, so housekeeping survives a Cancel.
 */
export interface PromptHistory extends PromptHistoryLists {
  /** Where pinning stops; the pin buttons disable there rather than ask. */
  maxPinned: number;
  onDelete: (text: string) => PromptHistoryLists;
  onTogglePin: (text: string) => PromptHistoryLists;
}

export interface PromptOptions {
  title: string;
  /** What the field holds, above it. */
  label: string;
  /** What it is for, when the label alone does not say — the branch a new one starts from. */
  detail?: string;
  /** What the field starts out with, selected so typing replaces it. */
  value: string;
  confirmLabel: string;
  maxLength?: number;
  /**
   * Further fields, for a question whose optional parts sit next to its answer — a saved
   * command's name, folder and environment next to it. Empty is a valid answer for each of
   * them; the answer's own field is the one that must be filled in.
   */
  extras?: { label: string; placeholder?: string; value?: string }[];
  /**
   * Where the answer's own field sits among the extras, first by default. A saved command's
   * name goes above it: it is what the row will be called, and a label reads as the heading of
   * what it names rather than as a note under it.
   */
  valueIndex?: number;
  /**
   * The add-repository dialog's width instead of the default one, for a question whose fields
   * hold lines rather than words — a command with its arguments, a list of variables.
   */
  wide?: boolean;
  /** An optional yes/no under the fields — the push after a commit. See ConfirmOptions. */
  checkboxLabel?: string;
  /** Past answers under the field, absent for the prompts that keep none. See PromptHistory. */
  history?: PromptHistory;
}

export interface PromptAnswer {
  value: string;
  /** The extra fields' values in the order they were declared, "" where one was left blank. */
  extras: string[];
  /** Whether the checkbox was ticked; always false when the question had none. */
  checked: boolean;
}

type Pending =
  | ({ kind: "confirm"; answer: (answer: ConfirmAnswer) => void } & ConfirmOptions)
  | ({ kind: "prompt"; answer: (answer: PromptAnswer | null) => void } & PromptOptions);

/**
 * Asking the user something, the way `notify` tells them something: one function anything can
 * call, and one component mounted once that draws whatever is pending. Rendered in the window
 * rather than through Electron's `dialog.showMessageBox`, so a question looks like the rest of
 * the app instead of like the OS.
 *
 * `confirm` is for something that cannot be undone — a question answered the same way every
 * time is not worth asking. `prompt` is for a name, and is where every rename happens: naming
 * something inline was tried and reverted, since a tab is too narrow for a name and a field
 * committing on blur loses what was typed to a stray click.
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
    // Answered once. A second call — an Escape that lands in the moment between the click and
    // the listener coming down — would otherwise clear whatever dialog is up by then, which
    // may already be the next one.
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
  /** Nothing to go through with yet — an empty name, say. */
  disabled?: boolean;
  /** See PromptOptions.wide. */
  wide?: boolean;
  /** The confirm button takes the focus, for a dialog with no field of its own to take it. */
  focusSubmit?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

function Frame({ title, confirmLabel, disabled, wide, focusSubmit, onSubmit, onCancel, children }: FrameProps) {
  return (
    <div className="dialog-overlay">
      {/* A form, so Enter answers from wherever the focus sits — the field or the checkbox. */}
      <form
        className={wide ? "dialog wide" : "dialog"}
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) {
            onSubmit();
          }
        }}
      >
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-buttons">
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={disabled} autoFocus={focusSubmit}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({ dialog }: { dialog: Extract<Pending, { kind: "confirm" }> }) {
  const [checked, setChecked] = useState(false);
  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      // Opened from a context menu, the focus would otherwise stay wherever it was — a terminal,
      // whose keys keep going there — and Enter would answer nothing.
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
 * Set while a prompt's history dropdown is open; the Escape handler in `Dialogs` asks it first,
 * so one press closes the dropdown and only the next cancels the dialog. A module-level claim
 * rather than a second listener on purpose: registration order against a window capture handler
 * is nothing to build an ordering on, as that handler's own comment explains.
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
    // The row itself is the pick; its two buttons stop the click there. `type="button"` on
    // both, since everything here sits inside the dialog's form and the default would submit.
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
    // Preventing mousedown keeps the focus in the field, so picking or housekeeping never
    // blurs it — and a mousedown anywhere else does, which is what closes the dropdown.
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
  const field = useRef<HTMLInputElement>(null);
  // Seeded once: `prompt()` froze the options into `pending`, so the caller cannot re-render
  // this dialog — its callbacks hand the lists back instead.
  const [lists, setLists] = useState<PromptHistoryLists>(() => ({
    pinned: dialog.history?.pinned ?? [],
    recent: dialog.history?.recent ?? []
  }));
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  // Not yet the user's focus: the mount effect below focuses the field itself, and the
  // dropdown must wait for their own click rather than open over the dialog unasked.
  const interactive = useRef(false);

  // The focus has to land in the first field, not on a button: a rename is opened to type in.
  // Once, on the way in — selecting on every render would swallow each keystroke after it.
  // The flag comes after: `focus()` delivers its event synchronously, so the focus handler
  // has already seen it unset.
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

  // Optional by construction: only the answer's own field can hold the dialog back, wherever
  // `valueIndex` puts it among them.
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
  // Empty history means no dropdown at all — the field behaves exactly as it does for the
  // prompts that keep none.
  const hasEntries = lists.pinned.length + lists.recent.length > 0;
  const input = (
    <input
      type="text"
      value={value}
      maxLength={dialog.maxLength}
      // The dropdown follows the field's emptiness: typing the first character closes it —
      // the user has decided against picking, and the list would otherwise sit over the
      // checkbox while they write — and emptying the field brings it back. A no-op for the
      // prompts without one.
      onChange={(event) => {
        setValue(event.target.value);
        setOpen(event.target.value.length === 0 && hasEntries);
      }}
      // Mousedown rather than click, twice over: it re-opens after an Escape left the field
      // focused, and the label around this input forwards clicks on the rows below as
      // synthetic *clicks* — which must not reopen what a pick just closed.
      onMouseDown={dialog.history && (() => value.length === 0 && hasEntries && setOpen(true))}
      onFocus={dialog.history && (() => interactive.current && value.length === 0 && hasEntries && setOpen(true))}
      onBlur={dialog.history && (() => setOpen(false))}
      ref={field}
    />
  );
  fields.splice(
    dialog.valueIndex ?? 0,
    0,
    <label key="value" className="dialog-field">
      <span>{dialog.label}</span>
      {dialog.history ? (
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
      )}
    </label>
  );

  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      disabled={value.trim().length === 0}
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

/** Mounted once, next to `Notices`; draws nothing until something asks. */
export function Dialogs() {
  const dialog = useSyncExternalStore(subscribe, () => pending);

  useEffect(() => {
    if (!dialog) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Capture phase and swallowed here, so dismissing the question can't double as an
        // ESC keystroke for the terminal that had focus before it opened. On `window` rather
        // than `document`: the dialogs a question is asked from listen there in the capture
        // phase too, and `stopPropagation` does not stop listeners on the same node — one
        // keystroke would answer the question and close the dialog under it.
        event.preventDefault();
        event.stopPropagation();
        // A prompt's open history dropdown takes the press first: one Escape closes it, the
        // next one cancels the dialog.
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
