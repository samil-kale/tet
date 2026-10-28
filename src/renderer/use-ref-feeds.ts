import { useCallback, useEffect, useState, type RefObject } from "react";
import { refKeyOf, projectRefsOf } from "../shared/types/project";
import type { RepositoryState } from "../shared/types/git";
import type { Project } from "../shared/types/project";
import type { TabDescriptor } from "../shared/types/terminals";
import { forget, stableItems } from "./identity";
import { resetMouseModes } from "./tabs/terminal-views";

/**
 * Every repository's and worktree's git state, tabs and whether something starts there, by
 * `refKey`: loaded once with the stored projects (`onProjects`), then kept by main's pushes.
 * `projectsRef` is the list after an await: the control channel can add a project meanwhile.
 */
export function useRefFeeds(projectsRef: RefObject<Project[]>, onProjects: (stored: Project[]) => void) {
  /** Everything here is by `refKey`. */
  const [states, setStates] = useState<Record<string, RepositoryState>>({});
  /** Every repository's and worktree's tabs: the project list needs all of them at once. */
  const [tabs, setTabs] = useState<Record<string, TabDescriptor[]>>({});
  /**
   * Repositories and worktrees with something starting (bootstrap listing, a CLI booting). Read by
   * the progress bar and the layout persistence.
   */
  const [starting, setStarting] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubscribers = [
      window.tet.repository.onState(({ ref, state }) => setStates((current) => ({ ...current, [refKeyOf(ref)]: state }))),
      window.tet.tabs.onTabs(({ ref, tabs: list }) => {
        const refKey = refKeyOf(ref);
        setTabs((current) => ({ ...current, [refKey]: stableItems(current[refKey], list, (tab) => tab.tabId) }));
      }),
      window.tet.tabs.onStatus(({ ref, tabId, status }) => {
        const refKey = refKeyOf(ref);
        if (status === "running") {
          resetMouseModes(ref, tabId);
        }
        setTabs((current) => {
          const list = current[refKey];
          return list ? { ...current, [refKey]: list.map((tab) => (tab.tabId === tabId ? { ...tab, status } : tab)) } : current;
        });
      }),
      window.tet.tabs.onStartupProgress(({ ref, show }) => {
        const refKey = refKeyOf(ref);
        setStarting((current) => (current[refKey] === show ? current : { ...current, [refKey]: show }));
      }),
    ];

    void (async () => {
      const stored = await window.tet.projects.list();
      onProjects(stored);
      const fetched = await Promise.all(
        stored.flatMap(projectRefsOf).map(async (ref) => {
          const [state, list, isStarting] = await Promise.all([
            window.tet.repository.state(ref),
            window.tet.tabs.list(ref),
            window.tet.tabs.starting(ref),
          ]);
          return [refKeyOf(ref), state, list, isStarting] as const;
        }),
      );
      // A repository or worktree closed meanwhile was forgotten already: merging its entries would
      // revive it.
      const open = new Set(projectsRef.current.flatMap(projectRefsOf).map(refKeyOf));
      const loaded = fetched.filter(([refKey]) => open.has(refKey));
      // Pushes that landed meanwhile are newer than what was fetched.
      setStates((current) => ({
        ...Object.fromEntries(loaded.map(([id, state]) => [id, state])),
        ...current,
      }));
      setTabs((current) => ({ ...Object.fromEntries(loaded.map(([id, , list]) => [id, list])), ...current }));
      setStarting((current) => ({
        ...Object.fromEntries(loaded.map(([id, , , isStarting]) => [id, isStarting])),
        ...current,
      }));
    })();

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [projectsRef, onProjects]);

  /** Drops what is held for a closed repository or worktree. */
  const forgetRef = useCallback((refKey: string) => {
    setStates((current) => forget(current, refKey));
    setTabs((current) => forget(current, refKey));
    setStarting((current) => forget(current, refKey));
  }, []);

  return { states, tabs, starting, forgetRef };
}
