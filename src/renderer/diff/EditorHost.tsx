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

function useEditorStore<T>(projectId: string, select: (snapshot: EditorSnapshot) => T): T {
  const subscribe = useCallback((listener: () => void) => subscribeEditor(projectId, listener), [projectId]);
  return useSyncExternalStore(subscribe, () => select(getEditorSnapshot(projectId)));
}

const whole = (snapshot: EditorSnapshot): EditorSnapshot => snapshot;
const busy = (snapshot: EditorSnapshot): boolean => snapshot.loading || snapshot.building || snapshot.saving;

/**
 * Whether the project's editor tab has something underway — reading the file, building the editor,
 * saving. It is what the progress bar of the pane holding that tab shows, as a starting agent is.
 */
export function useEditorBusy(projectId: string): boolean {
  return useEditorStore(projectId, busy);
}

interface EditorHostProps {
  projectId: string;
  /** The one on screen in its pane; otherwise it keeps its layout but stays hidden. */
  active: boolean;
  /** Whether the pane itself is on screen — the project is the one selected. */
  visible: boolean;
  /** The project's focused pane, which is where keyboard focus goes. */
  focused: boolean;
}

/**
 * The editor tab's content: a bar naming the file, and the file — monaco's diff editor, the image
 * view, or a placeholder for what neither can show. The editor itself lives in `editor-views.ts`
 * and is only attached here, to a frame React renders no children into: React removes the frame
 * with it inside on a move between panes, and the next host's attach takes it out again.
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

  // The editor's twin of the terminal's focus rule in `Pane`: only the focused pane's active tab,
  // and once there is an editor with the file in it.
  const ready = kind === "text" && !building;
  useEffect(() => {
    if (visible && active && focused && ready) {
      focusEditor(projectId);
    }
  }, [visible, active, focused, ready, projectId, path]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Reaches here only when nothing inside claimed the key, so the editor's own Ctrl+S never
    // gets this far and there is no double save.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveEditorFile(projectId);
    }
  };

  return (
    <div className={`editor-tab${active ? "" : " hidden"}`} onKeyDown={onKeyDown}>
      <div className="editor-bar">
        {dirty && <span className="editor-dirty">●</span>}
        <span className="editor-path">{path}</span>
        {!isReadOnly(file) && (
          <button
            className="icon-button"
            title="Save (Ctrl+S)"
            disabled={!dirty || saving}
            onClick={() => void saveEditorFile(projectId)}
          >
            <SaveIcon />
          </button>
        )}
      </div>
      <div className="editor-body">
        {kind === "error" && <div className="placeholder">{file?.error}</div>}
        {kind === "image" && <ImageView image={{ before: file?.head?.image, after: file?.image }} />}
        {kind === "binary" && <div className="placeholder">Binary file.</div>}
        {kind === "tooLarge" && <div className="placeholder">File too large to edit.</div>}
        {/* Hidden rather than unmounted while it has nothing to show: the editor stays attached. */}
        <div ref={frame} className={`editor-frame${ready ? "" : " hidden"}`} />
      </div>
    </div>
  );
});
