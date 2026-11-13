import { useEffect, useState } from "react";
import type { IssueSession } from "../../shared/types/terminals";

const NONE: IssueSession[] = [];

/**
 * The sessions linked to the project's issue, as their tabs show them (`issues.sessions`), read
 * again whenever what they show may have changed: a tab or an archived one of the project, a link
 * made or taken off by hand, a worktree renamed. None for a tab that shows no issue.
 */
export function useIssueSessions(projectId: string | undefined, number: number | undefined): IssueSession[] {
  const [sessions, setSessions] = useState<IssueSession[]>(NONE);

  useEffect(() => {
    if (projectId === undefined || number === undefined) {
      setSessions(NONE);
      return;
    }
    // Only the latest read lands: an earlier answer may come after it.
    let latest = 0;
    const read = (): void => {
      const seq = ++latest;
      void window.tet.issues.sessions(projectId, number).then((result) => {
        if (seq === latest) {
          setSessions(result.sessions ?? NONE);
        }
      });
    };
    const readFor = (changed: string): void => {
      if (changed === projectId) {
        read();
      }
    };
    read();
    const unsubscribers = [
      window.tet.tabs.onTabs(({ ref }) => readFor(ref.projectId)),
      window.tet.archive.onChanged(({ ref }) => readFor(ref.projectId)),
      window.tet.issues.onSessionsChanged(readFor),
      window.tet.projects.onChanged(read),
    ];
    return () => {
      latest = -1;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [projectId, number]);

  return sessions;
}
