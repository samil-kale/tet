/**
 * How the environment variables kept in tet (environment.ts) meet this machine's — apart from the
 * store, so the control server and pty.ts reach it without electron. What a name may be is
 * src/shared/env-rules.ts, which the Settings' tab shares.
 */

/** Names the variables a tab got from the ones kept in tet, so a tet started from that tab does
 *  not take them for the machine's (`machineSets`). */
export const KEPT_ENV_NAME = "TET_KEPT_ENV";

/** A variable's name as this machine compares it: win32 ignores case. */
export function machineName(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

/** Whether the environment tet was started with — what every tab would inherit — has the name. One
 *  a tet it was started from set itself (a tab of it running `npm start`) is not the machine's. */
export function machineSets(name: string): boolean {
  const wanted = machineName(name);
  const inherited = (process.env[KEPT_ENV_NAME] ?? "").split(",").map(machineName);
  return !inherited.includes(wanted) && Object.keys(process.env).some((key) => machineName(key) === wanted);
}
