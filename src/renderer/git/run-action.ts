import { useCallback, useMemo, useRef, useState } from "react";
import type { GitActionResult, GitLogin } from "../../shared/types/git";
import { refusal } from "../ui/Dialog";
import { notify } from "../ui/Notices";
import { useRunning } from "../ui/use-running";
import { askLogin } from "./GitLogin";

/**
 * How a view runs an action, and where its failure is told (AGENTS.md: a dialog on screen carries
 * its own failure). Every runner here hands the failure back as a message, for the question that
 * stays up to show it under the field the answer was typed in (`prompt`'s `submit`); `notifying`
 * turns one into the notice an action with no dialog up needs instead.
 *
 * A question carries its progress the same way — the dialog header's bar (`DialogFrame`'s `busy`)
 * is the one indicator while it is up. So `ask` leaves the view's bar alone and only `run`/`act`,
 * which have no dialog to show them, raise it; two bars for one command is the bug this avoids.
 *
 * A file action needs no label — the pane's own bar covers the whole section — while a git command
 * says what it is doing.
 */
export type FileAsk = (action: () => Promise<GitActionResult>) => Promise<string | undefined>;

/** `FileAsk` with its failure notified. */
export type FileAct = (action: () => Promise<GitActionResult>) => void;

/** A git command, handed the login typed for its remote when its first try answered `loginUrl`. A
 *  command reaching no remote ignores it. */
type GitAction = (login?: GitLogin) => Promise<GitActionResult>;

/** The same pair for a git command, labelled while it runs. `run`'s command asks for a login it
 *  wants (`gitRun`); `ask`'s cannot, since a question is already up and only one can be. */
export interface GitRun {
  run: (label: string, action: GitAction) => void;
  ask: (label: string, action: GitAction) => Promise<string | undefined>;
}

/** One git command at a time per repository or worktree, labelled while it runs (`GitRun`). The tree asks its
 *  questions itself, knowing which remote holds a branch and where HEAD is. */
export interface BranchActions extends GitRun {
  /** A command runs in this repository or worktree; no second one is offered. */
  busy: boolean;
  /** That command was started here, so the git lane's bar shows it; one started from the project
   *  list shows in that list's bar instead. */
  startedHere: boolean;
}

/** How a view hands a git command to App's runner, which answers with the result as it is. */
type GitRunner = (action: () => Promise<GitActionResult>) => Promise<GitActionResult>;

/**
 * A `GitRun` over App's runner. `run` goes through `onBar`, which raises the view's bar, and
 * notifies a refusal — but one for want of a login asks for it (`askLogin`) and runs the command
 * again with it, through `offBar`, on the question's own bar. `ask` goes through `offBar` for the
 * same reason, handing the refusal back to its question.
 */
function gitRun(onBar: GitRunner, offBar: GitRunner): GitRun {
  return {
    run: (label, action) =>
      void onBar(() => action()).then(async (result) => {
        const loginUrl = result.loginUrl;
        if (loginUrl !== undefined) {
          await askLogin(loginUrl, result.error ?? `${label} failed`, async (login) =>
            refusal(await offBar(() => action(login)), `${label} failed`)
          );
        } else if (!result.ok) {
          notify("error", result.error ?? `${label} failed`);
        }
      }),
    ask: async (label, action) => refusal(await offBar(() => action()), `${label} failed`)
  };
}

/**
 * An action whose first try may answer `needsConfirmation`: its run ends there, bar and lock
 * released, and the follow-up question comes after it; a yes starts the confirmed action as a new
 * run. The bar shows tet working, never tet waiting on the user. `start` is how the view runs an
 * action (`act`, a `GitRun`'s `run`); `ask` the question, handed the first try's answer.
 */
