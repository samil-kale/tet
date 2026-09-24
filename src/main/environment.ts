import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../shared/errors";
import type { EnvAnswer, EnvEdit, EnvRequest, EnvVarInfo } from "../shared/types";
import { envEditRefusal } from "../shared/env-rules";
import { machineName, machineSets } from "./env-names";
import { isRecord, saveJson } from "./json-file";
import { seal, unseal } from "./sealed";

/** What the file holds: the variable plus its value, encrypted by the OS and base64-wrapped. */
interface StoredVar {
  name: string;
  value: string;
}

/** The variable as the renderer and `env-list` may see it — every field but the value. */
function toInfo(entry: StoredVar): EnvVarInfo {
  return { name: entry.name, overridesMachine: machineSets(entry.name) };
}

function isStoredVar(entry: unknown): entry is StoredVar {
  return isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string";
}

/** The file as read: the rows understood, and the rest kept verbatim for the next write. */
interface Contents {
  variables: StoredVar[];
  others: unknown[];
}

/**
 * The environment variables tet sets in the tabs it starts (pty.ts's `setStoredEnv`), global to
 * every project. A value leaves this class only decrypted into a tab's environment; the renderer
 * and `tet-ctl` never see one.
 *
 * Read from the file on every call, never held: the file is small, and what changed it from outside
 * is neither hidden nor overwritten. A file that cannot be read is written over by nothing — every
 * change refuses, naming it — and a row not understood (a newer shape) is kept as it is.
 */
export class EnvStore {
  private readonly file: string;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "environment.json");
  }

  /** Nothing when the file cannot be read; every change says why. */
  list(): EnvVarInfo[] {
    return this.readable()?.variables.map(toInfo) ?? [];
  }

  info(name: string): EnvVarInfo | undefined {
    const entry = this.readable()?.variables.find((variable) => variable.name === name);
    return entry && toInfo(entry);
  }

  /** Every value decrypted, for a tab's start; one sealed under a keychain this machine no longer
   *  has is left out, to be asked for again. */
  values(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const entry of this.readable()?.variables ?? []) {
      const value = unseal(entry.value);
      if (value === undefined) {
        console.error(`[tet] could not decrypt the environment variable ${entry.name}`);
      } else {
        values[entry.name] = value;
      }
    }
    return values;
  }

  /** Adds the variables, or replaces what is stored under their names — never two rows. Throws
   *  before changing anything, as `seal` does. */
  set(variables: EnvAnswer[]): void {
    const stored = variables.map((variable): StoredVar => ({ name: variable.name, value: seal(variable.value) }));
    // By the machine's rule: on win32 `gitlab_token` would be a second GITLAB_TOKEN in every tab.
    const names = new Set(stored.map((variable) => machineName(variable.name)));
    const contents = this.read();
    const kept = contents.variables.filter((variable) => !names.has(machineName(variable.name)));
    this.write({ ...contents, variables: [...kept, ...stored] });
  }

  /**
   * The Settings' Environment tab on Save: every variable there is, as edited — a row without a new
   * value keeps its stored one, even renamed; one left out is deleted. Throws before changing
   * anything, naming the first row it cannot take (envEditRefusal) or, as `seal` does, the OS.
   */
  edit(rows: EnvEdit[]): void {
    const refusal = envEditRefusal(rows, process.platform === "win32");
    if (refusal) {
      throw new Error(refusal);
    }
    const contents = this.read();
    const variables = rows.map((row): StoredVar => {
      const stored = contents.variables.find((variable) => variable.name === row.from);
      if (row.value === undefined && !stored) {
        throw new Error(`${row.name} has no value: it was deleted meanwhile`);
      }
      return { name: row.name, value: row.value === undefined ? stored!.value : seal(row.value) };
    });
    this.write({ ...contents, variables });
  }

  /** False when there was nothing under the name. */
  remove(name: string): boolean {
    const contents = this.read();
    const kept = contents.variables.filter((variable) => variable.name !== name);
    if (kept.length === contents.variables.length) {
      return false;
    }
    this.write({ ...contents, variables: kept });
    return true;
  }

  /** No file yet is no variables; one that is not a JSON list throws, so nothing writes over it. */
  private read(): Contents {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { variables: [], others: [] };
      }
      throw new Error(`${this.file} cannot be read: ${errorMessage(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${this.file} is not a list of environment variables; fix or delete it`);
    }
    return { variables: parsed.filter(isStoredVar), others: parsed.filter((entry) => !isStoredVar(entry)) };
  }

  private readable(): Contents | undefined {
    try {
      return this.read();
    } catch (error) {
      console.error("[tet] could not read the environment variables:", error);
      return undefined;
    }
  }

  private write({ variables, others }: Contents): void {
    // Renamed into place: never half a file for `read` to refuse.
    saveJson(this.file, [...others, ...variables], "the environment variables");
  }
}

/** What `env-request` passes on: the asking tab and the names. */
export interface EnvAsk {
  projectId?: string;
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
      projectId: ask.projectId,
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
