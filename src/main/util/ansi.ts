/**
 * One terminal escape sequence: a CSI with any parameter bytes (`<`, `=`, `>` included, as in
 * `\x1b[>4;1m`), an OSC ended by BEL or ST, or a two-byte escape.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/;

const ANSI_SEQUENCES = new RegExp(ANSI_SEQUENCE.source, "g");

/** The text without its escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCES, "");
}
