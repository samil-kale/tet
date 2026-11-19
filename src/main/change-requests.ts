import { failure } from "../shared/errors";
import { effectivePrompt } from "../shared/prompts";
import type { SuggestionResult } from "../shared/types/agents";
import { headRemote, headRemoteBranch, type RepositoryState } from "../shared/types/git";
import type { ProjectRef } from "../shared/types/project";
import type {
  ChangeRequestCreateResult,
  ChangeRequestFindResult,
  ChangeRequestInput,
  ChangeRequestTargetResult,
} from "../shared/types/providers";
import { suggestChangeRequest as suggestText } from "./agents/suggest";
import { git } from "./git/git-client";
import { hostProvider, NoAccountError, onHost, parseRemoteUrl, WRITE_HANDS_OVER, type IssueAccounts } from "./providers/issues";
import { notOpenMessage } from "./store/resolved-ref";
import type { ProjectStore } from "./store/project-store";
import type { SettingsAccess } from "./store/settings";

/**
 * A pull or merge request from the checked-out branch, into a branch of the repository it is pushed
 * to (`headRemote`), on that remote's host, through the host's accounts as the ISSUES section reaches
 * its tracker (`onHost`): what BRANCHES' button and the checked-out branch's menu ask.
 */
export interface ChangeRequestDeps {
  accounts: IssueAccounts;
  repositories: { get(ref: ProjectRef): { at: { path: string }; getState(): RepositoryState } | undefined };
  settings: SettingsAccess;
  store: ProjectStore;
}

/** Where the checked-out branch goes: its remote, that remote's host and repository path, the
 *  branch's name there (`headRemoteBranch`), and the branch it merges into. */
interface PushTarget {
  remote: string;
  host: string;
  path: string;
  head: string;
  into: string;
}

/**
 * The repository or worktree and its push target, or why it has none. The branch it merges into is
 * derived as t3code derives it, never picked: the base TET recorded when it made the branch
 * (`headBase`), else the default branch, else "main". t3code's other two sources stay out: a
 * configured merge ref TET never writes, and an upstream of another name, which a branch TET made
 * never has (`createBranch`'s `--no-track`).
 */
function targetOf(
  deps: Pick<ChangeRequestDeps, "repositories" | "store">,
  ref: ProjectRef,
): { cwd: string; target: PushTarget } | { refusal: string } {
  const repository = deps.repositories.get(ref);
  if (!repository) {
    return { refusal: notOpenMessage(deps.store, ref) };
  }
  const state = repository.getState();
  if (state.detached || state.head === "") {
    return { refusal: "Only a checked-out branch can be opened as a pull or merge request" };
  }
  const remote = headRemote(state);
  if (remote === undefined) {
    return { refusal: "This repository has no remote" };
  }
  const known = state.remotes.find((entry) => entry.name === remote);
  const parsed = known?.url === undefined ? undefined : parseRemoteUrl(known.url);
  if (!parsed) {
    return { refusal: `The remote ${remote} is on no host` };
  }
  const head = headRemoteBranch(state);
  const into = state.headBase ?? state.defaultBranch?.name ?? "main";
  if (into === head) {
    return { refusal: `${state.head} is the base branch` };
  }
  if (!known?.branches.includes(into)) {
    return { refusal: `${remote} has no branch ${into} to merge ${state.head} into` };
  }
  // The default branch's merged ones are read anyway; another target's would take a process.
  if (into === state.defaultBranch?.name && state.mergedBranches.includes(state.head)) {
    return { refusal: `No new commits on ${state.head} to merge into ${into}` };
  }
  return { cwd: repository.at.path, target: { remote, ...parsed, head, into } };
}

/** `targetOf`, its refusal thrown. */
function requireTarget(deps: Pick<ChangeRequestDeps, "repositories" | "store">, ref: ProjectRef): { cwd: string; target: PushTarget } {
  const found = targetOf(deps, ref);
  if ("refusal" in found) {
    throw new Error(found.refusal);
  }
  return found;
}

/** Where it goes, and what the push target's host calls one, by its accounts' provider, without
 *  asking it. */
export function changeRequestTarget(
  deps: Pick<ChangeRequestDeps, "accounts" | "repositories" | "store">,
  ref: ProjectRef,
): ChangeRequestTargetResult {
  const found = targetOf(deps, ref);
  if ("refusal" in found) {
    return found;
  }
  const { host, into } = found.target;
  const provider = hostProvider(deps.accounts, host);
  return provider ? { kind: provider.changeRequest, into } : { refusal: new NoAccountError(host).message };
}

/** The checked-out branch's open one, asked of its host. */
export async function findChangeRequest(
  deps: Pick<ChangeRequestDeps, "accounts" | "repositories" | "store">,
  ref: ProjectRef,
): Promise<ChangeRequestFindResult> {
  try {
    const { target } = requireTarget(deps, ref);
    const open = await onHost(deps.accounts, target, (provider, tracker) => provider.findChangeRequest(tracker, target.head));
    return { ok: true, open };
  } catch (error) {
    return failure(error);
  }
}

/** Its title and description, suggested from the commits the branch it merges into lacks. */
export async function suggestChangeRequest(
  deps: Pick<ChangeRequestDeps, "repositories" | "settings" | "store">,
  ref: ProjectRef,
): Promise<SuggestionResult> {
  const found = targetOf(deps, ref);
  if ("refusal" in found) {
    return { error: found.refusal };
  }
  const { cwd, target } = found;
  const { commitSuggesters, texts } = deps.settings.get().prompts;
  return suggestText(
    commitSuggesters,
    cwd,
    effectivePrompt(texts, "changeRequest"),
    () => git.readRangeContext(cwd, `${target.remote}/${target.into}`),
    `No new commits on ${target.head} to merge into ${target.into}`,
  );
}

/** Opens one from the checked-out branch, pushed by then. A write: another account takes over only
 *  from one that does not reach the repository (`WRITE_HANDS_OVER`). */
export async function createChangeRequest(
  deps: Pick<ChangeRequestDeps, "accounts" | "repositories" | "store">,
  ref: ProjectRef,
  { title, description }: ChangeRequestInput,
): Promise<ChangeRequestCreateResult> {
  try {
    const { target } = requireTarget(deps, ref);
    const created = await onHost(
      deps.accounts,
      target,
      (provider, tracker) => provider.createChangeRequest(tracker, { head: target.head, base: target.into, title, body: description }),
      WRITE_HANDS_OVER,
    );
    return { ok: true, ...created };
  } catch (error) {
    return failure(error);
  }
}
