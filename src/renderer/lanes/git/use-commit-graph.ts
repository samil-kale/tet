import { useEffect, useMemo, useState } from "react";
import type { GraphCommit, RepositoryState } from "../../../shared/types/git";
import type { ResolvedRef } from "../../resolved-ref";

/** Commits asked for at first, and added by each "load more". */
const GRAPH_PAGE = 300;

const NO_COMMITS: GraphCommit[] = [];

/** What moves the graph: the pushed state names HEAD, its upstream and the default branch, not each
 *  ref's commit, so a fetch shows through the counts it changes, and any git action's end covers
 *  the rest. */
function graphVersion(state: RepositoryState): string {
  return JSON.stringify([state.head, state.headCommit, state.upstream, state.ahead, state.behind, state.defaultBranch]);
}

/**
 * The GRAPH's commits of the repository or worktree, read again when `graphVersion` changes or a
 * git action (`busy`) ends — a fetch moves refs the state does not name — and only while the lane
 * is `enabled` (shown, graph on screen): the log is a git process of its own. `more` asks for
 * another page.
 */
export function useCommitGraph(resolved: ResolvedRef, state: RepositoryState, enabled: boolean, busy: boolean) {
  const { ref, refKey } = resolved;
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState<{ refKey: string; commits: GraphCommit[] } | undefined>();
  const [loading, setLoading] = useState(false);
  const limit = limits[refKey] ?? GRAPH_PAGE;
  const version = useMemo(() => graphVersion(state), [state]);

  useEffect(() => {
    if (!enabled || busy) {
      // A read left running is dropped below, and its bar with it.
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    void window.tet.repository.log(ref, limit).then((commits) => {
      if (current) {
        setLoaded({ refKey, commits });
        setLoading(false);
      }
    });
    return () => {
      current = false;
    };
  }, [enabled, busy, ref, refKey, limit, version]);

  const commits = loaded?.refKey === refKey ? loaded.commits : NO_COMMITS;
  return {
    commits,
    loading,
    hasMore: commits.length >= limit,
    more: () => setLimits((current) => ({ ...current, [refKey]: limit + GRAPH_PAGE })),
  };
}
