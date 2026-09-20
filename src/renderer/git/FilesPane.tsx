import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { FileSearchMatch, Project, RepositoryState } from "../../shared/types";
import type { OpenEditor } from "../terminal/editor-tab";
import {
  Explorer,
  FileSearch,
  searchSummary,
  useExplorerListing,
  type ExplorerHandle,
  type FileSearchHandle
} from "./Explorer";
import { useFileAct } from "./use-file-act";
import { useFileSearch } from "./use-file-search";
import { MIN_PANE_HEIGHT, Sash } from "../ui/Sash";
import { ClearIcon, CollapseAllIcon, ExpandAllIcon, NewFileIcon, NewFolderIcon } from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

interface FilesPaneProps {
  project: Project;
  /** Its changes trigger listing re-reads — a file starting or stopping to exist. */
  state: RepositoryState;
  /** False while the git view stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  /** The active editor tab's file — the tree reveals it. */
  openPath: string | null;
  /** Opens in the project's preview tab, or as `how` asks (`editor-tab.ts`) — a search result at
   *  its match. */
  onOpenFile: (projectId: string, path: string, how?: OpenEditor) => void;
  /** Set by the sash between the tree and the search; held by the app, like the branch tree's. */
  searchHeight: number;
  onSearchHeight: (size: number) => void;
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
export const FilesPane = memo(function FilesPane({
  project,
  state,
  shown,
  openPath,
  onOpenFile,
  searchHeight,
  onSearchHeight
}: FilesPaneProps) {
  const { acting, act } = useFileAct(project.id);
  const { explorerListing, listing, refreshExplorer } = useExplorerListing(project.id, state.changes, shown);
  const { searchResult, searching, search } = useFileSearch(project.id);
  const explorerRef = useRef<ExplorerHandle>(null);
  const searchRef = useRef<FileSearchHandle>(null);
  /** What the sections' header buttons stand for, reported by the views that hold the state. */
  const [filtering, setFiltering] = useState(false);
  const [allFolded, setAllFolded] = useState(false);
  const showProgress = useDelayed(listing || acting, PROGRESS_DELAY_MS);
  const showSearchProgress = useDelayed(searching, PROGRESS_DELAY_MS);
  /** A match row: the file at the match, which its editor selects. */
  const onOpenMatch = useCallback(
    (path: string, match: FileSearchMatch) =>
      onOpenFile(project.id, path, { reveal: { line: match.line, column: match.column, length: match.length } }),
    [onOpenFile, project.id]
  );

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
              title="Clear Filter"
              disabled={!filtering}
              onClick={() => explorerRef.current?.clearFilter()}
            >
              <ClearIcon />
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
          {/* This section's bar — the listing and the tree's edits. */}
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
          onOpenFile={onOpenFile}
          act={act}
          onExplorerChanged={refreshExplorer}
          onFiltering={setFiltering}
        />
      </div>
      <Sash
        orientation="horizontal"
        size={searchHeight}
        min={MIN_PANE_HEIGHT}
        minOther={MIN_PANE_HEIGHT}
        reverse
        onResize={onSearchHeight}
      />
      <div className="section" style={{ height: searchHeight }}>
        <div className="section-header">
          <span className="search-title">
            SEARCH{" "}
            {searchResult && (
              <span className={`count-badge search-summary${searchResult.error ? " error" : ""}`}>
                ({searchSummary(searchResult)})
              </span>
            )}
          </span>
          <span className="section-header-actions">
            <button
              className="icon-button"
              title="Clear Search Results"
              disabled={searchResult === undefined}
              onClick={() => searchRef.current?.clear()}
            >
              <ClearIcon />
            </button>
            <button
              className="icon-button"
              title={allFolded ? "Expand All" : "Collapse All"}
              disabled={searchResult === undefined || searchResult.files.length === 0}
              onClick={() => searchRef.current?.toggleAll()}
            >
              {allFolded ? <ExpandAllIcon /> : <CollapseAllIcon />}
            </button>
          </span>
          {/* This section's bar — the search the field below asked for. */}
          {showSearchProgress && <ProgressBar />}
        </div>
        {/* Its own query — the tree above filters by name, this looks inside the files. */}
        <FileSearch
          key={project.id}
          ref={searchRef}
          result={searchResult}
          runSearch={search}
          onAllFolded={setAllFolded}
          onOpenMatch={onOpenMatch}
        />
      </div>
    </div>
  );
});
