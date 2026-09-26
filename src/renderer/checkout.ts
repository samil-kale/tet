import { checkoutKey, checkoutName, checkoutsOf, worktreeOf } from "../shared/types";
import type { CheckoutRef, Project, ProjectWorktree } from "../shared/types";
import { stableRecord } from "./identity";

/**
 * A checkout as the window holds it: a project's main worktree, or one of the worktrees TET made.
 * Views take this, keep their records by `key` and hand `ref` to main — never a ref built inline,
 * which would be a new prop on every render.
 */
export interface Checkout {
  /** `checkoutKey(ref)`: what every record of the window is keyed by. */
  key: string;
  ref: CheckoutRef;
  /** Absent for the main worktree. */
  worktree?: ProjectWorktree;
  /** Its folder. */
  path: string;
  /** What a row, a dialog or a notice calls it (checkoutName). */
  name: string;
}

function checkoutFor(project: Project, ref: CheckoutRef): Checkout {
  const worktree = worktreeOf(project, ref);
  return {
    key: checkoutKey(ref),
    ref,
    worktree,
    path: worktree?.path ?? project.path,
    name: checkoutName(project, ref)
  };
}

/** Unchanged where what it shows is: every `projects:changed` brings new objects, so all is
 *  compared by value — the ref by its key. */
function sameCheckout(previous: Checkout, entry: Checkout): boolean {
  return (
    previous.key === entry.key &&
    previous.path === entry.path &&
    previous.name === entry.name &&
    previous.worktree?.branch === entry.worktree?.branch
  );
}

/** Every open checkout by key, in the sidebar's order, each kept where unchanged (`ref` holds
 *  what was last handed out). */
export function checkoutsByKey(ref: { current: Record<string, Checkout> }, projects: Project[]): Record<string, Checkout> {
  const next: Record<string, Checkout> = {};
  for (const project of projects) {
    for (const checkout of checkoutsOf(project)) {
      const entry = checkoutFor(project, checkout);
      next[entry.key] = entry;
    }
  }
  return stableRecord(ref, next, sameCheckout);
}
