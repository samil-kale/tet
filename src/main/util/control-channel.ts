/** The control channel as a start needs it: prepared before the first spawn (prepareControl), and
 *  none where that failed. */
export interface ControlChannel {
  token: string;
  port: number;
  /** The `tet-ctl` bundle, which a sandbox gets a copy of as it cannot reach the data folder's
   *  launcher (ensureSandboxLauncher). */
  cliPath: string;
  /** Prepended to every terminal's PATH: where the `tet-ctl` launchers are. None where they could
   *  not be written. */
  binDir?: string;
  /** Its port and token as a terminal gets them: above `process.env`, since a TET started from its
   *  own shell tab inherits the outer one's, and kept out of it so git does not carry them. */
  env: Record<string, string>;
}
