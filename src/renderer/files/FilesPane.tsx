import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CheckoutRef, FileSearchMatch, RepositoryState } from "../../shared/types";
import type { Checkout } from "../checkout";
import type { OpenEditor } from "../terminal/editor-tab";
import { Explorer, useExplorerListing, type ExplorerHandle } from "./Explorer";
import { FileSearch, searchSummary, type FileSearchHandle } from "./FileSearch";
import { useFileAct } from "../git/run-action";
import { useFileSearch } from "./use-file-search";
import { MIN_PANE_HEIGHT, Sash } from "../ui/Sash";
import { ClearIcon, CollapseAllIcon, ExpandAllIcon, NewFileIcon, NewFolderIcon } from "../ui/icons";
import { Section } from "../ui/Section";

interface FilesPaneProps {
  checkout: Checkout;
  /** Its changes trigger listing re-reads — a file starting or stopping to exist. */
  state: RepositoryState;
  /** False while the git view stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  /** The active editor tab's file — the tree reveals it. */
  openPath: string | null;
  /** Opens in the checkout's preview tab, or as `how` asks (`editor-tab.ts`) — a search result at
   *  its match. */
  onOpenFile: (checkout: CheckoutRef, path: string, how?: OpenEditor) => void;
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
  checkout,
  state,
  shown,
  openPath,
  onOpenFile,
  searchHeight,
  onSearchHeight
}: FilesPaneProps) {
  const { acting, act, ask } = useFileAct(checkout.key);
  const { explorerListing, listing, refreshExplorer } = useExplorerListing(checkout, state.changes, shown);
  const { searchResult, searching, search } = useFileSearch(checkout);
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
      onOpenFile(checkout.ref, path, { reveal: { line: match.line, column: match.column, length: match.length } }),
    [onOpenFile, checkout.ref]
  );

  return (
    <div className={`side-pane-content${shown ? "" : " hidden"}`}>
      {/* This section's bar — the listing and the tree's edits. */}
      <Section
        title="EXPLORER"
        count={explorerListing?.files.length}
        busy={showProgress}
        actions={
          <>
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
          </>
        }
      >
        {/* Keyed by checkout: fold and filter state is keyed by paths that repeat across repositories. */}
        <Explorer
          key={checkout.key}
          ref={explorerRef}
          checkout={checkout}
          files={explorerListing}
          shown={shown}
          selected={openPath}
          onOpenFile={onOpenFile}
          ask={ask}
          act={act}
          onExplorerChanged={refreshExplorer}
          onFiltering={setFiltering}
        />
      </Section>
      <Sash
        orientation="horizontal"
        size={searchHeight}
        min={MIN_PANE_HEIGHT}
        minOther={MIN_PANE_HEIGHT}
        reverse
        onResize={onSearchHeight}
      />
      {/* This section's bar — the search the field below asked for. */}
      <Section
        title="SEARCH"
        count={searchResult && searchSummary(searchResult)}
        countError={Boolean(searchResult?.error)}
        busy={showSearchProgress}
        height={searchHeight}
        actions={
          <>
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
          </>
        }
      >
        {/* Its own query — the tree above filters by name, this looks inside the files. */}
        <FileSearch
          key={checkout.key}
          ref={searchRef}
          result={searchResult}
          runSearch={search}
          onAllFolded={setAllFolded}
          onOpenMatch={onOpenMatch}
        />
      </Section>
    </div>
  );
});
