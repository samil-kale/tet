import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../../shared/errors";
import type { EnvAnswer, EnvEdit, EnvVarInfo } from "../../shared/types/environment";
import { envEditRefusal } from "../../shared/env-rules";
import { machineName, machineSets } from "./env-names";
import { hasStrings, writeJson } from "../util/json-file";
import { PLATFORM } from "../util/host-platform";
import { logError } from "../util/error-log";

/** What the file holds: the variable plus its value in the clear, as every tab gets it anyway. */
interface StoredVar {
  name: string;
  text: string;
}

/** The variable as the renderer and `env-list` may see it — every field but the value. */
function toInfo(entry: StoredVar): EnvVarInfo {
  return { name: entry.name, overridesMachine: machineSets(entry.name) };
}

function isStoredVar(entry: unknown): entry is StoredVar {
  return hasStrings(entry, "name", "text");
}

/** The file as read: the rows understood, and the rest kept verbatim for the next write. */
interface Contents {
  variables: StoredVar[];
  others: unknown[];
}

/**
 * The environment variables TET sets in the tabs it starts (pty.ts's `setStoredEnv`), global to
 * every project. A value leaves this class only into a tab's environment; the renderer and
 * `tet-ctl` never see one.
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
    const entry = this.readable()?.variables.find((variable) => machineName(variable.name) === machineName(name));
    return entry && toInfo(entry);
  }

  /** Every value, for a tab's start. */
  values(): Record<string, string> {
    return Object.fromEntries((this.readable()?.variables ?? []).map((entry) => [entry.name, entry.text]));
  }

  /** Adds the variables, or replaces what is stored under their names — never two rows. */
  set(variables: EnvAnswer[]): void {
    const stored = variables.map((variable): StoredVar => ({ name: variable.name, text: variable.value }));
    // By the machine's rule: on win32 `gitlab_token` would be a second GITLAB_TOKEN in every tab.
    const names = new Set(stored.map((variable) => machineName(variable.name)));
    const contents = this.read();
    const kept = contents.variables.filter((variable) => !names.has(machineName(variable.name)));
    this.write({ ...contents, variables: [...kept, ...stored] });
  }

  /**
   * The Settings' Environment tab on Save: every variable there is, as edited — a row without a new
   * value keeps its stored one, even renamed; one left out is deleted. Throws before changing
   * anything, naming the first row it cannot take (envEditRefusal).
   */
  edit(rows: EnvEdit[]): void {
    const refusal = envEditRefusal(rows, PLATFORM.envNamesIgnoreCase);
    if (refusal) {
      throw new Error(refusal);
    }
    const contents = this.read();
    const variables = rows.map((row): StoredVar => {
      const stored = contents.variables.find((variable) => variable.name === row.from);
      if (row.value === undefined && !stored) {
        throw new Error(`${row.name} has no value: it was deleted meanwhile`);
      }
      return { name: row.name, text: row.value ?? stored!.text };
    });
    this.write({ ...contents, variables });
  }

  /** False when there was nothing under the name. */
  remove(name: string): boolean {
    const contents = this.read();
    const kept = contents.variables.filter((variable) => machineName(variable.name) !== machineName(name));
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
