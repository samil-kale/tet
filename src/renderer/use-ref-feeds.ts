import { useCallback, useEffect, useState, type RefObject } from "react";
import { projectRefKey, projectRefsOf } from "../shared/types/project";
import type { RepositoryState } from "../shared/types/git";
import type { Project } from "../shared/types/project";
import type { TerminalDescriptor } from "../shared/types/terminals";
import { forget } from "./identity";
import { clearTerminal } from "./tabs/terminal-views";
import { useLatest } from "./ui/use-latest";

/**
 * Every repository's and worktree's git state, tabs and whether something starts there, by
 * `projectRefKey`: loaded once with the stored projects (`onProjects`), then kept by main's pushes.
 * `projectsRef` is the list after an await: the control channel can add a project meanwhile.
 */
export function useRefFeeds(projectsRef: RefObject<Project[]>, onProjects: (stored: Project[]) => void) {
  /** Everything here is by `projectRefKey`. */
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /** Every repository's and worktree's tabs: the project list needs all of them at once. */
  const [tabs, setTabs] = useState<Record<string, TerminalDescriptor[]>>({});
  /**
   * For callbacks that read it only on a click: depending on `tabs` would remake them, and every
   * pane's props, on every push.
   */
  const tabsRef = useLatest(tabs);
  /**
   * Repositories and worktrees with something starting (bootstrap listing, a CLI booting). Read by
   * the progress bar and the layout persistence.
   */
  const [starting, setStarting] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubscribers = [
      window.tet.repository.onState(({ ref, state }) =>
        setStates((current) => ({ ...current, [projectRefKey(ref)]: state }))
      ),
      window.tet.terminals.onTabs(({ ref, tabs: list }) =>
        setTabs((current) => ({ ...current, [projectRefKey(ref)]: list }))
      ),
      window.tet.terminals.onStatus(({ ref, tabId, status }) => {
        const key = projectRefKey(ref);
      // A saved command's restart kill writes a trailing "^C"; clearing once the respawn runs keeps
      // it off screen (main flushes the old output before the status, the new one's has not come).
        if (status === "running" && tabsRef.current[key]?.some((tab) => tab.tabId === tabId && tab.savedCommand)) {
          clearTerminal(ref, tabId);
        }
        setTabs((current) => {
          const list = current[key];
          return list
            ? { ...current, [key]: list.map((tab) => (tab.tabId === tabId ? { ...tab, status } : tab)) }
            : current;
        });
      }),
      window.tet.terminals.onStartupProgress(({ ref, show }) => {
        const key = projectRefKey(ref);
        setStarting((current) => (current[key] === show ? current : { ...current, [key]: show }));
      })
    ];

    void (async () => {
      const stored = await window.tet.projects.list();
      onProjects(stored);
      const fetched = await Promise.all(
        stored.flatMap(projectRefsOf).map(async (ref) => {
          const [state, list, isStarting] = await Promise.all([
            window.tet.repository.state(ref),
            window.tet.terminals.list(ref),
            window.tet.terminals.starting(ref)
          ]);
          return [projectRefKey(ref), state, list, isStarting] as const;
        })
      );
      // A repository or worktree closed meanwhile was forgotten already: merging its entries would
      // revive it.
      const open = new Set(projectsRef.current.flatMap(projectRefsOf).map(projectRefKey));
      const loaded = fetched.filter(([key]) => open.has(key));
      // Pushes that landed meanwhile are newer than what was fetched.
      setStates((current) => ({
        ...Object.fromEntries(loaded.map(([id, state]) => [id, state])),
        ...current
      }));
      setTabs((current) => ({ ...Object.fromEntries(loaded.map(([id, , list]) => [id, list])), ...current }));
      setStarting((current) => ({
        ...Object.fromEntries(loaded.map(([id, , , isStarting]) => [id, isStarting])),
        ...current
      }));
    })();

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [projectsRef, tabsRef, onProjects]);

  /** Drops what is held for a closed repository or worktree. */
  const forgetRef = useCallback((key: string) => {
    setStates((current) => forget(current, key));
    setTabs((current) => forget(current, key));
    setStarting((current) => forget(current, key));
  }, []);

  return { states, tabs, starting, forgetRef };
}
