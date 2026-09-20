/**
 * What a caught value says, for anything the user is shown — a notice, a dialog's error, a
 * `GitActionResult`. `String(error)` on an `Error` prefixes it with the class name ("Error: the
 * file changed on disk"), which is tet talking over whatever refused; the message alone is the
 * refusal's own words (AGENTS.md's rule for a dialog's error). An `Error` without a message falls
 * back to `String`, which at least names the class.
 *
 * Not for a log line or a text a caller matches against: those want everything the value carries.
 */
export function errorMessage(error: unknown): string {
  return (error instanceof Error && error.message) || String(error);
}
