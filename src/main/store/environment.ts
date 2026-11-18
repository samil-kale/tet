import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../../shared/errors";
import type { EnvAnswer, EnvEdit, EnvVarInfo } from "../../shared/types/environment";
import { envEditRefusal } from "../../shared/env-rules";
import { machineName, machineSets } from "./env-names";
import { hasStrings, writeJson } from "../util/json-file";
import { PLATFORM } from "../util/host-platform";
import { logError } from "../util/error-log";
import { seal, unseal } from "../util/sealed";

/** What the file holds: the variable plus its value, in the clear (`text`) or encrypted by the OS and
 *  base64-wrapped (`sealed`). */
type StoredVar = { name: string } & ({ text: string; sealed?: undefined } | { sealed: string; text?: undefined });

/** The variable as the renderer and `env-list` may see it — every field but the value. */
function toInfo(entry: StoredVar): EnvVarInfo {
  return { name: entry.name, overridesMachine: machineSets(entry.name) };
}

function isStoredVar(entry: unknown): entry is StoredVar {
  return hasStrings(entry, "name", "text") || hasStrings(entry, "name", "sealed");
}

/** The row's value; undefined when it was sealed under a keychain this machine no longer has. */
async function valueOf(entry: StoredVar): Promise<string | undefined> {
  if (entry.text !== undefined) {
    return entry.text;
  }
  const value = await unseal(entry.sealed);
  if (value === undefined) {
    logError(`could not decrypt the environment variable ${entry.name}`);
  }
  return value;
}

/** Throws where the OS offers no encryption, saying what the user can do about it. */
async function sealed(entry: StoredVar): Promise<StoredVar> {
  if (entry.text === undefined) {
    return entry;
  }
  try {
    return { name: entry.name, sealed: await seal(entry.text) };
  } catch (error) {
    throw new Error(`${errorMessage(error)}. Untick "Encrypt stored values" in the Settings' Environment tab to keep them in the clear`, {
      cause: error,
    });
  }
}

/** A value that cannot be decrypted stays sealed, to be replaced: never lost for the switch. */
async function inTheClear(entry: StoredVar): Promise<StoredVar> {
  const text = await valueOf(entry);
  return text === undefined || entry.text !== undefined ? entry : { name: entry.name, text };
}

/** Every row as `encryptValues` keeps it; a row already so is the same object. */
function stored(variables: StoredVar[], encryptValues: boolean): Promise<StoredVar[]> {
  return Promise.all(variables.map(encryptValues ? sealed : inTheClear));
}

/** The file as read: the rows understood, and the rest kept verbatim for the next write. */
interface Contents {
  variables: StoredVar[];
  others: unknown[];
}

/**
 * The environment variables TET sets in the tabs it starts (pty.ts's `TerminalEnv.stored`), global to
 * every project: encrypted or in the clear as the Environment tab says (`encryptValues`), and set over
 * what the machine sets itself, said in a notice. A value leaves this class only into a tab's
 * environment; the renderer and `tet-ctl` never see one. A running tab takes them up only when
 * restarted, the asking one too (`restartRequired`). None in a sandbox, whose side neither admits
 * the verbs nor mentions them (`ControlSide.admits`).
 *
 * Read from the file on every call, never held: the file is small, and what changed it from outside
 * is neither hidden nor overwritten. A file that cannot be read is written over by nothing — every
 * change refuses, naming it — and a row not understood (a newer shape) is kept as it is. Changes run
 * one at a time (`serial`): encrypting lies between a change's read and its write.
 */
export class EnvStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataRoot: string,
    /** The Environment tab's checkbox (EnvironmentSettings), read at each change. */
    private readonly encryptValues: () => boolean,
  ) {
    this.file = path.join(dataRoot, "environment.json");
  }

  /** Nothing when the file cannot be read; every change says why. */
  list(): EnvVarInfo[] {
    return this.readable()?.variables.map(toInfo) ?? [];
  }

  info(name: string): EnvVarInfo | undefined {
    const entry = this.readable()?.variables.find((variable) => machineName(variable.name) === machineName(name));
    return entry && toInfo(entry);
  }

  /** Every value, for a tab's start; one that cannot be decrypted is left out. */
  async values(): Promise<Record<string, string>> {
    const entries = await Promise.all(
      (this.readable()?.variables ?? []).map(async (entry): Promise<[string, string | undefined]> => [entry.name, await valueOf(entry)]),
    );
    return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== undefined));
  }

  /** Adds the variables, or replaces what is stored under their names — never two rows. */
  set(variables: EnvAnswer[]): Promise<void> {
    return this.serial(async () => {
      const added = variables.map((variable): StoredVar => ({ name: variable.name, text: variable.value }));
      // By the machine's rule: on win32 `gitlab_token` would be a second GITLAB_TOKEN in every tab.
      const names = new Set(added.map((variable) => machineName(variable.name)));
      const contents = this.read();
      const kept = contents.variables.filter((variable) => !names.has(machineName(variable.name)));
      this.write({ ...contents, variables: await stored([...kept, ...added], this.encryptValues()) });
    });
  }

  /**
   * The Settings' Environment tab on Save: every variable there is, as edited — a row without a new
   * value keeps its stored one, even renamed; one left out is deleted — all kept as `encryptValues`
   * says. Throws before changing anything, naming the first row it cannot take (envEditRefusal), or
   * where the OS offers no encryption.
   */
  edit(rows: EnvEdit[], encryptValues: boolean): Promise<void> {
    return this.serial(async () => {
      const refusal = envEditRefusal(rows, PLATFORM.envNamesIgnoreCase);
      if (refusal) {
        throw new Error(refusal);
      }
      const contents = this.read();
      const variables = rows.map((row): StoredVar => {
        if (row.value !== undefined) {
          return { name: row.name, text: row.value };
        }
        const kept = contents.variables.find((variable) => variable.name === row.from);
        if (!kept) {
          throw new Error(`${row.name} has no value: it was deleted meanwhile`);
        }
        return { ...kept, name: row.name };
      });
      this.write({ ...contents, variables: await stored(variables, encryptValues) });
    });
  }

  /** False when there was nothing under the name. */
  remove(name: string): Promise<boolean> {
    return this.serial(() => {
      const contents = this.read();
      const kept = contents.variables.filter((variable) => machineName(variable.name) !== machineName(name));
      if (kept.length === contents.variables.length) {
        return false;
      }
      this.write({ ...contents, variables: kept });
      return true;
    });
  }

  /** At TET's start, what the file holds brought to the checkbox, written only if that changes a row.
   *  Where it cannot be, the values stay as they are and still reach the tabs. */
  applyEncryption(): Promise<void> {
    return this.serial(async () => {
      const contents = this.read();
      const variables = await stored(contents.variables, this.encryptValues());
      if (variables.some((variable, index) => variable !== contents.variables[index])) {
        this.write({ ...contents, variables });
      }
    }).catch((error: unknown) => logError("could not apply the environment variables' encryption", error));
  }

  private serial<T>(change: () => T | Promise<T>): Promise<T> {
    const turn = this.queue.then(change);
    this.queue = turn.catch(() => undefined);
    return turn;
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
    return {
      variables: parsed.filter(isStoredVar),
      others: parsed.filter((entry) => !isStoredVar(entry)),
    };
  }

  private readable(): Contents | undefined {
    try {
      return this.read();
    } catch (error) {
      logError("could not read the environment variables", error);
      return undefined;
    }
  }

  private write({ variables, others }: Contents): void {
    // Renamed into place: never half a file for `read` to refuse.
    writeJson(this.file, [...others, ...variables]);
  }
}
