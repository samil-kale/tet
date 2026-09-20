import type { KeyboardEvent, ReactNode, Ref } from "react";

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
