import { HOST_SIDE, SANDBOX_SIDE, type ControlSide } from "../../shared/ctl-side";

/**
 * ControlSide with what a tab's start differs in between this machine and a sandbox, chosen by its
 * place (TabPlace.side). ctl/caller-side.ts extends it with what the tab's requests may do.
 */
export interface TabSide extends ControlSide {
  /** Whether TET's stored variables (environment.ts) reach the tab's process. */
  readonly storedEnv: boolean;
}

export const HOST_TAB: TabSide = { ...HOST_SIDE, storedEnv: true };

/** None of TET's stored variables: the sandbox gets only what its policy lets in. */
export const SANDBOX_TAB: TabSide = { ...SANDBOX_SIDE, storedEnv: false };
