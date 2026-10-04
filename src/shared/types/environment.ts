import type { ProjectRef } from "./project";

/** An environment variable TET sets in every tab it starts, a sandboxed one excepted, over the
 *  machine's own. Its value is kept main-side and reaches only a tab's environment. */
export interface EnvVarInfo {
  name: string;
  /** The environment TET was started with has it too — set on this machine (setx, a shell
   *  profile); TET's value replaces it in its tabs. */
  overridesMachine: boolean;
}

/** What TET tells the user of variables it keeps that the machine sets too — once at start, in the
 *  dialog that saved them, over their row in the Settings. */
export function overridesMachineNote(names: string[]): string {
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} set on this machine too; TET's value replaces it in the tabs it starts.`;
}

/** What `env-request` puts in front of the user: one row per variable. */
export interface EnvRequest {
  id: number;
  /** The asking tab, for the dialog to name and to restart. */
  ref?: ProjectRef;
  tabId?: string;
  /** A stored one's value the dialog replaces. */
  variables: (EnvVarInfo & { stored: boolean })[];
}

/** What the dialog answers per row, as typed; null for Cancel. */
export interface EnvAnswer {
  name: string;
  value: string;
}

/** A row of the Settings' Environment tab on Save: `from` names the stored variable it shows (so a
 *  renamed one keeps its value), `value` is what was typed — absent keeps the stored one. */
export interface EnvEdit {
  name: string;
  from?: string;
  value?: string;
}
