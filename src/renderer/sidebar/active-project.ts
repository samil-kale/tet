import { checkoutKey, checkoutRef, checkoutsOf } from "../../shared/types";
import type { CheckoutRef, Project } from "../../shared/types";
import { layoutKey } from "../ui/layout-storage";

/** The checkout in front (its `checkoutKey`), in layout storage: which one is in front describes
 *  the window. */
const ACTIVE_PROJECT_KEY = layoutKey("active-project");

/** The checkout in front at startup: the one in front when tet last closed, while still open, else
 *  the first project's main worktree. */
export function activeAtStart(projects: readonly Project[]): string | null {
  const remembered = localStorage.getItem(ACTIVE_PROJECT_KEY);
  const open = projects.flatMap((project) => checkoutsOf(project).map(checkoutKey));
  const first = projects[0];
  return open.find((key) => key === remembered) ?? (first ? checkoutKey(checkoutRef(first.id)) : null);
}

/** Remembers the checkout in front for the next start; none leaves the last one standing. */
export function rememberActive(key: string | null): void {
  if (key !== null) {
    localStorage.setItem(ACTIVE_PROJECT_KEY, key);
  }
}

/**
 * The checkout in front after `projects:changed`, from the one in front before (`current`): the one
 * the user just opened (`show`) comes to the front. A removed checkout in front gives way to its
 * project's main worktree when it was a worktree of a project still open, else to the first
 * project's.
 */
export function activeAfterChange(
  current: string | null,
  after: readonly Project[],
  removed: readonly CheckoutRef[] | undefined,
  show: CheckoutRef | undefined
): string | null {
  if (show !== undefined) {
    return checkoutKey(show);
  }
  const gone = removed?.find((ref) => checkoutKey(ref) === current);
  if (gone === undefined) {
    return current;
  }
  const main = gone.worktree === undefined ? undefined : after.find((project) => project.id === gone.projectId);
  const next = main ?? after[0];
  return next ? checkoutKey(checkoutRef(next.id)) : null;
}
