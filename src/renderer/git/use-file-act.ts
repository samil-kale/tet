import { useCallback, useState } from "react";
import type { FileAct } from "./ChangesList";
import { notify } from "../ui/Notices";

/**
 * Runs a file action, notifying on failure. The running mark is per project, since one side pane
 * serves all; called once per section, each with its own bar. Counted, not flagged: an action the
 * main process refuses while another runs (a context menu entry during a commit) ends first, and
 * must not clear the mark of the one still running.
 */
export function useFileAct(projectId: string): { acting: boolean; act: FileAct } {
  const [actingIn, setActingIn] = useState<ReadonlyMap<string, number>>(() => new Map());
  const count = (delta: number): void =>
    setActingIn((current) => {
      const next = new Map(current);
      const running = (next.get(projectId) ?? 0) + delta;
      if (running > 0) {
        next.set(projectId, running);
      } else {
        next.delete(projectId);
      }
      return next;
    });
  const act: FileAct = (action) => {
    count(1);
    void action()
      .then((result) => {
        if (!result.ok) {
          notify("error", result.error ?? "Git command failed");
        }
      })
      .finally(() => count(-1));
  };
  return { acting: actingIn.has(projectId), act };
}

/**
 * The same for a branch command, which App runs (`runBranchAction`: one per project, whatever
 * started it) while the bar belongs to the view that offered it — the git pane and the project
 * list each have one. Counted for the same reason as above.
 */
export function useStartedHere<A extends unknown[]>(
  run: (...args: A) => Promise<void>
): { startedHere: boolean; start: (...args: A) => void } {
  const [running, setRunning] = useState(0);
  const start = useCallback(
    (...args: A) => {
      setRunning((count) => count + 1);
      void run(...args).finally(() => setRunning((count) => count - 1));
    },
    [run]
  );
  return { startedHere: running > 0, start };
}
