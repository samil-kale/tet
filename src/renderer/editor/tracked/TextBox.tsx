import { useRef, useLayoutEffect, type ComponentType, Fragment, useState } from "react";
import { createMarkdownPreview, resolveLink, renderHtmlInto } from "../markdown";
import type { TextRendering, TextWriting } from "./tracked-actions";
import { trackedFileLink, trackedLink, trackedTextHtml } from "./tracked-text";
import {
  type IconProps,
  HeadingIcon,
  BoldIcon,
  ItalicIcon,
  QuoteIcon,
  CodeIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListChecksIcon,
  PaperclipIcon,
} from "../../ui/icons";
import { markdownEdit, type MarkdownFormat } from "../markdown-format";
import { IconButton } from "../../ui/IconButton";
import { SwitchTabs } from "../../ui/SwitchTabs";
import { useTextContextMenu } from "../../ui/use-text-context-menu";

/** Text written on the tracker, rendered in a shadow root of its own as the Markdown preview's is
 *  (`trackedTextHtml`), before the card's first paint. A link to a file of the repository opens it; the
 *  rest go to `openLink`. `text` is the Markdown as written. */
export function TrackedText({ text, provider, issueUrl, loadImage, openFile, openLink }: TextRendering & { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const { scroller, body } = createMarkdownPreview();
    body.classList.add("compact");
    scroller.addEventListener("click", (event) => {
      const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
      if (link) {
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        const file = trackedFileLink(href, issueUrl);
        const path = file === undefined ? undefined : resolveLink("", file);
        const target = trackedLink(href, issueUrl);
        if (path !== undefined) {
          openFile(path);
        } else if (target !== undefined) {
          openLink(target);
        }
      }
    });
    host.current?.replaceChildren(scroller);
    renderHtmlInto(body, trackedTextHtml(text, provider, issueUrl), loadImage).catch((error: unknown) =>
      console.warn("[TET] An issue's text failed to render:", error),
    );
  }, [text, provider, issueUrl, loadImage, openFile, openLink]);
  return <div ref={host} className="markdown-text" />;
}

export const BOX_TABS = [
  { id: "write", label: "Write" },
  { id: "preview", label: "Preview" },
] as const;

/** The buttons above a text box, each a format of its selection. */
export const BOX_FORMATS: { format: MarkdownFormat; title: string; Icon: ComponentType<IconProps> }[] = [
  { format: "heading", title: "Heading", Icon: HeadingIcon },
  { format: "bold", title: "Bold", Icon: BoldIcon },
  { format: "italic", title: "Italic", Icon: ItalicIcon },
  { format: "quote", title: "Quote", Icon: QuoteIcon },
  { format: "code", title: "Code", Icon: CodeIcon },
  { format: "link", title: "Link", Icon: LinkIcon },
  { format: "bullets", title: "Bulleted List", Icon: ListIcon },
  { format: "numbers", title: "Numbered List", Icon: ListOrderedIcon },
  { format: "tasks", title: "Task List", Icon: ListChecksIcon },
];

/** The box text for the tracker is typed into, with a preview of it as the tracker will show it: with
 *  `upload`, a file picked, pasted or dropped is uploaded at once, its Markdown following what stands
 *  there. */
export function TextBox({
  label,
  value,
  onChange,
  disabled,
  writing: { rendering, upload, accept },
  height,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  writing: TextWriting;
  /** The box's and its preview's least height, in px; absent takes `--text-box-height`. */
  height?: number;
}) {
  const textMenu = useTextContextMenu(onChange);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // What the textarea was dragged to, kept across the switch to the preview, which unmounts it.
  const [dragged, setDragged] = useState<number>();
  const switchTo = (preview: boolean): void => {
    if (preview && field.current) {
      setDragged(field.current.offsetHeight);
    }
    setPreviewing(preview);
  };
  const format = (kind: MarkdownFormat): void => {
    const area = field.current;
    if (!area) {
      return;
    }
    const edit = markdownEdit(kind, area.value, area.selectionStart, area.selectionEnd);
    area.focus();
    area.setSelectionRange(edit.from, edit.to);
    // Typed in, as the textarea's own undo takes it back; the change reaches `onChange` as typing's
    // does. Nothing else edits a textarea into its undo history.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    document.execCommand("insertText", false, edit.insert);
    area.setSelectionRange(...edit.select);
  };
  const attach = async (files: File[]): Promise<void> => {
    setUploading(true);
    let next = value;
    for (const file of files) {
      const markdown = await upload?.(file);
      if (markdown !== undefined) {
        next = `${next}${next === "" || next.endsWith("\n") ? "" : "\n"}${markdown}\n`;
      }
    }
    onChange(next);
    setUploading(false);
  };
  const busy = disabled || uploading;
  return (
    <div
      style={height === undefined ? undefined : ({ "--text-box-height": `${height}px` } as React.CSSProperties)}
      onDragOver={(event) => {
        if (upload && !busy && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        if (upload && !busy && files.length > 0) {
          event.preventDefault();
          void attach(files);
        }
      }}
    >
      <div className="text-box-tabs">
        <SwitchTabs tabs={BOX_TABS} active={previewing ? "preview" : "write"} onSelect={(id) => switchTo(id === "preview")} locked={busy} />
        {!previewing && (
          <div className="toolbar text-box-tools">
            {BOX_FORMATS.map(({ format: kind, title, Icon }) => (
              <Fragment key={kind}>
                <IconButton
                  title={title}
                  disabled={busy}
                  // The focus stays in the textarea, whose selection is what the format reads.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => format(kind)}
                >
                  <Icon />
                </IconButton>
                {kind === "link" && <span className="text-box-separator" />}
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {previewing ? (
        <div className="text-box-preview" style={{ minHeight: dragged }}>
          {value.trim() === "" ? <div className="tracked-empty">Nothing to preview</div> : <TrackedText {...rendering} text={value} />}
        </div>
      ) : (
        <textarea
          ref={field}
          aria-label={label}
          placeholder="Use Markdown to format your text"
          style={{ height: dragged }}
          value={value}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          onContextMenu={textMenu.onContextMenu}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (upload && files.length > 0) {
              event.preventDefault();
              void attach(files);
            }
          }}
        />
      )}
      {textMenu.menu}
      {upload && (
        <>
          <input
            ref={picker}
            type="file"
            accept={accept}
            multiple
            hidden
            onChange={(event) => {
              void attach([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <button type="button" className="text-box-attach" disabled={busy} onClick={() => picker.current?.click()}>
            <PaperclipIcon className="line-icon" />
            Paste, drop, or click to add {accept === undefined ? "files" : "images"}
          </button>
        </>
      )}
    </div>
  );
}
