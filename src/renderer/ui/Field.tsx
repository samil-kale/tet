import { useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { errorMessage } from "../../shared/errors";
import { SparkleIcon, SpinnerIcon } from "./icons";
import { notify } from "./Notices";

/**
 * What refused an answer, where the answer was given: under the field to blame (`Field`), above a
 * card's button row (`DialogFrame`), or in place of the list that could not be loaded. Words
 * alone, since the colour and the place already say what it is; nothing at all while there is
 * nothing to say.
 */
export function DialogError({ message }: { message: string | undefined }) {
  return message === undefined ? null : <p className="dialog-error">{message}</p>;
}

interface FieldProps {
  label: string;
  children: ReactNode;
  /** What refused this field's value, on its own line under the control (`DialogError`). */
  error?: string;
}

/**
 * A dialog row: its label above one control. A `<label>`, so clicking the text reaches the control
 * — a row holding a set of them (buttons, a radio group) writes its own `div.dialog-field`, which
 * no single label can point at.
 */
export function Field({ label, children, error }: FieldProps) {
  return (
    <label className="dialog-field">
      <span>{label}</span>
      {children}
      <DialogError message={error} />
    </label>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** `password` for a secret entered once and never shown again. */
  type?: "text" | "password";
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  /** For a field whose Enter means a form of its own, not the dialog's. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** The field a dialog opens focused. */
  ref?: Ref<HTMLInputElement>;
  /** See `Field`. */
  error?: string;
}

/** A `Field` holding the one-line input the dialogs' fields are built from. */
export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  maxLength,
  disabled,
  onKeyDown,
  ref,
  error
}: TextFieldProps) {
  return (
    <Field label={label} error={error}>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        ref={ref}
      />
    </Field>
  );
}

interface SuggestFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** An async way to fill the field, shown as a wand beside it. */
  suggestion: {
    title: string;
    run: () => Promise<string>;
  };
  disabled?: boolean;
  /** The field a dialog opens focused; refocused once a suggestion arrives. */
  ref?: RefObject<HTMLInputElement | null>;
  /** See `Field`. */
  error?: string;
  /** Told while a suggestion is fetched, for the dialog to hold its answer back (`PromptFields`). */
  onSuggesting?: (suggesting: boolean) => void;
}

/** A text field with a wand beside it that fills it, e.g. a model's commit message. */
export function SuggestField({ label, value, onChange, suggestion, disabled, ref, error, onSuggesting }: SuggestFieldProps) {
  const [suggesting, setSuggesting] = useState(false);
  const own = useRef<HTMLInputElement>(null);
  const input = ref ?? own;

  const suggest = async (): Promise<void> => {
    if (suggesting) {
      return;
    }
    setSuggesting(true);
    onSuggesting?.(true);
    try {
      const suggested = (await suggestion.run()).trim();
      if (suggested.length > 0) {
        onChange(suggested);
        requestAnimationFrame(() => {
          input.current?.focus();
          input.current?.select();
        });
      }
    } catch (error) {
      notify("error", `Could not suggest a value: ${errorMessage(error)}`);
    } finally {
      setSuggesting(false);
      onSuggesting?.(false);
    }
  };

  return (
    <Field label={label} error={error}>
      {/* Paired like a path field and its Browse button; the spinner replaces the wand while
          suggesting. */}
      <div className="dialog-field-row">
        <input
          type="text"
          value={value}
          disabled={disabled || suggesting}
          onChange={(event) => onChange(event.target.value)}
          ref={input}
        />
        <button
          type="button"
          className="button secondary dialog-suggest"
          title={suggestion.title}
          disabled={suggesting}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void suggest()}
        >
          {suggesting ? <SpinnerIcon className="spinning" /> : <SparkleIcon />}
        </button>
      </div>
    </Field>
  );
}

interface ColorFieldProps {
  label: string;
  /** Each choice's answer and the color it is drawn in — an ANSI name and its
   *  `--vscode-terminal-ansi*` variable, so the swatches follow the theme. */
  choices: { value: string; color: string; title: string }[];
  /** The picked choice's value; "" for none. */
  value: string;
  onChange: (value: string) => void;
}

/** A color picked from swatches, e.g. a command row's. A "no color" swatch is always offered
 *  first: a color is optional. */
export function ColorField({ label, choices, value, onChange }: ColorFieldProps) {
  return (
    // A div, not a label: a label wrapping buttons would forward its clicks to the first swatch.
    <div className="dialog-field">
      <span>{label}</span>
      <div className="dialog-colors">
        {[{ value: "", color: "", title: "No color" }, ...choices].map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={`dialog-color${choice.value ? "" : " none"}${choice.value === value ? " selected" : ""}`}
            title={choice.title}
            style={choice.color ? { background: choice.color } : undefined}
            onClick={() => onChange(choice.value)}
          />
        ))}
      </div>
    </div>
  );
}

interface CheckboxProps {
  /** A node, not a string: the sbx switch carries a description under its title. */
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A checkbox with its label beside it; the box itself is drawn by tet, never by Chrome. */
export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <label className="dialog-checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
