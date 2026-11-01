/** What an action answers: done, or refused (ActionRefused). A new verb a dialog calls answers its
 *  failure this way (a git command's may be a question too, `GitActionResult`) rather than sending
 *  `app:notice`: the dialog stays up while it runs, and shows it (`useSubmit`). */
export type ActionResult = ActionDone | ActionRefused;

export interface ActionDone {
  ok: true;
}

/** Refused, in the words of whatever refused it (shared/errors.ts's errorMessage), never TET's
 *  guess at them. */
export interface ActionRefused {
  ok: false;
  error: string;
}
