import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { GitActionResult } from "../../shared/types";
import { DialogFrame, useSubmit } from "./DialogFrame";
import { Checkbox, TextField } from "./Field";
import { notify } from "./Notices";
import { createStore, useStore } from "./store";

interface ConfirmOptions {
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

interface ConfirmAnswer {
  confirmed: boolean;
  /** Whether the checkbox was ticked; always false when the question had none. */
  checked: boolean;
}

/** What a question's fields are drawn from (`PromptOptions.render`). */
export interface PromptFields<T> {
  value: T;
  onChange: (value: T) => void;
  /** What `submit` refused, for the field it was typed in (`Field`'s `error`); cleared by the next
   *  change (`useSubmit`). */
  error: string | undefined;
  /** `submit` is underway: the field it may refuse is disabled meanwhile. */
  busy: boolean;
  /** For the field a refusal returns the focus to; the dialog opens on it, selected
   *  (`DialogFrame`'s `selectField`). */
  field: RefObject<HTMLInputElement | null>;
  /** A field still fetching its value (`SuggestField`'s wand) holds the answer back meanwhile, and
   *  runs the frame's bar. */
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
  /** Cuts short what a field runs (`hold`), so Cancel is not held back by it: a suggestion changes
   *  nothing. Left out, Cancel waits for it like for `submit` (`DialogFrame`'s `abort`). */
  abort?: () => void;
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

/**
 * Whether a follow-up — a question asked once a command came back (a rebase that rewrites pushed
 * commits, a login) — is held back by another question up, which a new one would not be: then
 * `told`, what it was about, is a notice instead.
 */
export function followUpHeldBack(told: string): boolean {
  if (pending.get() === null) {
    return false;
  }
  notify("error", told);
  return true;
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

/** Whether the user went through, for a question without a checkbox. */
export async function confirmed(options: Omit<ConfirmOptions, "checkboxLabel">): Promise<boolean> {
  return (await confirm(options)).confirmed;
}

/** `confirmed` as a follow-up (`followUpHeldBack`): false, `told` notified, when not asked. */
export async function confirmedFollowUp(options: Omit<ConfirmOptions, "checkboxLabel">, told: string): Promise<boolean> {
  return !followUpHeldBack(told) && (await confirmed(options));
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

/** What a result refused, in its own words, for `submit` to hand back; `fallback` where the main
 *  process gave none. */
export function refusal(result: GitActionResult, fallback: string): string | undefined {
  return result.ok ? undefined : (result.error ?? fallback);
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

interface NameOptions {
  title: string;
  detail?: string;
  confirmLabel: string;
  /** The name as it stands, for a rename: handed back unchanged it is done, nothing run. Left out
   *  for a new one. */
  current?: string;
  maxLength?: number;
  /** Runs the name typed, trimmed (`PromptOptions.submit`). */
  submit: (name: string) => Promise<string | undefined>;
}

/** The question every create and rename asks: one name, required and trimmed. */
export async function askName({ title, detail, confirmLabel, current, maxLength, submit }: NameOptions): Promise<void> {
  await prompt({
    title,
    detail,
    confirmLabel,
    value: current ?? "",
    ready: filled,
    render: singleField("Name", maxLength),
    submit: (typed) => {
      const name = typed.trim();
      return name === current ? Promise.resolve(undefined) : submit(name);
    }
  });
}

function ConfirmDialog({ dialog }: { dialog: Extract<Pending, { kind: "confirm" }> }) {
  const [checked, setChecked] = useState(false);
  const { busy: running, submit } = useSubmit(
    async () => {
      await dialog.submit?.(checked);
      return undefined;
    },
    () => dialog.answer({ confirmed: true, checked })
  );

  return (
    <DialogFrame
      header={{ title: dialog.title }}
      busy={running}
      onCancel={dialog.cancel}
      primary={{ label: dialog.confirmLabel, run: () => void submit() }}
    >
      <p className="dialog-message">{dialog.message}</p>
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
      {dialog.checkboxLabel && <Checkbox label={dialog.checkboxLabel} checked={checked} onChange={setChecked} />}
    </DialogFrame>
  );
}

function PromptDialog({ dialog }: { dialog: Extract<Pending, { kind: "prompt" }> }) {
  const [value, setValue] = useState(dialog.value);
  const [held, setHeld] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  /** What `submit` refused is handed to the fields (`error`). */
  const { busy: running, refused, submit, changing } = useSubmit(
    async () => (dialog.submit ? dialog.submit(value) : undefined),
    () => dialog.answer(value)
  );
  // Back to the field refused, once the run no longer disables it.
  useEffect(() => {
    if (refused !== undefined) {
      field.current?.focus();
    }
  }, [refused]);

  const onChange = changing((next: unknown) => setValue(next));

  return (
    <DialogFrame
      header={{ title: dialog.title }}
      busy={running || held}
      locked={running || (held && !dialog.abort)}
      onCancel={dialog.cancel}
      abort={dialog.abort}
      // Plain to see why it waits: a field left empty (AGENTS.md's exception to a blocked reason).
      primary={{ label: dialog.confirmLabel, disabled: held || !dialog.ready(value), run: () => void submit() }}
      selectField
    >
      {dialog.render({ value, onChange, error: refused, busy: running, field, hold: setHeld })}
      {dialog.detail && <p className="dialog-detail">{dialog.detail}</p>}
    </DialogFrame>
  );
}

/** Mounted once, next to `Notices`. */
export function Dialogs() {
  const dialog = useStore(pending);

  if (!dialog) {
    return null;
  }
  return dialog.kind === "confirm" ? <ConfirmDialog dialog={dialog} /> : <PromptDialog dialog={dialog} />;
}
