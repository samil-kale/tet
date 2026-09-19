import { memo, useEffect, useRef, useState } from "react";
import type { Project, RepositoryState } from "../../shared/types";
import { Explorer, useExplorerListing, type ExplorerHandle } from "./Explorer";
import { useFileAct } from "./use-file-act";
import { CollapseAllIcon, NewFileIcon, NewFolderIcon } from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

interface FilesPaneProps {
  project: Project;
  /** Its changes trigger listing re-reads — a file starting or stopping to exist. */
  state: RepositoryState;
  /** False while the git view stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  /** The active editor tab's file — the tree reveals it. */
  openPath: string | null;
  /** Opens in the project's preview tab, or kept (`editor-tab.ts`); a Markdown file with its
   *  preview if asked. */
  onOpen: (path: string, keep?: boolean, markdownPreview?: boolean) => void;
}

/** The listing is re-read on every show and usually lands in milliseconds; no flashing bar. */
const PROGRESS_DELAY_MS = 500;

/** `active` once it has held for `delayMs`; false the moment it ends. */
function useDelayed(active: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!active) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && delayed;
}

/**
 * The side pane's files view, shown instead of the git view (VS Code's Explorer and Source Control,
 * one sidebar). The listing is read only while on screen.
 */
export const FilesPane = memo(function FilesPane({ project, state, shown, openPath, onOpen }: FilesPaneProps) {
  const { acting, act } = useFileAct(project.id);
  const { explorerListing, listing, refreshExplorer } = useExplorerListing(project.id, state.changes, shown);
  const explorerRef = useRef<ExplorerHandle>(null);
  const showProgress = useDelayed(listing || acting, PROGRESS_DELAY_MS);

  return (
    <div className={`side-pane-content${shown ? "" : " hidden"}`}>
      <div className="section grows">
        <div className="section-header">
          <span>
            EXPLORER{" "}
            {explorerListing && <span className="count-badge">({explorerListing.files.length})</span>}
          </span>
          <span className="section-header-actions">
            <button
              className="icon-button"
              title="New File..."
              disabled={acting || !explorerListing}
              onClick={() => explorerRef.current?.newFile()}
            >
              <NewFileIcon />
            </button>
            <button
              className="icon-button"
              title="New Folder..."
              disabled={acting || !explorerListing}
              onClick={() => explorerRef.current?.newFolder()}
            >
              <NewFolderIcon />
            </button>
            <button
              className="icon-button"
              title="Collapse Folders in Explorer"
              disabled={!explorerListing}
              onClick={() => explorerRef.current?.collapseAll()}
            >
              <CollapseAllIcon />
            </button>
          </span>
          {/* This pane's one bar — the listing and the tree's edits. */}
          {showProgress && <ProgressBar />}
        </div>
        {/* Keyed by project: fold and filter state is keyed by paths that repeat across repositories. */}
        <Explorer
          key={project.id}
          ref={explorerRef}
          project={project}
          files={explorerListing}
          shown={shown}
          selected={openPath}
          onOpen={onOpen}
          act={act}
          onExplorerChanged={refreshExplorer}
        />
      </div>
    </div>
  );
});
