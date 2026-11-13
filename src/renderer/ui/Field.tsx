import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode, type Ref, type RefCallback } from "react";
import { errorMessage } from "../../shared/errors";
import type { SuggestionResult } from "../../shared/types/agents";
import { isModifierHeld } from "../platform";
import { useBusy } from "./use-busy";
import { useStoredHeight } from "./layout-storage";
import { useTextContextMenu } from "./use-text-context-menu";

/**
 * What refused an answer, where the answer was given, rather than a notice:
 * - under the field to blame (`Field`'s `error`);
 * - in a row of a list, as the error mark's tooltip beside it (`RowMark`, the one mark; on a dialog
 *   tab, `SwitchTab.mark`, repeating its first row's, from the one function that builds the row's);
 * - else on the left of a card's button row, level with the buttons (`DialogFrame`'s `error`), where
 *   the fields are several or across tabs;
 * - in place of the list that could not be loaded, but for Add Repository's remote listing, whose
 *   failure goes in the button row.
 *
 * Words alone, since the colour and the place already say what it is; nothing at all while there is
 * nothing to say. What was typed is held so it can be corrected, and the words are git's own for a
 * name it will not take, never TET's guess at them. What the unsaved edits as a whole lead to goes in
 * the button row too (`DialogFrame`'s `message`, e.g. `RestartNote`).
 */
export function DialogError({ message }: { message: string | undefined }) {
  return message === undefined ? null : <p className="dialog-error">{message}</p>;
}

interface FieldProps {
  /** A sentence naming what the field is of is `named`. */
  label: ReactNode;
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

/** Controls side by side in a dialog — a field and its button, two dropdowns, a status and its
 *  action — every such row spaced alike. `className` adds what only one row needs. */
export function FieldRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className ? `dialog-field-row ${className}` : "dialog-field-row"}>{children}</div>;
}

/** Fields stacked in a dialog, spaced as a `Field`'s label and control. `fill` takes the room its
 *  parent leaves, so a scrollbox inside can shrink into it; `className` adds what only one needs. */
export function FieldColumn({ className, fill, children }: { className?: string; fill?: boolean; children: ReactNode }) {
  const classes = ["dialog-column", ...(fill ? ["fill"] : []), ...(className ? [className] : [])];
  return <div className={classes.join(" ")}>{children}</div>;
}

/** Where the picker opens for an empty path field. Renderer storage, shared by every such field:
 *  it describes this window's use, not a project. */
const LAST_DIRECTORY_KEY = "tet.dialog.lastDirectory";

/** The last directory a picker returned, or where a repository added there remembers its parent —
 *  for a field that starts there instead of empty (the clone tab's destination). */
export function lastDirectory(): string {
  return localStorage.getItem(LAST_DIRECTORY_KEY) ?? "";
}

interface PathInputProps {
  value: string;
  /** The native picker's window title. */
  pickTitle: string;
  onChange: (value: string) => void;
  /** Only what the picker returned, never typed (the SBX skills folder). */
  pickedOnly?: boolean;
  placeholder?: string;
}

/** A folder's path with a Browse button beside it; a cancelled pick keeps the path there was. */
export function PathInput({ value, pickTitle, onChange, pickedOnly, placeholder }: PathInputProps) {
  const browse = async (): Promise<void> => {
    // The field's own value is more specific, so it wins where it leads anywhere.
    const last = localStorage.getItem(LAST_DIRECTORY_KEY) ?? "";
    const picked = await window.tet.projects.pickDirectory(pickTitle, [value.trim(), last]);
    if (picked) {
      // A picked repository's parent is where the picker opens next.
      localStorage.setItem(LAST_DIRECTORY_KEY, await window.tet.projects.directoryToRemember(picked));
      onChange(picked);
    }
  };
  const textMenu = useTextContextMenu(onChange);
  return (
    <FieldRow>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        readOnly={pickedOnly}
        title={pickedOnly ? value : undefined}
        onChange={(event) => onChange(event.target.value)}
        onContextMenu={textMenu.onContextMenu}
      />
      {textMenu.menu}
      <button type="button" className="button secondary" onClick={() => void browse()}>
        Browse...
      </button>
    </FieldRow>
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
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** `password` for a secret entered once and never shown again; `date` for one picked or typed as
   *  YYYY-MM-DD, empty for none. */
  type?: "text" | "password" | "date";
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  /** The field a refusal returns the focus to. */
  ref?: Ref<HTMLInputElement>;
  /** See `Field`. */
  error?: string;
}

/** A `Field` holding the one-line input the dialogs' fields are built from. */
export function TextField({ label, value, onChange, type = "text", placeholder, maxLength, disabled, ref, error }: TextFieldProps) {
  const textMenu = useTextContextMenu(onChange);
  return (
    <Field label={label} error={error}>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onContextMenu={textMenu.onContextMenu}
        ref={ref}
      />
      {textMenu.menu}
    </Field>
  );
}

interface TextAreaFieldProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The layout storage key the height the user drags the box to is kept under (`useStoredHeight`). */
  sizeKey: string;
  /** See `Field`. */
  error?: string;
}

