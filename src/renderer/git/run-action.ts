import { useCallback, useState } from "react";
import type { GitActionResult } from "../../shared/types";
import { notify } from "../ui/Notices";

/**
 * How a view runs an action, and where its failure is told (AGENTS.md: a dialog on screen carries
 * its own failure). Every runner here hands the failure back as a message, for the question that
 * stays up to show it under the field the answer was typed in (`prompt`'s `submit`); `notifying`
 * turns one into the notice an action with no dialog up needs instead.
 *
 * A file action needs no label — the pane's own bar covers the whole section — while a git command
 * says what it is doing.
 */
export type FileAsk = (action: () => Promise<GitActionResult>) => Promise<string | undefined>;

/** `FileAsk` with its failure notified. */
export type FileAct = (action: () => Promise<GitActionResult>) => void;

/** The same pair for a git command, labelled while it runs. */
export interface GitRun {
  run: (label: string, action: () => Promise<GitActionResult>) => void;
  ask: (label: string, action: () => Promise<GitActionResult>) => Promise<string | undefined>;
}

/** What a result refused, in its own words; `fallback` where the main process gave none. */
export function refusal(result: GitActionResult, fallback: string): string | undefined {
  return result.ok ? undefined : (result.error ?? fallback);
}

/** A runner with its failure notified rather than handed back: what `FileAct` and `GitRun.run`
 *  are, and what a change with no question up (a reorder, a remove) calls. */
export function notifying<A extends unknown[]>(
  ask: (...args: A) => Promise<string | undefined>
): (...args: A) => void {
  return (...args) =>
    void ask(...args).then((refused) => {
      if (refused !== undefined) {
        notify("error", refused);
      }
    });
}

/**
 * Runs a file action. The running mark is per project, since one side pane serves all; called once
 * per section, each with its own bar. Counted, not flagged: an action the main process refuses
 * while another runs (a context menu entry during a commit) ends first, and must not clear the mark
 * of the one still running.
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
      return refusal(await action(), "Git command failed");
    } finally {
      count(-1);
    }
  };
  return { acting: actingIn.has(projectId), act: notifying(ask), ask };
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
