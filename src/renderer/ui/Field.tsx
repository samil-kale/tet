import { useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { errorMessage } from "../../shared/errors";
import type { SuggestionResult } from "../../shared/types";
import { SparkleIcon, SpinnerIcon } from "./icons";

/**
 * What refused an answer, where the answer was given: under the field to blame (`Field`), in a
 * card's button row level with the buttons (`DialogFrame`), or in place of the list that could not
 * be loaded. Words
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
 * — a row holding a set of them (buttons, a radio group) is a `FieldGroup`, which no single label
 * can point at.
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

/** `Field`'s row for a set of controls: a div, as a label wrapping buttons would forward its
 *  clicks to the first. */
export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dialog-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** Where the picker opens for an empty path field. Renderer storage, shared by every such field:
 *  it describes this window's use, not a project. */
const LAST_DIRECTORY_KEY = "tet.dialog.lastDirectory";

interface PathInputProps {
  value: string;
  /** The native picker's window title. */
  pickTitle: string;
  onChange: (value: string) => void;
  /** Only what the picker returned, never typed (the SBX skills folder). */
  pickedOnly?: boolean;
  placeholder?: string;
  /** For the dialog's focus effect, when this is a mode's first field. */
  ref?: Ref<HTMLInputElement>;
}

/** A folder's path with a Browse button beside it; a cancelled pick keeps the path there was. */
export function PathInput({ value, pickTitle, onChange, pickedOnly, placeholder, ref }: PathInputProps) {
  const browse = async (): Promise<void> => {
    // The field's own value is more specific, so it wins.
    const start = value.trim() || localStorage.getItem(LAST_DIRECTORY_KEY) || undefined;
    const picked = await window.tet.projects.pickDirectory(pickTitle, start);
    if (picked) {
      // A picked repository's parent is where the picker opens next.
      localStorage.setItem(LAST_DIRECTORY_KEY, await window.tet.projects.directoryToRemember(picked));
      onChange(picked);
    }
  };
  return (
    <div className="dialog-field-row">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={pickedOnly}
        title={pickedOnly ? value : undefined}
        onChange={(event) => onChange(event.target.value)}
        ref={ref}
      />
      <button type="button" className="button secondary" onClick={() => void browse()}>
        Browse...
      </button>
    </div>
  );
}

/** A `Field` holding a `PathInput`. */
export function PathField({ label, ...input }: PathInputProps & { label: string }) {
  return (
    <Field label={label}>
      <PathInput {...input} />
    </Field>
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
  /** An async way to fill the field, shown as a wand beside it. Why it had none is said under the
   *  field, in `error`'s place, until the next suggestion or keystroke. */
  suggestion: {
    title: string;
    run: () => Promise<SuggestionResult>;
  };
  disabled?: boolean;
  /** The field a dialog opens focused; refocused once a suggestion arrives. */
  ref: RefObject<HTMLInputElement | null>;
  /** See `Field`. */
  error?: string;
  /** Told while a suggestion is fetched, for the dialog to hold its answer back (`PromptFields`). */
  onSuggesting?: (suggesting: boolean) => void;
}

/** A text field with a wand beside it that fills it, e.g. a model's commit message. */
export function SuggestField({ label, value, onChange, suggestion, disabled, ref, error, onSuggesting }: SuggestFieldProps) {
  const [suggesting, setSuggesting] = useState(false);
  const [refused, setRefused] = useState<string>();

  const suggest = async (): Promise<void> => {
    if (suggesting) {
      return;
    }
    setSuggesting(true);
    setRefused(undefined);
    onSuggesting?.(true);
    try {
      const result = await suggestion.run();
      const suggested = result.value?.trim() ?? "";
      if (suggested.length > 0) {
        onChange(suggested);
        requestAnimationFrame(() => {
          ref.current?.focus();
          ref.current?.select();
        });
      }
      setRefused(result.error);
    } catch (error) {
      setRefused(`Could not suggest a value: ${errorMessage(error)}`);
    } finally {
      setSuggesting(false);
      onSuggesting?.(false);
    }
  };

  return (
    <Field label={label} error={refused ?? error}>
      {/* Paired like a path field and its Browse button; the spinner replaces the wand while
          suggesting. */}
      <div className="dialog-field-row">
        <input
          type="text"
          value={value}
          disabled={disabled || suggesting}
          onChange={(event) => {
            setRefused(undefined);
            onChange(event.target.value);
          }}
          ref={ref}
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
    <FieldGroup label={label}>
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
    </FieldGroup>
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
