import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { editedText, editorKind, subscribeEditedText } from "./editor-views";
import { renderMarkdown, resolveLink } from "./markdown";
import { getMarkdownSnapshot, isMarkdown, loadMarkdownImage, openFile, subscribeMarkdown } from "./markdown-views";
import { FilesIcon } from "../ui/icons";

interface MarkdownHostProps {
  projectId: string;
  tabId: string;
  /** On screen in its pane; otherwise hidden but laid out, so the scroll position stays. */
  active: boolean;
}

/**
 * The Markdown preview tab: a bar naming the file, then the rendered file — the editor tab's text
 * while one has it open, unsaved edits included, else the file on disk (`markdown-views.ts`).
 */
export const MarkdownHost = memo(function MarkdownHost({ projectId, tabId, active }: MarkdownHostProps) {
  const subscribe = useCallback((listener: () => void) => subscribeMarkdown(tabId, listener), [tabId]);
  const snapshot = useSyncExternalStore(subscribe, () => getMarkdownSnapshot(tabId));
  const { path, file } = snapshot;
  const edited = useSyncExternalStore(subscribeEditedText, () => editedText(projectId, path));
  const kind = editorKind(file);
  const text = edited ?? (kind === "text" ? file?.content : undefined);
  const body = useRef<HTMLDivElement>(null);

  // The snapshot too: a theme switch republishes it for shiki's colors. A render overtaken is
  // dropped.
  useEffect(() => {
    if (text === undefined) {
      return;
    }
    let current = true;
    void renderMarkdown(text, path, (image) => loadMarkdownImage(tabId, image)).then((doc) => {
      if (current) {
        body.current?.replaceChildren(...doc.body.childNodes);
      }
    });
    return () => {
      current = false;
    };
  }, [text, path, tabId, snapshot]);

  /**
   * Every link is taken here: followed, one would load over the whole window. Web links open in
   * the browser, the repository's Markdown files in a preview, its other files in an editor tab.
   */
  const onLinkClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const link = (event.target as Element).closest("a");
    if (!link) {
      return;
    }
    event.preventDefault();
    if (event.type !== "click") {
      return;
    }
    const href = link.getAttribute("href") ?? "";
    if (/^(https?|mailto):/i.test(href)) {
      void window.tet.shell.openUrl(href);
      return;
    }
    const target = resolveLink(path, href);
    if (target !== undefined) {
      openFile(projectId, target, isMarkdown(target));
    }
  };

  return (
    <div className={`editor-tab${active ? "" : " hidden"}`}>
      <div className="editor-bar">
        <div className="editor-bar-actions">
          <button className="icon-button" title="Open File" onClick={() => openFile(projectId, path, false)}>
            <FilesIcon />
          </button>
        </div>
        <span className="editor-path">{path}</span>
      </div>
      <div className="editor-body">
        {edited === undefined && kind === "error" && <div className="placeholder">{file?.error}</div>}
        {edited === undefined && kind === "tooLarge" && <div className="placeholder">File too large to preview.</div>}
        <div
          ref={body}
          className={`markdown-body${text === undefined ? " hidden" : ""}`}
          onClick={onLinkClick}
          onAuxClick={onLinkClick}
        />
      </div>
    </div>
  );
});
