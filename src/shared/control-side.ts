import { CONTROL_VERBS } from "./control";
import type { ControlVerb } from "./control";

/** How far a verb reaches from a caller: any repository or worktree it names, the caller's own
 *  project's, or only the caller's own repository or worktree. */
export type ControlReach = "any" | "ownProject" | "ownRef";

/**
 * Where a control caller runs — this machine or an sbx sandbox — and everything the control
 * channel grants and says differently because of it: which verbs answer, how far they reach, and
 * the words of `tet-ctl help` and of the system prompt. Shared by the server, `tet-ctl` and the
 * agents' setup; nothing else asks which side a caller is on. The main process's extension is
 * control/caller-side.ts.
 */
export interface ControlSide {
  /** Written into the tab's control token (control-token.ts), which is how the server tells the
   *  sides apart. */
  readonly key: "host" | "sandbox";
  /** Whether the verb answers at all; one refused is left out of `tet-ctl help` too. */
  admits(entry: ControlVerb): boolean;
  /** How a refused verb is answered: `<verb> <refusal>`. */
  readonly refusal: string;
  /** How far an admitted verb reaches. */
  reach(entry: ControlVerb): ControlReach;
  /** What `tet-ctl help` closes with: the rules the verb list does not carry, each side told only
   *  its own. */
  readonly limits: readonly string[];
}

const OWN_LIMITS = [
  "Without flags, a verb acts on where the tab it is run from runs: its project's repository or",
  "one of its worktrees. --project <id> alone means that project's repository,",
  "--worktree <branch> one of its worktrees. A worktree listed without a key (projects-list) was",
  "made outside TET, with plain git: TET shows it greyed and cannot open it."
];

/** A tab on this machine: every verb, across its project where a verb says so
 *  (ControlVerb.ownProjectOnly). A sandbox is no concern of it, which cannot end up in one. */
export const HOST_SIDE: ControlSide = {
  key: "host",
  admits: () => true,
  refusal: "does not answer here",
  reach: (entry) => (entry.ownProjectOnly ? "ownProject" : "any"),
  limits: [
    ...OWN_LIMITS,
    "restartRequired in an answer means the change waits for a restart — tell the user, never",
    "restart for them. A terminal of another project is refused, exit 2 with the reason on stderr",
    "(tabs-output, tabs-keys)."
  ]
};

/** A tab in an sbx sandbox: only the verbs that say how far it may reach (ControlVerb.sandbox) —
 *  the sandbox is the organization's policy, and a verb acting on this machine would walk around it. */
export const SANDBOX_SIDE: ControlSide = {
  key: "sandbox",
  admits: (entry) => entry.sandbox !== undefined,
  refusal: "does not answer from inside a sandbox",
  reach: (entry) => (entry.sandbox === "any" ? HOST_SIDE.reach(entry) : (entry.sandbox ?? "ownRef")),
  limits: [
    ...OWN_LIMITS,
    "This tab runs in an sbx sandbox: what acts on the host machine — its settings and projects,",
    "restarting TET, a saved command, any tab running on the host — is refused there and is not listed",
    "above. The tab verbs reach every tab running in a sandbox of this project, its repository's and",
    "every worktree's; a tab they open runs in a sandbox too. The rest answers for this repository or",
    "worktree only (exit 2, the reason on stderr)."
  ]
};

/** Whether the side admits the verb named; what the help and the system prompt mention follows it. */
export function admitsVerb(side: ControlSide, verb: string): boolean {
  const entry = CONTROL_VERBS.find((candidate) => candidate.verb === verb);
  return entry !== undefined && side.admits(entry);
}