export function runWithFollowUp(
  start: (action: () => Promise<GitActionResult>) => void,
  first: () => Promise<GitActionResult>,
  needs: NonNullable<GitActionResult["needsConfirmation"]>,
  ask: (result: GitActionResult) => Promise<boolean>,
  confirmed: () => Promise<GitActionResult>
): void {
  start(async () => {
    const result = await first();
    if (result.needsConfirmation !== needs) {
      return result;
    }
    void ask(result).then((yes) => {
      if (yes) {
        start(confirmed);
      }
    });
    return { ok: true };
  });
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
 * Runs a file action. The running mark is per repository or worktree, since one lane serves all; called once
 * per section, each with its own bar, and raised by `act` alone. Counted, not flagged: an action
 * the main process refuses while another runs (a context menu entry during a commit) ends first,
 * and must not clear the mark of the one still running.
 */
export function useFileAct(key: string): { acting: boolean; act: FileAct; ask: FileAsk } {
  const [actingIn, setActingIn] = useState<ReadonlyMap<string, number>>(() => new Map());
  const count = useCallback(
    (delta: number): void =>
      setActingIn((current) => {
        const next = new Map(current);
        const running = (next.get(key) ?? 0) + delta;
        if (running > 0) {
          next.set(key, running);
        } else {
          next.delete(key);
        }
        return next;
      }),
    [key]
  );
  const ask: FileAsk = useCallback(async (action) => refusal(await action(), "Git command failed"), []);
  const act: FileAct = useMemo(
    () =>
      notifying(async (action: () => Promise<GitActionResult>) => {
        count(1);
        try {
          return await ask(action);
        } finally {
          count(-1);
        }
      }),
    [count, ask]
  );
  return { acting: actingIn.has(key), act, ask };
}

/**
 * The same for a branch command, which App runs (`runBranchAction`: one per repository or worktree, whatever
 * started it) while the bar belongs to the view that offered it — the git lane and the project
 * list each have one. Counted for the same reason as above, and wrapped around `run` alone: what a
 * question asked for runs on the question's bar.
 */
function useStartedHere<A extends unknown[], R>(
  run: (...args: A) => Promise<R>
): { startedHere: boolean; start: (...args: A) => Promise<R> } {
  const { running, run: hold } = useRunning();
  const start = useCallback((...args: A) => hold(() => run(...args)), [hold, run]);
  return { startedHere: running, start };
}

/**
 * App's gate for the branch commands: one per repository or worktree at a time, whoever started it — a second
 * click mid-switch would stack two `git switch`. Mirrors `Repository.runAction`; `BranchActions.run`
 * is the one way in for them, a view asking its own question first (`ask`). Hands out the git lane's actions for
 * the repository or worktree on screen (`activeBranch`, its bar showing what it started, `ask` excepted: the
 * question that asked for it shows that one) and the project list's way of running a command in
 * any repository or worktree it lists (`runIn`, on the list's bar, `projectListBusy`).
 */
export function useBranchActions(activeKey: string | null): {
  activeBranch: BranchActions;
  projectListBusy: boolean;
  runIn: (key: string) => GitRun;
} {
  /** Repositories and worktrees with a branch command in flight: a fetch ending in A must not free B. */
  const [branchActions, setBranchActions] = useState<ReadonlySet<string>>(() => new Set());
  /** Read synchronously: a second double-click can land before a re-render. */
  const branchActionsRef = useRef(new Set<string>());
  const runBranchAction = useCallback(
    async (key: string, action: () => Promise<GitActionResult>): Promise<GitActionResult> => {
      if (branchActionsRef.current.has(key)) {
        return { ok: false, error: "Another command is running in this repository" };
      }
      branchActionsRef.current.add(key);
      setBranchActions(new Set(branchActionsRef.current));
      try {
        return await action();
      } finally {
        branchActionsRef.current.delete(key);
        setBranchActions(new Set(branchActionsRef.current));
      }
    },
    []
  );
  const runActiveBranchAction = useCallback(
    (action: () => Promise<GitActionResult>): Promise<GitActionResult> =>
      activeKey ? runBranchAction(activeKey, action) : Promise.resolve({ ok: true }),
    [activeKey, runBranchAction]
  );
  const { startedHere: gitPaneActing, start: runActiveHere } = useStartedHere(runActiveBranchAction);
  const activeBranch = useMemo<BranchActions>(
    () => ({
      busy: activeKey !== null && branchActions.has(activeKey),
      startedHere: gitPaneActing,
      ...gitRun(runActiveHere, runActiveBranchAction)
    }),
    [branchActions, activeKey, gitPaneActing, runActiveHere, runActiveBranchAction]
  );
  const { startedHere: projectListBusy, start: runProjectListHere } = useStartedHere(runBranchAction);
  const runIn = useCallback(
    (key: string): GitRun =>
      gitRun(
        (action) => runProjectListHere(key, action),
        (action) => runBranchAction(key, action)
      ),
    [runProjectListHere, runBranchAction]
  );
  return { activeBranch, projectListBusy, runIn };
}
