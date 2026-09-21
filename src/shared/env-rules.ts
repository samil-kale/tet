/**
 * What a name kept in tet's environment (src/main/environment.ts) may be, and why a row of the
 * Settings' Environment tab cannot be saved — one rule for the tab's marks and the store's refusal.
 * `ignoreCase` is the machine's: win32 takes `a` and `A` for one variable.
 */

import type { EnvEdit } from "./types";

/** A name a shell can export: letters, digits, underscores, not starting with a digit. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Names tet sets in a tab itself (`PATH` with its launcher dir, `TET_*` for the control channel):
 *  one kept in tet would replace the machine's whole PATH, or be overwritten. */
export function isReservedName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === "PATH" || upper.startsWith("TET_");
}

/** Why the row cannot be saved beside those before it, or undefined. */
export function envRowRefusal(row: EnvEdit, before: EnvEdit[], ignoreCase: boolean): string | undefined {
  const same = (name: string): string => (ignoreCase ? name.toUpperCase() : name);
  if (!isEnvName(row.name)) {
    return `${row.name || "A variable"} is not an environment variable name: letters, digits and _, not starting with a digit`;
  }
  if (isReservedName(row.name)) {
    return `${row.name} is TET's own to set in a tab (PATH, TET_*)`;
  }
  if (before.some((other) => same(other.name) === same(row.name))) {
    return `${row.name} is there twice`;
  }
  if (row.from === undefined && !row.value) {
    return `${row.name} needs a value`;
  }
  return undefined;
}

/** The first row's refusal, or undefined when all of them can be saved. */
export function envEditRefusal(rows: EnvEdit[], ignoreCase: boolean): string | undefined {
  for (const [index, row] of rows.entries()) {
    const refusal = envRowRefusal(row, rows.slice(0, index), ignoreCase);
    if (refusal) {
      return refusal;
    }
  }
  return undefined;
}
