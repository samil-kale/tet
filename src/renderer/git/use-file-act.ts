import { useCallback, useState } from "react";
import type { FileAct, FileAsk } from "./ChangesList";
import { notify } from "../ui/Notices";

/**
 * Runs a file action. The running mark is per project, since one side pane serves all; called once
 * per section, each with its own bar. Counted, not flagged: an action the main process refuses
 * while another runs (a context menu entry during a commit) ends first, and must not clear the mark
 * of the one still running.
 *
 * Two ways in, differing only in where the failure is told: `ask` hands it back, `act` notifies it
 * (see `notifyRefused`).
 */
export function useFileAct(projectId: string): { acting: boolean; act: FileAct; ask: FileAsk } {
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
  const ask: FileAsk = async (action) => {
    count(1);
    try {
      const result = await action();
      return result.ok ? undefined : (result.error ?? "Git command failed");
    } finally {
      count(-1);
    }
  };
  const act: FileAct = (action) => void ask(action).then(notifyRefused);
  return { acting: actingIn.has(projectId), act, ask };
}

/** What a `GitRun`'s `run` does with a failure its `ask` hands back: the notice `ask`'s caller
 *  would have shown at its field. */
export function notifyRefused(refused: string | undefined): void {
  if (refused !== undefined) {
    notify("error", refused);
  }
}

/**
 * The same for a branch command, which App runs (`runBranchAction`: one per project, whatever
 * started it) while the bar belongs to the view that offered it — the git pane and the project
 * list each have one. Counted for the same reason as above.
 */
export function useStartedHere<A extends unknown[], R>(
  run: (...args: A) => Promise<R>
): { startedHere: boolean; start: (...args: A) => Promise<R> } {
  const [running, setRunning] = useState(0);
  const start = useCallback(
    async (...args: A) => {
      setRunning((count) => count + 1);
      try {
        return await run(...args);
      } finally {
        setRunning((count) => count - 1);
      }
    },
    [run]
  );
  return { startedHere: running > 0, start };
}