/** A `Field` holding a box for several lines of text, e.g. a note. */
export function TextAreaField({ label, value, onChange, disabled, sizeKey, error }: TextAreaFieldProps) {
  const textMenu = useTextContextMenu(onChange);
  const sized = useStoredHeight(sizeKey);
  return (
    <Field label={label} error={error}>
      <textarea
        className="dialog-textarea"
        ref={sized}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onContextMenu={textMenu.onContextMenu}
      />
      {textMenu.menu}
    </Field>
  );
}

interface SuggestFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** An async way to fill the field, shown as a button under it, on the right. Why it had none is
   *  said under the field, in `error`'s place, until the next suggestion or keystroke. Without one,
   *  no button. */
  suggestion?: {
    label: string;
    run: () => Promise<SuggestionResult>;
  };
  /** What shares the button's row, on its left, e.g. a checkbox. */
  beside?: ReactNode;
  disabled?: boolean;
  /** A box of several lines (`dialog-textarea`) in place of one: Enter breaks the line, Ctrl+Enter
   *  (Cmd on the Mac) answers the dialog. */
  multiline?: boolean;
  /** With `multiline`: the layout storage key the height the user drags the box to is kept under
   *  (`useStoredHeight`). */
  sizeKey?: string;
  /** The field a dialog opens focused (`PromptFields.field`). Stable, as that one is. */
  ref?: RefCallback<HTMLInputElement | HTMLTextAreaElement>;
  /** See `Field`. */
  error?: string;
  /** Told while a suggestion is fetched, for the dialog to hold its answer back (`PromptFields`).
   *  Stable, as a state setter is. */
  onSuggesting?: (suggesting: boolean) => void;
}

/** A text field with a button under it that fills it, e.g. a model's commit message. */
export function SuggestField({
  label,
  value,
  onChange,
  suggestion,
  beside,
  disabled,
  multiline,
  sizeKey,
  ref,
  error,
  onSuggesting,
}: SuggestFieldProps) {
  const { busy: suggesting, run } = useBusy();
  const [refused, setRefused] = useState<string>();
  const textMenu = useTextContextMenu(onChange);
  const sized = useStoredHeight(multiline ? sizeKey : undefined);
  useEffect(() => onSuggesting?.(suggesting), [suggesting, onSuggesting]);
  // Refocused once a suggestion arrives; handed on to the dialog's own and the stored height's.
  const box = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const boxRef = useCallback(
    (element: HTMLInputElement | HTMLTextAreaElement | null) => {
      box.current = element;
      ref?.(element);
      sized(element instanceof HTMLTextAreaElement ? element : null);
    },
    [ref, sized],
  );

  const suggest = async (): Promise<void> => {
    if (suggesting || !suggestion) {
      return;
    }
    setRefused(undefined);
    await run(async () => {
      try {
        const result = await suggestion.run();
        const suggested = result.value?.trim() ?? "";
        if (suggested.length > 0) {
          onChange(suggested);
          requestAnimationFrame(() => {
            box.current?.focus();
            box.current?.select();
          });
        }
        setRefused(result.error);
      } catch (failure) {
        setRefused(`Could not suggest a value: ${errorMessage(failure)}`);
      }
    });
  };

  const typed = {
    value,
    disabled: disabled || suggesting,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setRefused(undefined);
      onChange(event.target.value);
    },
    onContextMenu: textMenu.onContextMenu,
    ref: boxRef,
  };
  return (
    <>
      <Field label={label} error={refused ?? error}>
        {multiline ? (
          <textarea
            className="dialog-textarea"
            {...typed}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isModifierHeld(event)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        ) : (
          <input type="text" {...typed} />
        )}
        {textMenu.menu}
      </Field>
      {/* Outside the field's label, which would forward a click on `beside` to the box; while
          suggesting, the dialog's bar runs (`onSuggesting`). */}
      {(beside || suggestion) && (
        <FieldRow className="dialog-suggest-row">
          {beside}
          {suggestion && (
            <button
              type="button"
              className="button secondary dialog-suggest"
              disabled={disabled || suggesting}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void suggest()}
            >
              {suggestion.label}
            </button>
          )}
        </FieldRow>
      )}
    </>
  );
}

interface ColorFieldProps {
  label: string;
  /** Each choice's answer and the color it is drawn in — an ANSI name and its
   *  `--tet-terminal-ansi*` variable, so the swatches follow the theme. */
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
  /** A node, not a string: the SBX switch carries a description under its title. */
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A checkbox with its label beside it; the box itself is drawn by TET, never by Chrome. */
export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <label className="dialog-checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
