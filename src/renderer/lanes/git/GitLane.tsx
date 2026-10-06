import { memo, useRef, useState } from "react";
import { syncRemote } from "../../../shared/types/git";
import type { RepositoryState } from "../../../shared/types/git";
import type { ResolvedRef } from "../../resolved-ref";
import type { OpenEditor } from "../../editor/editor-tab";
import { BranchTree } from "./BranchTree";
import { askCommit, canCommit, ChangesList, confirmDiscard, type ChangesListHandle } from "./ChangesList";
import { useFileAct, type BranchActions } from "../../git/run-action";
import { MIN_AREA_HEIGHT, Sash } from "../../ui/Sash";
import { IconButton } from "../../ui/IconButton";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BranchIcon,
  CommitIcon,
  DiscardIcon,
  GraphIcon,
  ListIcon,
  ListTreeIcon,
  StashIcon,
  SyncIcon,
} from "../../ui/icons";
import { CollapseExpandAllButton } from "../../ui/CollapseExpandAllButton";
import { useStoredToggle } from "../../ui/layout-storage";
import { Section } from "../../ui/Section";
import { CommitGraph } from "./CommitGraph";
import { useCommitGraph } from "./use-commit-graph";

interface GitLaneProps {
  resolved: ResolvedRef;
  state: RepositoryState;
  /** False while the files lane stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  branch: BranchActions;
  /** Set by the sash between tree and changes; held by the app, like the width. */
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  /** Opens in the repository's or worktree's preview tab, a Markdown file with its preview if
   *  asked. */
  onOpenDiff: (path: string, how?: OpenEditor) => void;
  /** See BranchTree. */
  onActivateRef: (refKey: string) => void;
}

/** The git lane: branches, or their commit graph, over the changed files, nothing else. */
export const GitLane = memo(function GitLane({
  resolved,
  state: latestState,
  shown,
  branch,
  treeHeight,
  onTreeHeight,
  onOpenDiff,
  onActivateRef,
}: GitLaneProps) {
  const { acting, act, ask } = useFileAct(resolved.refKey);
  const changesRef = useRef<ChangesListHandle>(null);
  /** What the LOCAL CHANGES header's buttons stand for, reported by the list that holds the state. */
  const [checked, setChecked] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  /** One view for every project, as the lanes' toggles. */
  const [asTree, setAsTree] = useStoredToggle("changes-tree", true);
  // Hidden, the lane keeps the state it last showed: every push re-rendered the whole tree and list
  // for nobody. A repository or worktree switch is never held — the keyed views would get another
  // repository's.
  const held = useRef({ refKey: resolved.refKey, state: latestState });
  if (shown || held.current.refKey !== resolved.refKey) {
    held.current = { refKey: resolved.refKey, state: latestState };
  }
  const state = held.current.state;
  /** What the top section holds, BRANCHES or their GRAPH: one for every project, as the lanes' toggles. */
  const [showGraph, setShowGraph] = useStoredToggle("branches-graph", false);
  // Read only while the graph is on screen: the log is a git process of its own.
  const graph = useCommitGraph(resolved, state, shown && showGraph, branch.busy);

  // Fetch, pull and push share the one action slot with discard and stash.
  const { remote, canSync } = syncRemote(state);
  const locked = branch.locked || acting;
  // Named as GitHub Desktop names them: by the remote, not the branch. A local upstream is pulled
  // from, named by its branch, but pushed to the remote like any other.
  const pullFrom = state.branchUpstreams[state.head]?.remote ?? state.upstream;

  return (
    <div className={`lane-content${shown ? "" : " hidden"}`}>
      {/* This section's bar — everything `branch.run` covers. */}
      <Section
        title={showGraph ? "GRAPH" : "BRANCHES"}
        busy={branch.busy || graph.loading}
        height={treeHeight}
        actions={
          <>
            <IconButton title={showGraph ? "Show Branches" : "Show Graph"} onClick={() => setShowGraph(!showGraph)}>
              {showGraph ? <BranchIcon /> : <GraphIcon />}
            </IconButton>
            <IconButton
              title={remote ? `Fetch ${remote}` : "This repository has no remote"}
              disabled={locked || !canSync}
              onClick={() => branch.run("Fetching...", (login) => window.tet.repository.fetch(resolved.ref, login))}
            >
              <SyncIcon />
            </IconButton>
            <IconButton
              title={pullFrom ? `Pull ${pullFrom}` : "No upstream to pull from"}
              disabled={locked || !canSync || state.upstream === undefined}
              onClick={() => branch.run("Pulling...", (login) => window.tet.repository.pull(resolved.ref, login))}
            >
              <ArrowDownIcon />
            </IconButton>
            <IconButton
              title={state.upstream === undefined ? "Publish branch" : `Push ${remote}`}
              disabled={locked || !canSync}
              onClick={() =>
                branch.run(state.upstream === undefined ? "Publishing..." : "Pushing...", (login) =>
                  window.tet.repository.push(resolved.ref, login),
                )
              }
            >
              <ArrowUpIcon />
            </IconButton>
          </>
        }
      >
        {/* Keyed: a menu left open across a switch of repository or worktree would act on the next one. */}
        {showGraph ? (
          <CommitGraph
            key={resolved.refKey}
            resolved={resolved}
            state={state}
            commits={graph.commits}
            hasMore={graph.hasMore}
            loading={graph.loading}
            onMore={graph.more}
            onOpenDiff={onOpenDiff}
          />
        ) : (
          <BranchTree key={resolved.refKey} resolved={resolved} state={state} branch={branch} onActivateRef={onActivateRef} />
        )}
      </Section>
      <Sash orientation="horizontal" size={treeHeight} min={MIN_AREA_HEIGHT} minOther={MIN_AREA_HEIGHT} onResize={onTreeHeight} />
      {/* The checked changes, ordered by cost — stash takes all, git stashing no single paths
          safely. A row's own actions are in the context menu, then the view.
          This section's bar — everything `act` covers. */}
      <Section
        title="LOCAL CHANGES"
        count={state.changes.length}
        busy={acting}
        actions={
          <>
            <IconButton
              title="Commit checked changes"
              disabled={locked || !canCommit(state, checked)}
              onClick={() => void askCommit(resolved.ref, state, checked, ask)}
            >
              <CommitIcon />
            </IconButton>
            <IconButton
              title="Stash all changes"
              disabled={locked || state.changes.length === 0}
              // `act`, not `branch.run`: it belongs to this section, whose bar shows it.
              onClick={() => act(() => window.tet.repository.stashPush(resolved.ref, ""))}
            >
              <StashIcon />
            </IconButton>
            <IconButton
              title="Discard checked changes"
              disabled={locked || checked.length === 0}
              onClick={() => void confirmDiscard(resolved.ref, checked, act)}
            >
              <DiscardIcon />
            </IconButton>
            <IconButton title={asTree ? "View as List" : "View as Tree"} onClick={() => setAsTree(!asTree)}>
              {asTree ? <ListIcon /> : <ListTreeIcon />}
            </IconButton>
            <CollapseExpandAllButton expanded={expanded} disabled={!asTree || state.changes.length === 0} tree={changesRef} />
          </>
        }
      >
        {/* Keyed by repository or worktree: the checks and expansions are keyed by paths that repeat
            across them. */}
        <ChangesList
          key={resolved.refKey}
          ref={changesRef}
          resolved={resolved}
          state={state}
          act={act}
          onOpenDiff={onOpenDiff}
          asTree={asTree}
          onChecked={setChecked}
          onExpanded={setExpanded}
        />
      </Section>
    </div>
  );
});
