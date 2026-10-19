import type { ReactNode } from "react";
import { SEPARATOR, useContextMenu } from "./ContextMenu";

type TextInput = HTMLInputElement | HTMLTextAreaElement;

function selection(element: TextInput): [start: number, end: number] {
  return [element.selectionStart ?? element.value.length, element.selectionEnd ?? element.value.length];
}

async function copy(element: TextInput): Promise<void> {
  const [start, end] = selection(element);
  if (start !== end) {
    await navigator.clipboard.writeText(element.value.slice(start, end));
  }
}

/** Replaces the selection with `text` as typing it would, through the field's own controlled
 *  value; the cursor follows once that re-render settles. */
function replaceSelection(element: TextInput, onChange: (value: string) => void, text: string): void {
  const [start, end] = selection(element);
  onChange(element.value.slice(0, start) + text + element.value.slice(end));
  const cursor = start + text.length;
  requestAnimationFrame(() => element.setSelectionRange(cursor, cursor));
}

async function cut(element: TextInput, onChange: (value: string) => void): Promise<void> {
  const [start, end] = selection(element);
  await navigator.clipboard.writeText(element.value.slice(start, end));
  replaceSelection(element, onChange, "");
}

async function paste(element: TextInput, onChange: (value: string) => void): Promise<void> {
  replaceSelection(element, onChange, await navigator.clipboard.readText());
}

/**
 * The Cut/Copy/Paste/Select All menu a plain text field or textarea opens on a right click, since
 * Electron shows none of its own. `onChange` is the field's own, so Cut and Paste go through its
 * controlled value exactly as typing would. `onContextMenu` reads the field off `event.target`, so
 * it also works attached above a third-party textarea (`CodeField`) rather than on it directly.
 */
export function useTextContextMenu(onChange: (value: string) => void): {
  onContextMenu: (event: React.MouseEvent) => void;
  menu: ReactNode;
} {
  const context = useContextMenu<TextInput>();
  return {
    onContextMenu: (event) => {
      // `CodeField` attaches this above a third-party textarea, so a right click elsewhere in it
      // (its padding) is no field to open the menu on.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        context.open(event, event.target);
      }
    },
    menu: context.render((element) => {
      const [start, end] = selection(element);
      const editable = !element.readOnly;
      return [
        { label: "Cut", run: editable && start !== end ? () => void cut(element, onChange) : undefined },
        { label: "Copy", run: start !== end ? () => void copy(element) : undefined },
        { label: "Paste", run: editable ? () => void paste(element, onChange) : undefined },
        SEPARATOR,
        { label: "Select All", run: () => element.select() },
      ];
    }),
  };
}
