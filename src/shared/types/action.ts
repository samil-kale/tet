/** What an action answers: done, or refused (ActionRefused). */
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
