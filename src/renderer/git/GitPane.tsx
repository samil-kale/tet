// TRIAL: the EXPLORER section is commented out to see whether the pane does without it; restore
// everything marked TRIAL to bring it back.
import { memo, /* TRIAL: useRef, */ useState } from "react";
import type { Project, RepositoryState } from "../../shared/types";
import { BranchTree, type BranchActions } from "./BranchTree";
import { askCommit, ChangesList, confirmDiscard, type FileAct } from "./ChangesList";
// TRIAL: import { Explorer, useExplorerListing, type ExplorerHandle } from "./Explorer";
import { notify } from "../ui/Notices";
import { MIN_PANE_HEIGHT, Sash } from "../ui/Sash";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  // TRIAL: CollapseAllIcon,
  CommitIcon,
  DiscardIcon,
  // TRIAL: NewFileIcon,
  // TRIAL: NewFolderIcon,
  StashIcon,
  SyncIcon
} from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

interface GitPaneProps {
  project: Project;
  state: RepositoryState;
  branch: BranchActions;
  /** Dragged on the sash between the tree and the changes; held by the app, like the width. */
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  /** Dragged on the sash between the changes and the Explorer; held by the app, like the one above. */
  changesHeight: number;
  onChangesHeight: (size: number) => void;
  /** A file to look at — it opens in the project's editor tab. */
  onOpenDiff: (path: string) => void;
  /** The file the project's editor tab shows, if any — the Explorer reveals it. */
  openPath: string | null;
}

/**
 * Runs a file action against the repository and reports what it says when it failed, marking it
 * running for the section that started it — one pane serves every project, so the mark is per
 * project. Called once per section, each with its own bar.
 */
function useFileAct(projectId: string): { acting: boolean; act: FileAct } {
  const [actingIn, setActingIn] = useState<ReadonlySet<string>>(() => new Set());
  const act: FileAct = (action) => {
    setActingIn((current) => new Set(current).add(projectId));
    void action()
      .then((result) => {
        if (!result.ok) {
          notify("error", result.error ?? "Git command failed");
        }
      })
      .finally(() =>
        setActingIn((current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        })
      );
  };
  return { acting: actingIn.has(projectId), act };
}

