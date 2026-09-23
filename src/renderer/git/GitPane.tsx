import { memo } from "react";
import { syncRemote } from "../../shared/types";
import type { Project, RepositoryState } from "../../shared/types";
import type { OpenEditor } from "../terminal/editor-tab";
import { BranchTree, type BranchActions } from "./BranchTree";
import { askCommit, ChangesList, confirmDiscard } from "./ChangesList";
import { useFileAct } from "./run-action";
import { MIN_PANE_HEIGHT, Sash } from "../ui/Sash";
import { ArrowDownIcon, ArrowUpIcon, CommitIcon, DiscardIcon, StashIcon, SyncIcon } from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

interface GitPaneProps {
  project: Project;
  state: RepositoryState;
  /** False while the files view stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  branch: BranchActions;
  /** Set by the sash between tree and changes; held by the app, like the width. */
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  /** Opens in the project's preview tab, a Markdown file with its preview if asked. */
  onOpenDiff: (path: string, how?: OpenEditor) => void;
  /** See BranchTree. */
  onOpenWorktree: (worktreePath: string) => void;
  canCloseWorktree: (worktreePath: string) => Promise<boolean>;
  worktreesSupported: boolean;
}

/** The side pane's git view: branches over the changed files, nothing else. */
export const GitPane = memo(function GitPane({
  project,
  state,
  shown,
  branch,
  treeHeight,
  onTreeHeight,
  onOpenDiff,
  onOpenWorktree,
  canCloseWorktree,
  worktreesSupported
}: GitPaneProps) {
  const { acting, act, ask } = useFileAct(project.id);

  // Fetch, pull and push share the one action slot with discard and stash.
  const { remote, canSync } = syncRemote(state);
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
          {/* This section's bar — everything `branch.run` covers. */}
          {branch.startedHere && <ProgressBar />}
        </div>
        <BranchTree
          projectId={project.id}
          state={state}
          branch={branch}
          onOpenWorktree={onOpenWorktree}
          canCloseWorktree={canCloseWorktree}
          worktreesSupported={worktreesSupported}
        />
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
          {/* What clears the whole list, ordered by cost. Narrower actions are in the context menu. */}
          <span className="section-header-actions">
            <button
              className="icon-button"
              title="Commit all changes"
              disabled={locked || state.changes.length === 0}
              onClick={() => void askCommit(project, state, undefined, ask)}
            >
              <CommitIcon />
            </button>
            <button
              className="icon-button"
              title="Stash all changes"
              disabled={locked || state.changes.length === 0}
              // `act`, not `branch.run`: it belongs to this section, whose bar shows it.
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
          {/* This section's bar — everything `act` covers. */}
          {acting && <ProgressBar />}
        </div>
        <ChangesList project={project} state={state} act={act} ask={ask} onOpenDiff={onOpenDiff} />
      </div>
    </div>
  );
});
