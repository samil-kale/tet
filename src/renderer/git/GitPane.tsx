import { memo, useRef } from "react";
import { syncRemote } from "../../shared/types";
import type { RepositoryState } from "../../shared/types";
import type { ResolvedRef } from "../resolved-ref";
import type { OpenEditor } from "../editor/editor-tab";
import { BranchTree, type BranchActions } from "./BranchTree";
import { askCommit, ChangesList, confirmDiscard } from "./ChangesList";
import { useFileAct } from "./run-action";
import { MIN_PANE_HEIGHT, Sash } from "../ui/Sash";
import { IconButton } from "../ui/IconButton";
import { ArrowDownIcon, ArrowUpIcon, CommitIcon, DiscardIcon, StashIcon, SyncIcon } from "../ui/icons";
import { Section } from "../ui/Section";

interface GitPaneProps {
  resolved: ResolvedRef;
  state: RepositoryState;
  /** False while the files view stands in its place; hidden, not unmounted, to keep its state. */
  shown: boolean;
  branch: BranchActions;
  /** Set by the sash between tree and changes; held by the app, like the width. */
  treeHeight: number;
  onTreeHeight: (size: number) => void;
  /** Opens in the repository's or worktree's preview tab, a Markdown file with its preview if
   *  asked. */
  onOpenDiff: (path: string, how?: OpenEditor) => void;
  /** See BranchTree. */
  onSelect: (key: string) => void;
}

/** The side pane's git view: branches over the changed files, nothing else. */
export const GitPane = memo(function GitPane({
  resolved,
  state: latestState,
  shown,
  branch,
  treeHeight,
  onTreeHeight,
  onOpenDiff,
  onSelect
}: GitPaneProps) {
  const { acting, act, ask } = useFileAct(resolved.key);
  // Hidden, the pane keeps the state it last showed: every push re-rendered the whole tree and list
  // for nobody. A repository or worktree switch is never held — the keyed views would get another
  // repository's.
  const held = useRef({ key: resolved.key, state: latestState });
  if (shown || held.current.key !== resolved.key) {
    held.current = { key: resolved.key, state: latestState };
  }
  const state = held.current.state;

  // Fetch, pull and push share the one action slot with discard and stash.
  const { remote, canSync } = syncRemote(state);
  const locked = branch.busy || acting;
  // Named as GitHub Desktop names them: by the remote, not the branch. A local upstream is pulled
  // from, named by its branch, but pushed to the remote like any other.
  const pullFrom = state.branchUpstreams[state.head]?.remote ?? state.upstream;

  return (
    <div className={`side-pane-content${shown ? "" : " hidden"}`}>
      {/* This section's bar — everything `branch.run` covers. */}
      <Section
        title="BRANCHES"
        busy={branch.startedHere}
        height={treeHeight}
        actions={
          <>
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
                  window.tet.repository.push(resolved.ref, login)
                )
              }
            >
              <ArrowUpIcon />
            </IconButton>
          </>
        }
      >
        {/* Keyed: a menu left open across a switch of repository or worktree would act on the next one. */}
        <BranchTree
          key={resolved.key}
          resolved={resolved}
          state={state}
          branch={branch}
          onSelect={onSelect}
        />
      </Section>
      <Sash
        orientation="horizontal"
        size={treeHeight}
        min={MIN_PANE_HEIGHT}
        minOther={MIN_PANE_HEIGHT}
        onResize={onTreeHeight}
      />
      {/* What clears the whole list, ordered by cost. Narrower actions are in the context menu.
          This section's bar — everything `act` covers. */}
      <Section
        title="LOCAL CHANGES"
        count={state.changes.length}
        busy={acting}
        actions={
          <>
            <IconButton
              title="Commit all changes"
              disabled={locked || state.changes.length === 0}
              onClick={() => void askCommit(resolved.ref, state, undefined, ask)}
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
              title="Discard all changes"
              disabled={locked || state.changes.length === 0}
              onClick={() => void confirmDiscard(resolved.ref, state.changes.map((change) => change.path), act)}
            >
              <DiscardIcon />
            </IconButton>
          </>
        }
      >
        <ChangesList key={resolved.key} resolved={resolved} state={state} act={act} ask={ask} onOpenDiff={onOpenDiff} />
      </Section>
    </div>
  );
});
