import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ProjectRef } from "../../shared/types/project";
import { ImageView } from "./ImageView";
import { isMarkdown } from "./diff-highlight";
import {
  attachEditor,
  attachMarkdownPreview,
  diffShown,
  editorKind,
  focusEditor,
  getEditorSnapshot,
  hasChanges,
  isReadOnly,
  previewWithheld,
  saveEditorFile,
  setDiffOption,
  showDiff,
  showMarkdownPreview,
  subscribeEditor,
  subscribeRefEditors,
  type EditorSnapshot,
} from "./editor-views";
import { isEditorTab, type PaneTab } from "./editor-tab";
import { IconButton } from "../ui/IconButton";
import { CollapseAllIcon, CompareIcon, ExpandAllIcon, SaveIcon, SideBySideIcon, ViewIcon } from "../ui/icons";
import { useStoredShare } from "../ui/layout-storage";
import { useElementSize } from "../ui/use-element-size";
import { MIN_AREA_WIDTH, Sash } from "../ui/Sash";
import { isModifierHeld, PLATFORM } from "../platform";

function useEditorStore<T>(tabId: string, select: (snapshot: EditorSnapshot) => T): T {
  const subscribe = useCallback((listener: () => void) => subscribeEditor(tabId, listener), [tabId]);
  return useSyncExternalStore(subscribe, () => select(getEditorSnapshot(tabId)));
}

const whole = (snapshot: EditorSnapshot): EditorSnapshot => snapshot;
const busy = (snapshot: EditorSnapshot): boolean => snapshot.loading || snapshot.building || snapshot.saving;
const preview = (snapshot: EditorSnapshot): boolean => snapshot.preview;

/** Whether the tab is the preview tab — the tab strip's italics. */
export function useEditorPreview(tabId: string): boolean {
  return useEditorStore(tabId, preview);
}

/**
 * Any editor tab among `tabs` reading, building or saving — shown by the progress bar of the pane
 * holding them. One subscription for the repository or worktree: a pane's tabs come and go, and
 * hooks can't follow them.
 */
export function useEditorBusy(ref: ProjectRef, tabs: PaneTab[]): boolean {
  const subscribe = useCallback((listener: () => void) => subscribeRefEditors(ref, listener), [ref]);
  return useSyncExternalStore(subscribe, () => tabs.some((tab) => isEditorTab(tab) && busy(getEditorSnapshot(tab.tabId))));
}

interface EditorHostProps {
  tabId: string;
  /** On screen in its pane; otherwise hidden but laid out. */
  active: boolean;
  /** The repository or worktree is the one selected. */
  visible: boolean;
  /** In the repository's or worktree's focused pane, which gets keyboard focus. */
  focused: boolean;
}

/**
 * The editor tab: a bar naming the file, then the editor, diff or plain — a Markdown file's
 * preview beside it — the image view or a placeholder, all drawn off the editor's snapshot. The editor and the
 * preview live outside React in `editor-views.ts`, each attached to a childless frame; on a pane
 * move React removes a frame with it inside, and the next host's attach takes it out again.
 */
