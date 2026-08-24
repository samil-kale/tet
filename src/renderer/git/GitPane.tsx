import { memo, useState } from "react";
import type { Project, RepositoryState } from "../../shared/types";
import { BranchTree, type BranchActions } from "./BranchTree";
import { askCommitAll, ChangesList, confirmDiscard, type FileAct } from "./ChangesList";
import { notify } from "../ui/Notices";
import { MIN_PANE_HEIGHT, Sash } from "../ui/Sash";
import { ArrowDownIcon, ArrowUpIcon, CommitIcon, DiscardIcon, StashIcon, SyncIcon } from "../ui/icons";
import { ProgressBar } from "../ui/ProgressBar";

interface GitPaneProps {
  project: Project;
  state: RepositoryState;
  branch: BranchActions;
  /** Dragged on the sash between the tree and the changes; held by the app, like the width. */
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  /** A file to look at — the diff opens as a dialog over everything. */
  onOpenDiff: (path: string) => void;
}

/**
 * The repository, beside the terminals rather than in place of them: branches over the changed
 * files, and nothing else. The diff is not here — double-clicking a file shows it over the
 * whole window, so this pane stays narrow enough to leave open next to a terminal.
 */
export const GitPane = memo(function GitPane({ project, state, branch, treeHeight, onTreeHeight, onOpenDiff }: GitPaneProps) {
  /** The projects a file action is running in — one pane serves every project. */
  const [actingIn, setActingIn] = useState<ReadonlySet<string>>(() => new Set());
  const acting = actingIn.has(project.id);

  // Fetch, pull and push all go through the one action slot a discard or a stash also uses, so
  // both a file action and a branch command hold the same lock.
  const remote = state.remotes[0]?.name;
  const canSync = remote !== undefined && !state.detached;
  const syncLocked = branch.busy || acting;

  /** Runs a file action against the repository and reports what it says when it failed. */
  const act: FileAct = (action) => {
    const { id } = project;
    setActingIn((current) => new Set(current).add(id));
    void action()
      .then((result) => {
        if (!result.ok) {
          notify("error", result.error ?? "Git command failed");
        }
      })
      .finally(() =>
        setActingIn((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        })
      );
  };

  return (
    <div className="git-pane-content">
      {/* Both halves are titled the way the navigation's are — same bar, same height. */}
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
          {/* This section's own bar — a checkout, a fetch/pull/push, a stash apply/pop/drop, a
              merge or rebase, anything `branch.run` covers. Not the changed-files list below:
              stashing, discarding and ignoring have their own bar under that header instead. */}
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
          {/* The three things that clear the whole list, in the order of what they cost: one
              keeps it, one puts it away and can be popped again, the last throws it out. Anything
              narrower than "all of it" is in the changes' own context menu. */}
          <span className="section-header-actions">
            <button
              className="icon-button"
              title="Commit all changes"
              disabled={branch.busy || acting || state.changes.length === 0}
              onClick={() => void askCommitAll(project, state, act)}
            >
              <CommitIcon />
            </button>
            <button
              className="icon-button"
              title="Stash all changes"
              disabled={branch.busy || acting || state.changes.length === 0}
              // Through `act`, not `branch.run`: it starts from the changed-file list this
              // section owns, so its own bar is the one that should show it running — the same
              // reason discard and ignore already go through here rather than the tree's lock.
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
          {/* This section's own bar — stashing, discarding or ignoring, everything `act` covers. */}
          {acting && <ProgressBar />}
        </div>
        <ChangesList project={project} changes={state.changes} act={act} onOpenDiff={onOpenDiff} />
      </div>
    </div>
  );
});