/** The repository beside the terminals: branches over the changed files over the Explorer. */
export const GitPane = memo(function GitPane({
  project,
  state,
  branch,
  treeHeight,
  onTreeHeight,
  // TRIAL: changesHeight,
  // TRIAL: onChangesHeight,
  onOpenDiff
  // TRIAL: openPath
}: GitPaneProps) {
  const { acting, act } = useFileAct(project.id);
  // TRIAL: const { acting: explorerActing, act: explorerAct } = useFileAct(project.id);
  // TRIAL: const { explorerListing, listing, refreshExplorer } = useExplorerListing(project.id, state.changes);
  // TRIAL: const explorerRef = useRef<ExplorerHandle>(null);

  // Fetch, pull and push share the one action slot a discard or a stash uses.
  const remote = state.remotes[0]?.name;
  const canSync = remote !== undefined && !state.detached;
  const syncLocked = branch.busy || acting;

  return (
    <div className="git-pane-content">
      <div className="section" style={{ height: treeHeight }}>
        <div className="section-header">
          <span>BRANCHES</span>
          <span className="section-header-actions">
            <button
              className="icon-button"
              title={remote ? `Fetch from ${remote}` : "This repository has no remote"}
              disabled={syncLocked || !canSync}
              onClick={() => branch.run("Fetching...", () => window.tet.repository.fetch(project.id))}
            >
              <SyncIcon />
            </button>
            <button
              className="icon-button"
              title={state.upstream ? `Pull from ${state.upstream}` : "No upstream to pull from"}
              disabled={syncLocked || !canSync || state.upstream === undefined}
              onClick={() => branch.run("Pulling...", () => window.tet.repository.pull(project.id))}
            >
              <ArrowDownIcon />
            </button>
            <button
              className="icon-button"
              title={
                state.upstream === undefined
                  ? `Push ${state.head} to ${remote} and track it`
                  : `Push to ${state.upstream}`
              }
              disabled={syncLocked || !canSync}
              onClick={() =>
                branch.run(state.upstream === undefined ? "Publishing..." : "Pushing...", () =>
                  window.tet.repository.push(project.id)
                )
              }
            >
              <ArrowUpIcon />
            </button>
          </span>
          {/* This section's own bar — anything `branch.run` covers. */}
          {branch.busy && <ProgressBar />}
        </div>
        <BranchTree projectId={project.id} state={state} branch={branch} />
      </div>
      {/* Both sashes clamp against the whole pane, so what the other side needs is the fixed
          section beyond them plus the floor of the one that grows.
          TRIAL: minOther={changesHeight + MIN_PANE_HEIGHT} */}
      <Sash
        orientation="horizontal"
        size={treeHeight}
        min={MIN_PANE_HEIGHT}
        minOther={MIN_PANE_HEIGHT}
        onResize={onTreeHeight}
      />
      {/* TRIAL: <div className="section" style={{ height: changesHeight }}> */}
      <div className="section grows">
        <div className="section-header">
          <span>
            LOCAL CHANGES <span className="count-badge">({state.changes.length})</span>
          </span>
          {/* The three things that clear the whole list, ordered by what they cost. Anything
              narrower than "all of it" is in the changes' own context menu. */}
          <span className="section-header-actions">
            <button
              className="icon-button"
              title="Commit all changes"
              disabled={branch.busy || acting || state.changes.length === 0}
              onClick={() => void askCommit(project, state, undefined, act)}
            >
              <CommitIcon />
            </button>
            <button
              className="icon-button"
              title="Stash all changes"
              disabled={branch.busy || acting || state.changes.length === 0}
              // Through `act`, not `branch.run`: it starts from the changed-file list this
              // section owns, so its own bar shows it running.
              onClick={() => act(() => window.tet.repository.stashPush(project.id, ""))}
            >
              <StashIcon />
            </button>
            <button
              className="icon-button"
              title="Discard all changes"
              disabled={branch.busy || acting || state.changes.length === 0}
              onClick={() => void confirmDiscard(project.id, state.changes.map((change) => change.path), act)}
            >
              <DiscardIcon />
            </button>
          </span>
          {/* This section's own bar — everything `act` covers. */}
          {acting && <ProgressBar />}
        </div>
        <ChangesList project={project} state={state} act={act} onOpenDiff={onOpenDiff} />
      </div>
      {/* TRIAL: the EXPLORER section
      <Sash
        orientation="horizontal"
        size={changesHeight}
        min={MIN_PANE_HEIGHT}
        minOther={treeHeight + MIN_PANE_HEIGHT}
        onResize={onChangesHeight}
      />
      <div className="section grows">
        <div className="section-header">
          <span>
            EXPLORER <span className="count-badge">({explorerListing?.files.length ?? 0})</span>
          </span>
          <span className="section-header-actions">
            <button
              className="icon-button"
              title="New File..."
              disabled={explorerActing || !explorerListing}
              onClick={() => explorerRef.current?.newFile()}
            >
              <NewFileIcon />
            </button>
            <button
              className="icon-button"
              title="New Folder..."
              disabled={explorerActing || !explorerListing}
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
          // This section's own bar — the listing, and the tree's own edits.
          {(listing || explorerActing) && <ProgressBar />}
        </div>
        // Keyed by project: one mounted tree serves every project, and its fold and filter state
        // is keyed by paths that repeat across repositories.
        <Explorer
          key={project.id}
          ref={explorerRef}
          project={project}
          files={explorerListing}
          selected={openPath}
          onOpen={onOpenDiff}
          act={explorerAct}
          onExplorerChanged={refreshExplorer}
        />
      </div>
      */}
    </div>
  );
});
