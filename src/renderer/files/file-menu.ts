import type { CheckoutRef } from "../../shared/types";
import type { Checkout } from "../checkout";
import type { OpenEditor } from "../terminal/editor-tab";
import { absolutePath, revealLabel } from "../platform";
import { SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { isMarkdown } from "../diff/diff-highlight";

/** What a file's menu offers after its own "Open", in the Explorer and the changes list alike:
 *  the Markdown preview through `open`, then the external editor. `enabled` is false where the
 *  menu covers several files. */
export function openEntries(
  checkout: CheckoutRef,
  path: string,
  enabled: boolean,
  open: (how: OpenEditor) => void
): ContextMenuEntry[] {
  return [
    ...(isMarkdown(path)
      ? [{ label: "Open Preview", run: enabled ? () => open({ markdownPreview: true }) : undefined }]
      : []),
    {
      label: "Open in external editor",
      run: enabled ? () => void window.tet.shell.openFileExternally(checkout, path) : undefined
    }
  ];
}

/** A file menu's closing group: reveal one path, copy all of them. `noun` names what is copied
 *  ("file path", or "path" for a folder); the repository root has no relative path. */
export function pathEntries(checkout: Checkout, paths: string[], noun: string): ContextMenuEntry[] {
  const plural = paths.length === 1 ? "" : "s";
  return [
    SEPARATOR,
    {
      label: revealLabel(),
      run: paths.length === 1 ? () => void window.tet.shell.revealFile(checkout.ref, paths[0]) : undefined
    },
    {
      label: `Copy ${noun}${plural}`,
      run: () => void navigator.clipboard.writeText(paths.map((entry) => absolutePath(checkout.path, entry)).join("\n"))
    },
    ...(paths.includes("")
      ? []
      : [
          {
            label: `Copy relative ${noun}${plural}`,
            run: () => void navigator.clipboard.writeText(paths.join("\n"))
          }
        ])
  ];
}
