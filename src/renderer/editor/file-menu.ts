import type { ProjectRef } from "../../shared/types/project";
import type { ResolvedRef } from "../resolved-ref";
import type { OpenEditor } from "./editor-tab";
import { absolutePath, PLATFORM } from "../platform";
import { SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { isMarkdown } from "./diff-highlight";
import { previewWithheldAt } from "./editor-views";

/** What a file's menu offers after its own "Open", in the Explorer and the changes list alike:
 *  the Markdown preview through `open`, then the external editor. `enabled` is false where the
 *  menu covers several files; `diff` says whether `open` shows the file against HEAD, which
 *  withholds the preview (`previewWithheldAt`). */
export function openEntries(
  ref: ProjectRef,
  path: string,
  enabled: boolean,
  diff: boolean,
  open: (how: OpenEditor) => void,
): ContextMenuEntry[] {
  const previewEnabled = enabled && !previewWithheldAt(ref, path, diff);
  return [
    ...(isMarkdown(path)
      ? [{ label: "Open Markdown Preview", run: previewEnabled ? () => open({ markdownPreview: true }) : undefined }]
      : []),
    {
      label: "Open in external editor",
      run: enabled ? () => void window.tet.shell.openFileExternally(ref, path) : undefined,
    },
  ];
}

/** A file menu's closing group: reveal one path, copy all of them. `noun` names what is copied
 *  ("file path", or "path" for a folder); the repository root has no relative path. */
export function pathEntries(resolved: ResolvedRef, paths: string[], noun: string): ContextMenuEntry[] {
  const plural = paths.length === 1 ? "" : "s";
  return [
    SEPARATOR,
    {
      label: PLATFORM.revealLabel,
      run: paths.length === 1 ? () => void window.tet.shell.revealFile(resolved.ref, paths[0]) : undefined,
    },
    {
      label: `Copy ${noun}${plural}`,
      run: () => void navigator.clipboard.writeText(paths.map((entry) => absolutePath(resolved.path, entry)).join("\n")),
    },
    ...(paths.includes("")
      ? []
      : [
          {
            label: `Copy relative ${noun}${plural}`,
            run: () => void navigator.clipboard.writeText(paths.join("\n")),
          },
        ]),
  ];
}
