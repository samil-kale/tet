import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { ImageView } from "./ImageView";
import {
  attachEditor,
  editorKind,
  focusEditor,
  getEditorSnapshot,
  isReadOnly,
  saveEditorFile,
  subscribeEditor,
  type EditorSnapshot
} from "./editor-views";
import { SaveIcon } from "../ui/icons";
import { isMac, isModifierHeld } from "../platform";

function useEditorStore<T>(projectId: string, select: (snapshot: EditorSnapshot) => T): T {
  const subscribe = useCallback((listener: () => void) => subscribeEditor(projectId, listener), [projectId]);
  return useSyncExternalStore(subscribe, () => select(getEditorSnapshot(projectId)));
}

const whole = (snapshot: EditorSnapshot): EditorSnapshot => snapshot;
const busy = (snapshot: EditorSnapshot): boolean => snapshot.loading || snapshot.building || snapshot.saving;

/** Reading, building or saving — shown by the progress bar of the pane holding the editor tab. */
export function useEditorBusy(projectId: string): boolean {
  return useEditorStore(projectId, busy);
}

interface EditorHostProps {
  projectId: string;
  /** On screen in its pane; otherwise hidden but laid out. */
  active: boolean;
  /** The project is the one selected. */
  visible: boolean;
  /** In the project's focused pane, which gets keyboard focus. */
  focused: boolean;
}

/**
 * The editor tab: a bar naming the file, then the diff editor, the image view or a placeholder —
 * all drawn off the editor's snapshot. The editor lives outside React in `editor-views.ts` and is attached to a childless frame; on a pane move React
 * removes the frame with it inside, and the next host's attach takes it out again.
 */
export const EditorHost = memo(function EditorHost({ projectId, active, visible, focused }: EditorHostProps) {
  const { path, file, building, saving, dirty } = useEditorStore(projectId, whole);
  const frame = useRef<HTMLDivElement>(null);
  const kind = editorKind(file);

  useEffect(() => {
    if (frame.current) {
      attachEditor(projectId, frame.current);
    }
  }, [projectId, path]);

  // As `Pane`'s terminal focus rule: the focused pane's active tab, once the file is in the editor.
  const ready = kind === "text" && !building;
  useEffect(() => {
    if (visible && active && focused && ready) {
      focusEditor(projectId);
    }
  }, [visible, active, focused, ready, projectId, path]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Only keys nothing inside claimed arrive, so the editor's own Ctrl+S never saves twice.
    if (isModifierHeld(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveEditorFile(projectId);
    }
  };

  return (
    <div className={`editor-tab${active ? "" : " hidden"}`} onKeyDown={onKeyDown}>
      <div className="editor-bar">
        {/* Always there, so the path doesn't shift for a read-only file. */}
        <div className="editor-bar-actions">
          <button
            className="icon-button"
            title={`Save (${isMac() ? "⌘" : "Ctrl"}+S)`}
            disabled={isReadOnly(file) || !dirty || saving}
            onClick={() => void saveEditorFile(projectId)}
          >
            <SaveIcon />
          </button>
        </div>
        {dirty && <span className="editor-dirty">●</span>}
        <span className="editor-path">{path}</span>
      </div>
      <div className="editor-body">
        {kind === "error" && <div className="placeholder">{file?.error}</div>}
        {kind === "image" && <ImageView image={{ before: file?.head?.image, after: file?.image }} />}
        {kind === "binary" && <div className="placeholder">Binary file.</div>}
        {kind === "tooLarge" && <div className="placeholder">File too large to edit.</div>}
        {/* Hidden, not unmounted, so the editor stays attached. */}
        <div ref={frame} className={`editor-frame${ready ? "" : " hidden"}`} />
      </div>
    </div>
  );
});
