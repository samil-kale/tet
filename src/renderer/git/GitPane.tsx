import { memo } from "react";
import type { Project, RepositoryState } from "../../shared/types";
import { BranchTree, type BranchActions } from "./BranchTree";
import { askCommit, ChangesList, confirmDiscard } from "./ChangesList";
import { useFileAct } from "./use-file-act";
import { MIN_PANE_HEIGHT, Sash } from "../ui/Sash";
import { ArrowDownIcon, ArrowUpIcon, CommitIcon, DiscardIcon, StashIcon, SyncIcon } from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

interface GitPaneProps {
  project: Project;
  state: RepositoryState;
  /** False while the files view stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  branch: BranchActions;
  /** Dragged on the sash between the tree and the changes; held by the app, like the width. */
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  /** A file to look at — it opens in the project's editor tab. */
  onOpenDiff: (path: string) => void;
}

/** The side pane's repository view: branches over the changed files, and nothing else. */
export const GitPane = memo(function GitPane({
  project,
  state,
  shown,
  branch,
  treeHeight,
  onTreeHeight,
  onOpenDiff
}: GitPaneProps) {
  const { acting, act } = useFileAct(project.id);

  // Fetch, pull and push share the one action slot a discard or a stash uses.
  const remote = state.remotes[0]?.name;
  const canSync = remote !== undefined && !state.detached;
  const locked = branch.busy || acting;

  return (
    <div className={`side-pane-content${shown ? "" : " hidden"}`}>
      <div className="section" style={{ height: treeHeight }}>
        <div className="section-header">
          <span>BRANCHES</span>
          <span className="section-header-actions">
            <button
              className="icon-button"
              title={remote ? `Fetch from ${remote}` : "This repository has no remote"}
              disabled={locked || !canSync}
              onClick={() => branch.run("Fetching...", () => window.tet.repository.fetch(project.id))}
            >
              <SyncIcon />
            </button>
            <button
              className="icon-button"
              title={state.upstream ? `Pull from ${state.upstream}` : "No upstream to pull from"}
              disabled={locked || !canSync || state.upstream === undefined}
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
              disabled={locked || !canSync}
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
      <Sash
        orientation="horizontal"
        size={treeHeight}
        min={MIN_PANE_HEIGHT}
        minOther={MIN_PANE_HEIGHT}
        onResize={onTreeHeight}
      />
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
              disabled={locked || state.changes.length === 0}
              onClick={() => void askCommit(project, state, undefined, act)}
            >
              <CommitIcon />
            </button>
            <button
              className="icon-button"
              title="Stash all changes"
              disabled={locked || state.changes.length === 0}
              // Through `act`, not `branch.run`: it starts from the changed-file list this
              // section owns, so its own bar shows it running.
              onClick={() => act(() => window.tet.repository.stashPush(project.id, ""))}
            >
              <StashIcon />
            </button>
            <button
              className="icon-button"
              title="Discard all changes"
              disabled={locked || state.changes.length === 0}
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
    </div>
  );
});
