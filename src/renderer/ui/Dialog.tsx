import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { DialogFrame } from "./DialogFrame";
import { Checkbox, TextField } from "./Field";
import { notify } from "./Notices";
import { createStore, useStore } from "./store";

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
  /** Runs the answer while the question still stands, with the header's bar, as `PromptOptions.submit`
   *  does; it closes once this settles. For an answer that takes the window with it (a restart). */
  submit?: (checked: boolean) => Promise<void>;
}

export interface ConfirmAnswer {
  confirmed: boolean;
  /** Whether the checkbox was ticked; always false when the question had none. */
  checked: boolean;
}

/** What a question's fields are drawn from (`PromptOptions.render`). */
export interface PromptFields<T> {
  value: T;
  onChange: (value: T) => void;
  /** What `submit` refused, for the field it was typed in (`Field`'s `error`). Cleared by the next
   *  change, which is about to make it wrong. */
  error: string | undefined;
  /** `submit` is underway: the field it may refuse is disabled meanwhile. */
  busy: boolean;
  /** For the field the dialog opens focused and selected, and returns to on a refusal. */
  field: RefObject<HTMLInputElement | null>;
  /** A field still fetching its value (`SuggestField`'s wand) holds the answer back meanwhile. */
  hold: (held: boolean) => void;
}

export interface PromptOptions<T> {
  title: string;
  /** What it is for, when the fields do not say — e.g. the branch a new one starts from. */
  detail?: string;
  confirmLabel: string;
  /** The answer as the dialog opens. */
  value: T;
  /** Whether it can be given yet, e.g. a name left empty cannot. */
  ready: (value: T) => boolean;
  /** The fields, from `Field.tsx`'s components. */
  render: (fields: PromptFields<T>) => ReactNode;
  /**
   * Runs the answer while the question still stands, so what refuses it is shown at the field it
   * was typed in rather than as a notice once the dialog is gone — git's own words for a name it
   * will not take. A message means refused: the dialog stays up, holding what was typed. Nothing
   * means done, and it closes. Left out, the answer is simply handed back.
   */
  submit?: (value: T) => Promise<string | undefined>;
}

type Question =
  | ({ kind: "confirm"; answer: (answer: ConfirmAnswer) => void } & ConfirmOptions)
  | ({ kind: "prompt"; answer: (answer: unknown) => void } & PromptOptions<unknown>);

/** A question as it is up: `cancel` answers what Escape, × and Cancel all mean. */
type Pending = Question & { cancel: () => void };

/**
 * Asking the user, as `notify` tells them: a function anything can call, and one mounted component
 * drawing what is pending, in the window rather than Electron's `dialog.showMessageBox`. The main
 * process asks nothing: a question lives in the view offering the action, except an agent's
 * `env-request` (`EnvDialog`). Questions only — a form with two buttons;
 * `SettingsDialog` and the rest of `dialogs/` are not part of this.
 *
 * `confirm` is for the irreversible only. `prompt` is for what is typed — a name, a message, a set
 * of fields drawn by the caller from `Field.tsx`'s components — and is where every rename
 * happens: a tab is too narrow to name inline, and a commit-on-blur field loses typing to a stray
 * click.
 */
const pending = createStore<Pending | null>(null);

/** Whether a question is up, which a new one would then not be: its caller tells its news another
 *  way (a notice). */
export function questionUp(): boolean {
  return pending.get() !== null;
}

/** One at a time: the overlay swallows the clicks that could start a second question. */
function ask<T>(build: (answer: (value: T) => void) => Question, cancelled: T): Promise<T> {
  if (pending.get()) {
    return Promise.resolve(cancelled);
  }
  return new Promise((resolve) => {
    // Answered once: a second call (an Escape between the click and the listener's removal) would
    // clear whatever dialog is up by then, possibly the next one.
    let answered = false;
    const answer = (value: T): void => {
      if (answered) {
        return;
      }
      answered = true;
      pending.set(null);
      resolve(value);
    };
    pending.set({ ...build(answer), cancel: () => answer(cancelled) });
  });
}

