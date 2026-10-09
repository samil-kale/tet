import { useCallback, useEffect, useState } from "react";
import type { CommitSearch, GraphCommit, RepositoryState } from "../../../shared/types/git";
import type { ResolvedRef } from "../../resolved-ref";

/** Commits asked for at first, and added by each "load more". */
const GRAPH_PAGE = 300;

/** Typing runs the search, as SEARCH's does — but only once the typing stops. */
const SEARCH_DELAY_MS = 300;

const NO_COMMITS: GraphCommit[] = [];

const NO_SEARCH: CommitSearch = { text: "", field: "message" };

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
 *
 * The search typed above them is held with its repository or worktree, as the commits are: another
 * one shows none. It reaches git once the typing stops, and only with text.
 */
export function useCommitGraph(resolved: ResolvedRef, state: RepositoryState, enabled: boolean, busy: boolean) {
  const { ref, refKey } = resolved;
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState<{ refKey: string; commits: GraphCommit[]; searched: boolean } | undefined>();
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState<{ refKey: string; search: CommitSearch } | undefined>();
  const [sent, setSent] = useState<{ refKey: string; search: CommitSearch } | undefined>();
  const limit = limits[refKey] ?? GRAPH_PAGE;
  const version = graphVersion(state);
  const search = typed?.refKey === refKey ? typed.search : NO_SEARCH;
  const asked = sent?.refKey === refKey ? sent.search : undefined;

  useEffect(() => {
    const text = search.text.trim();
    if (text === "") {
      setSent(undefined);
      return;
    }
    const timer = setTimeout(() => setSent({ refKey, search: { text, field: search.field } }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [refKey, search]);

  useEffect(() => {
    if (!enabled || busy) {
      // A read left running is dropped below, and its bar with it.
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    void window.tet.repository.log(ref, limit, asked).then((commits) => {
      if (current) {
        setLoaded({ refKey, commits, searched: asked !== undefined });
        setLoading(false);
      }
    });
    return () => {
      current = false;
    };
  }, [enabled, busy, ref, refKey, limit, version, asked]);

  const shown = loaded?.refKey === refKey ? loaded : undefined;
  const commits = shown?.commits ?? NO_COMMITS;
  const setSearch = useCallback((next: CommitSearch) => setTyped({ refKey, search: next }), [refKey]);
  return {
    commits,
    loading,
    hasMore: commits.length >= limit,
    more: () => setLimits((current) => ({ ...current, [refKey]: limit + GRAPH_PAGE })),
    search,
    setSearch,
    /** The commits shown are a search's finds, not the graph. */
    searched: shown?.searched ?? false,
  };
}