export const EditorHost = memo(function EditorHost({ tabId, active, visible, focused }: EditorHostProps) {
  const snapshot = useEditorStore(tabId, whole);
  const { path, file, building, saving, dirty, diff, markdownPreview, sideBySide, unchangedCollapsed } = snapshot;
  const frame = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null);
  const markdownPreviewFrame = useRef<HTMLDivElement>(null);
  const kind = editorKind(file);
  const shown = diffShown(snapshot);
  const layoutAvailable = kind === "text" ? shown : kind === "image" && Boolean(file?.head?.image && file.image);
  const withheld = previewWithheld(snapshot);
  const markdownPreviewShown = markdownPreview && !withheld;

  useEffect(() => {
    if (frame.current) {
      attachEditor(tabId, frame.current);
    }
  }, [tabId, path]);

  useEffect(() => {
    if (markdownPreviewShown && markdownPreviewFrame.current) {
      attachMarkdownPreview(tabId, markdownPreviewFrame.current);
    }
  }, [tabId, path, markdownPreviewShown]);

  // As `TerminalHost`'s focus rule: the focused pane's active tab, once the file is in the editor.
  const ready = kind === "text" && !building;
  useEffect(() => {
    if (visible && active && focused && ready) {
      focusEditor(tabId);
    }
  }, [visible, active, focused, ready, tabId, path]);

  // One share for every tab's Markdown preview, as for the split view's panes; half until dragged.
  const [markdownPreviewShare, setMarkdownPreviewShare] = useStoredShare("markdown-preview", 1 / 2);
  const splitWidth = useElementSize(split, markdownPreviewShown)?.width ?? 0;
  const markdownPreviewWidth = Math.round(splitWidth * markdownPreviewShare);
  const resizeMarkdownPreview = useCallback(
    (width: number) => {
      if (splitWidth > 0) {
        setMarkdownPreviewShare(width / splitWidth);
      }
    },
    [setMarkdownPreviewShare, splitWidth],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Only keys nothing inside claimed arrive, so the editor's own Ctrl+S never saves twice.
    if (isModifierHeld(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveEditorFile(tabId);
    }
  };

  return (
    <div className={`editor-tab${active ? "" : " hidden"}`} onKeyDown={onKeyDown}>
      <div className="editor-bar">
        {/* Always there, so the path doesn't shift for a read-only file. */}
        <div className="editor-bar-actions">
          <IconButton
            title={`Save (${PLATFORM.modifierLabel}+S)`}
            disabled={isReadOnly(file) || !dirty || saving}
            onClick={() => void saveEditorFile(tabId)}
          >
            <SaveIcon />
          </IconButton>
          {/* The file against HEAD, or on its own in a plain editor — a diff only a text file with
              changes has; without any it shows off and comes back with them (`diffShown`). */}
          <IconButton
            active={shown}
            title={`${shown ? "Hide" : "Show"} Changes`}
            disabled={kind !== "text" || !hasChanges(snapshot)}
            onClick={() => showDiff(tabId, !diff)}
          >
            <CompareIcon />
          </IconButton>
          {/* The diff's layout: disabled, not hidden, without one, so the path doesn't shift. An image
              has one when both versions exist: next to each other, or the current one alone. */}
          <IconButton
            active={layoutAvailable && sideBySide}
            title={sideBySide ? "Show Inline" : "Show Side by Side"}
            disabled={!layoutAvailable}
            onClick={() => setDiffOption(tabId, "sideBySide", !sideBySide)}
          >
            <SideBySideIcon />
          </IconButton>
          <IconButton
            title={unchangedCollapsed ? "Expand Unchanged Regions" : "Collapse Unchanged Regions"}
            disabled={!shown || kind !== "text"}
            onClick={() => setDiffOption(tabId, "unchangedCollapsed", !unchangedCollapsed)}
          >
            {unchangedCollapsed ? <ExpandAllIcon /> : <CollapseAllIcon />}
          </IconButton>
          {/* Disabled beside a diff, which withholds the Markdown preview (`previewWithheld`). */}
          {isMarkdown(path) && (
            <IconButton
              active={markdownPreviewShown}
              title={`${markdownPreviewShown ? "Hide" : "Show"} Markdown Preview (${PLATFORM.modifierLabel}+Shift+V)`}
              disabled={withheld}
              onClick={() => showMarkdownPreview(tabId, !markdownPreviewShown)}
            >
              <ViewIcon />
            </IconButton>
          )}
        </div>
        {dirty && <span className="editor-dirty">●</span>}
        <span className="editor-path">{path}</span>
      </div>
      <div className="editor-body">
        {/* Why is the notice's (editor-views.ts); the tab says only what it is, like the rest. */}
        {kind === "error" && <div className="placeholder">Could not read the file.</div>}
        {kind === "image" && <ImageView image={{ before: file?.head?.image, after: file?.image }} sideBySide={sideBySide} />}
        {kind === "binary" && <div className="placeholder">Binary file.</div>}
        {kind === "tooLarge" && <div className="placeholder">File too large to edit.</div>}
        {/* Hidden, not unmounted, so the editor stays attached. */}
        <div ref={split} className={`editor-split${ready ? "" : " hidden"}`}>
          <div ref={frame} className="editor-frame" />
          {markdownPreviewShown && (
            <>
              <Sash
                orientation="vertical"
                size={markdownPreviewWidth}
                min={MIN_AREA_WIDTH}
                minOther={MIN_AREA_WIDTH}
                reverse
                onResize={resizeMarkdownPreview}
              />
              {/* As the editor's frame: the Markdown preview lives in `editor-views.ts`. */}
              <div ref={markdownPreviewFrame} className="markdown-frame" style={{ width: markdownPreviewWidth }} />
            </>
          )}
        </div>
      </div>
    </div>
  );
});
