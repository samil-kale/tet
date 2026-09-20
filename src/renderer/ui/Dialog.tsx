import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DialogFrame } from "./DialogFrame";
import { Checkbox, Field, TextField } from "./Field";
import { SparkleIcon, SpinnerIcon } from "./icons";
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
  /** A color picked from swatches under the fields, e.g. a command row's. A "no color" swatch is
   *  always offered first: like the extras, it may be left empty. */
  colors?: {
    label: string;
    /** Each choice's answer and the color it is drawn in — an ANSI name and its
     *  `--vscode-terminal-ansi*` variable, so the swatches follow the theme. */
    choices: { value: string; color: string; title: string }[];
    value?: string;
  };
  /** The wider dialog (`.dialog.wide`), for fields holding lines rather than words. */
  wide?: boolean;
  /** A yes/no under the fields, e.g. the push after a commit. See ConfirmOptions. */
  checkboxLabel?: string;
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
  /** The picked color's value; "" for none, and for a question that offered no colors. */
  color: string;
  /** Whether the checkbox was ticked; always false when the question had none. */
  checked: boolean;
}

type Pending =
  | ({ kind: "confirm"; answer: (answer: ConfirmAnswer) => void } & ConfirmOptions)
  | ({ kind: "prompt"; answer: (answer: PromptAnswer | null) => void } & PromptOptions);

/**
 * Asking the user, as `notify` tells them: a function anything can call, and one mounted component
 * drawing what is pending, in the window rather than Electron's `dialog.showMessageBox`. The main
 * process asks nothing: a question lives in the view offering the action. Questions only — a form
 * with two buttons; `SettingsDialog` and the rest of `dialogs/` are not part of this.
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
      {dialog.checkboxLabel && <Checkbox label={dialog.checkboxLabel} checked={checked} onChange={setChecked} />}
    </Frame>
  );
}

function PromptDialog({ dialog }: { dialog: Extract<Pending, { kind: "prompt" }> }) {
  const [value, setValue] = useState(dialog.value);
  const [extras, setExtras] = useState<string[]>(() => (dialog.extras ?? []).map((field) => field.value ?? ""));
  const [color, setColor] = useState(dialog.colors?.value ?? "");
  const [checked, setChecked] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // Focus and select the first field once on mount; per render would swallow keystrokes.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const suggest = async (): Promise<void> => {
    if (!dialog.suggestion || suggesting) {
      return;
    }
    setSuggesting(true);
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
    <TextField
      key={entry.label}
      label={entry.label}
      value={extras[index] ?? ""}
      placeholder={entry.placeholder}
      onChange={(next) => setExtras((current) => current.map((held, position) => (position === index ? next : held)))}
    />
  ));
  const input = (
    <input
      type="text"
      value={value}
      maxLength={dialog.maxLength}
      disabled={suggesting}
      onChange={(event) => setValue(event.target.value)}
      ref={field}
    />
  );
  fields.splice(
    dialog.valueIndex ?? 0,
    0,
    <Field key="value" label={dialog.label}>
      {dialog.suggestion ? (
        // Paired like a path field and its Browse button; the spinner replaces the wand while
        // suggesting.
        <div className="dialog-field-row">
          {input}
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
        input
      )}
    </Field>
  );

  return (
    <Frame
      title={dialog.title}
      confirmLabel={dialog.confirmLabel}
      disabled={suggesting || value.trim().length === 0}
      wide={dialog.wide}
      onSubmit={() => dialog.answer({ value: value.trim(), extras: extras.map((entry) => entry.trim()), color, checked })}
      onCancel={() => dialog.answer(null)}
    >
      {fields}
      {dialog.colors && (
        // A div, not the fields' label: a label wrapping buttons would forward its clicks to the
        // first swatch.
        <div className="dialog-field">
          <span>{dialog.colors.label}</span>
          <div className="dialog-colors">
            {[{ value: "", color: "", title: "No color" }, ...dialog.colors.choices].map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={`dialog-color${choice.value ? "" : " none"}${choice.value === color ? " selected" : ""}`}
                title={choice.title}
                style={choice.color ? { background: choice.color } : undefined}
                onClick={() => setColor(choice.value)}
              />
            ))}
          </div>
        </div>
      )}
      {dialog.checkboxLabel && <Checkbox label={dialog.checkboxLabel} checked={checked} onChange={setChecked} />}
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
