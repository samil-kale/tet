import { useMemo, useRef } from "react";
import { refName, worktreeBase } from "../../../shared/types/git";
import type { RepositoryState } from "../../../shared/types/git";
import { stableRecord } from "../../identity";
import type { RefHead } from "./ProjectList";

/**
 * A row's HEAD, first remote and dirty flag, by repository or worktree, identity-stable where
 * unchanged (`states` is fresh on every push, so every field is a value — the remote by what the
 * row shows of it). No git call of its own: `changes` comes with every refresh.
 */
export function useRefHeads(states: Record<string, RepositoryState>): Record<string, RefHead> {
  const headsRef = useRef<Record<string, RefHead>>({});
  return useMemo(() => {
    const next: Record<string, RefHead> = {};
    for (const [key, state] of Object.entries(states)) {
      const base = state.worktrees.find((worktree) => worktree.current)?.base;
      const target = worktreeBase(state);
      next[key] = {
        head: state.head,
        detached: state.detached,
        upstream: state.upstream,
        base,
        baseAt: base === undefined ? undefined : state.worktrees.find((worktree) => worktree.branch === base)?.path,
        defaultBranch: target && refName(target),
        remoteName: state.remotes[0]?.name,
        remoteUrl: state.remotes[0]?.url,
        dirty: state.changes.length > 0
      };
    }
    return stableRecord(headsRef, next);
  }, [states]);
}