export function confirm(options: ConfirmOptions): Promise<ConfirmAnswer> {
  return ask<ConfirmAnswer>(
    (answer) => ({ kind: "confirm", ...options, answer }),
    { confirmed: false, checked: false }
  );
}

/** Resolves to what the user entered, or null when they cancelled. */
export function prompt<T>(options: PromptOptions<T>): Promise<T | null> {
  // Held untyped while up: `PromptDialog` only ever hands `render` and `submit` the value `options`
  // started it with.
  const held = options as unknown as PromptOptions<unknown>;
  return ask<T | null>((answer) => ({ kind: "prompt", ...held, answer: answer as (value: unknown) => void }), null);
}

/** Whether a line of text was typed, spaces aside: `ready` for a required one. */
export function filled(text: string): boolean {
  return text.trim().length > 0;
}

/** `render` for a question asking one line of text, e.g. a name. */
export function singleField(label: string, maxLength?: number): PromptOptions<string>["render"] {
  return ({ value, onChange, error, busy, field }) => (
    <TextField
      label={label}
      value={value}
      onChange={onChange}
      maxLength={maxLength}
      disabled={busy}
      ref={field}
      error={error}
    />
  );
}

interface FrameProps {
  title: string;
  confirmLabel: string;
  /** Nothing to go through with yet, e.g. an empty name. */
  disabled?: boolean;
  /** `PromptOptions.submit` is underway: the header's bar, as everywhere else. */
  busy?: boolean;
  /** The confirm button takes the focus, for a dialog with no field. */
  focusSubmit?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

function Frame({ title, confirmLabel, disabled, busy, focusSubmit, onSubmit, onCancel, children }: FrameProps) {
  return (
    <DialogFrame
      header={{ title, onClose: onCancel }}
      busy={busy}
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
  const [running, setRunning] = useState(false);

  const submit = async (): Promise<void> => {
    if (dialog.submit) {
      setRunning(true);
      try {
        await dialog.submit(checked);
      } finally {
        setRunning(false);
      }
    }
    dialog.answer({ confirmed: true, checked });
  };

  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      disabled={running}
      busy={running}
      // Opened from a context menu, focus would otherwise stay in the terminal and Enter answer
      // nothing.
      focusSubmit
      onSubmit={() => void submit()}
      onCancel={dialog.cancel}
    >
      <p className="dialog-message">{dialog.message}</p>
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
      {dialog.checkboxLabel && <Checkbox label={dialog.checkboxLabel} checked={checked} onChange={setChecked} />}
    </Frame>
  );
}

function PromptDialog({ dialog }: { dialog: Extract<Pending, { kind: "prompt" }> }) {
  const [value, setValue] = useState(dialog.value);
  /** What `submit` refused, handed to the fields; cleared by the next change. */
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [held, setHeld] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  /** Escape closes the question while `submit` runs: the refusal then has no field to sit at and
   *  falls back to a notice, so it is never lost. */
  const live = useRef(true);

  // Focus and select the first field once on mount; per render would swallow keystrokes.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  useEffect(() => () => void (live.current = false), []);

  const submit = async (): Promise<void> => {
    if (!dialog.submit) {
      dialog.answer(value);
      return;
    }
    setRunning(true);
    setRefused(undefined);
    let message: string | undefined;
    try {
      message = await dialog.submit(value);
    } finally {
      setRunning(false);
    }
    if (!live.current) {
      if (message !== undefined) {
        notify("error", message);
      }
      return;
    }
    if (message === undefined) {
      dialog.answer(value);
    } else {
      setRefused(message);
      field.current?.focus();
    }
  };

  const onChange = (next: unknown): void => {
    setValue(next);
    setRefused(undefined);
  };

  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      disabled={running || held || !dialog.ready(value)}
      busy={running}
      onSubmit={() => void submit()}
      onCancel={dialog.cancel}
    >
      {dialog.render({ value, onChange, error: refused, busy: running, field, hold: setHeld })}
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
    </Frame>
  );
}

/** Mounted once, next to `Notices`. */
export function Dialogs() {
  const dialog = useStore(pending);

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
        dialog.cancel();
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
