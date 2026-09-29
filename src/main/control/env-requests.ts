import { errorMessage } from "../../shared/errors";
import type { EnvAnswer, EnvRequest, ProjectRef } from "../../shared/types";
import { machineSets } from "../store/env-names";
import type { EnvStore } from "../store/environment";

/** What `env-request` passes on: the asking tab and the names. */
export interface EnvAsk {
  ref?: ProjectRef;
  tabId?: string;
  names: string[];
}

/**
 * The environment dialog's questions, one at a time: a second agent asking waits for the first
 * answer, so the window never shows two. The dialog saves through `answer` itself, so a failure
 * stays in it (a question runs its own answer); the asking verb learns only what was saved.
 */
export class EnvRequests {
  private lastId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private open: { request: EnvRequest; settle: (saved: string[] | undefined) => void } | undefined;

  /**
   * @param show puts a request in front of the user; false when no window listens yet.
   * @param withdraw takes an open request off the screen — its caller is gone.
   */
  constructor(
    private readonly store: EnvStore,
    private readonly show: (request: EnvRequest) => boolean,
    private readonly withdraw: (id: number) => void
  ) {}

  /** Resolves the names saved, or undefined on Cancel or once `gone` aborts. */
  ask(ask: EnvAsk, gone: AbortSignal): Promise<string[] | undefined> {
    const turn = this.queue.then(() => this.put(ask, gone));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** The dialog's Save (a row per variable) or Cancel (null); a string is why it could not be saved. */
  answer(id: number, answer: EnvAnswer[] | null): string | undefined {
    const open = this.open;
    if (open?.request.id !== id) {
      // Withdrawn while the user typed: nothing waits for it any more, and nothing was saved.
      return answer ? "The agent stopped waiting, so nothing was saved; it can ask again" : undefined;
    }
    if (!answer) {
      open.settle(undefined);
      return undefined;
    }
    // Only what was asked for, and every one of it: the names are the agent's, not the dialog's.
    const asked = open.request.variables.map((variable) => variable.name);
    const rows = asked.map((name) => answer.find((row) => row.name === name));
    if (rows.some((row) => !row || row.value === "")) {
      return "Every variable needs a value";
    }
    try {
      this.store.set(rows.map((row) => ({ name: row!.name, value: row!.value })));
    } catch (error) {
      return errorMessage(error);
    }
    open.settle(asked);
    return undefined;
  }

  /** The window reloaded: its dialog is gone, so the open request is answered as cancelled. */
  drop(): void {
    this.open?.settle(undefined);
  }

  private put(ask: EnvAsk, gone: AbortSignal): Promise<string[] | undefined> {
    if (gone.aborted) {
      return Promise.resolve(undefined);
    }
    this.lastId += 1;
    const request: EnvRequest = {
      id: this.lastId,
      ref: ask.ref,
      tabId: ask.tabId,
      variables: ask.names.map((name) => {
        const stored = this.store.info(name);
        // The spelling stored stands: Save replaces it (EnvStore.set).
        return { name, overridesMachine: machineSets(name), stored: stored !== undefined };
      })
    };
    if (!this.show(request)) {
      throw new Error("TET's window is not ready to ask; try again once it shows the workspace");
    }
    return new Promise((resolve) => {
      const cancel = (): void => {
        this.withdraw(request.id);
        settle(undefined);
      };
      const settle = (saved: string[] | undefined): void => {
        gone.removeEventListener("abort", cancel);
        this.open = undefined;
        resolve(saved);
      };
      gone.addEventListener("abort", cancel, { once: true });
      this.open = { request, settle };
    });
  }
}
