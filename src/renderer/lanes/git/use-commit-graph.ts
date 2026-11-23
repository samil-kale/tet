import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_GRAPH_COMMITS, type CommitSearch, type GraphCommit, type RepositoryState } from "../../../shared/types/git";
import type { ResolvedRef } from "../../resolved-ref";
import { useLatest } from "../../ui/use-latest";

/** Commits asked for at first, and added by each "load more". */
export const GRAPH_PAGE = 300;

/** Typing runs the search, as Search's does — but only once the typing stops. */
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
 * The Graph's commits of the repository or worktree, read again when `graphVersion` changes or a
 * git action (`busy`) ends — a fetch moves refs the state does not name — and only while the lane
 * is `enabled` (shown, graph on screen): the log is a git process of its own. A re-read asks for
 * as many commits as are shown, in one go. `more` reads the next page after them (`skip`) and
 * appends it, so the history already read is never read again.
 *
 * The search typed above them is held with its repository or worktree, as the commits are: another
 * one shows none. It reaches git once the typing stops, and only with text.
 */
export function useCommitGraph(resolved: ResolvedRef, state: RepositoryState, enabled: boolean, busy: boolean) {
  const { ref, refKey } = resolved;
  const [loaded, setLoaded] = useState<{ refKey: string; commits: GraphCommit[]; searched: boolean; hasMore: boolean } | undefined>();
  const loadedRef = useLatest(loaded);
  /** Counts the re-reads: a page more that was asked before one belongs to commits since replaced. */
  const generation = useRef(0);
  const paging = useRef(false);
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState<{ refKey: string; search: CommitSearch } | undefined>();
  const [sent, setSent] = useState<{ refKey: string; search: CommitSearch } | undefined>();
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
    generation.current++;
    paging.current = false;
    setLoading(true);
    // What is shown stays as long, so a re-read does not shorten the list under the reader.
    const before = loadedRef.current;
    const kept = before?.refKey === refKey && before.searched === (asked !== undefined) ? before.commits.length : 0;
    const count = Math.min(Math.max(kept, GRAPH_PAGE), MAX_GRAPH_COMMITS);
    void window.tet.repository.log(ref, count, asked).then((commits) => {
      if (current) {
        setLoaded({
          refKey,
          commits,
          searched: asked !== undefined,
          hasMore: commits.length >= count && commits.length < MAX_GRAPH_COMMITS,
        });
        setLoading(false);
      }
    });
    return () => {
      current = false;
    };
  }, [enabled, busy, ref, refKey, version, asked, loadedRef]);

  const more = useCallback(() => {
    const shown = loadedRef.current;
    if (shown?.refKey !== refKey || !shown.hasMore || paging.current) {
      return;
    }
    const mine = generation.current;
    paging.current = true;
    setLoading(true);
    // Never past MAX_GRAPH_COMMITS: a re-read could not ask for more and would shorten the list.
    const size = Math.min(GRAPH_PAGE, MAX_GRAPH_COMMITS - shown.commits.length);
    void window.tet.repository.log(ref, size, asked, shown.commits.length).then((page) => {
      if (generation.current !== mine) {
        return;
      }
      paging.current = false;
      setLoaded((previous) =>
        previous?.refKey === refKey
          ? {
              ...previous,
              commits: [...previous.commits, ...page],
              hasMore: page.length >= size && previous.commits.length + page.length < MAX_GRAPH_COMMITS,
            }
          : previous,
      );
      setLoading(false);
    });
  }, [ref, refKey, asked, loadedRef]);

  const shown = loaded?.refKey === refKey ? loaded : undefined;
  const commits = shown?.commits ?? NO_COMMITS;
  const setSearch = useCallback((next: CommitSearch) => setTyped({ refKey, search: next }), [refKey]);
  return {
    commits,
    loading,
    hasMore: shown?.hasMore ?? false,
    more,
    search,
    setSearch,
    /** The commits shown are a search's finds, not the graph. */
    searched: shown?.searched ?? false,
  };
}
