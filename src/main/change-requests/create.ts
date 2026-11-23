import { errorMessage, failure } from "../../shared/errors";
import { effectivePrompt } from "../../shared/prompts";
import type { SuggestionResult } from "../../shared/types/agents";
import { headRemote, headRemoteBranch, type RepositoryState } from "../../shared/types/git";
import type { ProjectRef } from "../../shared/types/project";
import type {
  ChangeRequestCreateResult,
  ChangeRequestFindResult,
  ChangeRequestFollowUps,
  ChangeRequestInput,
  ChangeRequestTargetResult,
} from "../../shared/types/providers";
import { suggestChangeRequest as suggestText } from "../agents/suggest";
import { git } from "../git/git-client";
import { hostProvider, NoAccountError, onHost, parseRemoteUrl, WRITE_HANDS_OVER, type TrackerAccounts } from "../providers/tracker";
import type { GitProvider, Tracker } from "../providers/provider";
import { notOpenMessage } from "../store/resolved-ref";
import type { ProjectStore } from "../store/project-store";
import type { SettingsAccess } from "../store/settings";

/**
 * A pull or merge request from the checked-out branch, into a branch of the repository it is pushed
 * to (`headRemote`), on that remote's host, through the host's accounts as the Issues section reaches
 * its tracker (`onHost`): what Branches' button and the checked-out branch's menu ask.
 */
export interface ChangeRequestDeps {
  accounts: TrackerAccounts;
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
 * The repository or worktree, its push target and the branches of the remote but its own, or why it
 * has none. It merges into `into`, one of those; asked for none, into the one offered first: the base
 * TET recorded when it made the branch (`WorktreeInfo.base`), else the default branch, each where the
 * remote has it, else the remote's first.
 */
function targetOf(
  deps: Pick<ChangeRequestDeps, "repositories" | "store">,
  ref: ProjectRef,
  into?: string,
): { cwd: string; target: PushTarget; branches: string[] } | { refusal: string } {
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
  const branches = (known?.branches ?? []).filter((name) => name !== head);
  if (branches.length === 0) {
    return { refusal: `${remote} has no other branch to merge ${state.head} into` };
  }
  if (into !== undefined && !branches.includes(into)) {
    return { refusal: `${remote} has no branch ${into} to merge ${state.head} into` };
  }
  const base = state.worktrees.find((worktree) => worktree.current)?.base;
  const offered = [base, state.defaultBranch?.name].find((name) => name !== undefined && branches.includes(name)) ?? branches[0];
  return { cwd: repository.at.path, target: { remote, ...parsed, head, into: into ?? offered }, branches };
}

/** `targetOf`, its refusal thrown. */
function requireTarget(
  deps: Pick<ChangeRequestDeps, "repositories" | "store">,
  ref: ProjectRef,
  into?: string,
): { cwd: string; target: PushTarget } {
  const found = targetOf(deps, ref, into);
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
  return provider ? { kind: provider.changeRequests.kind, into, branches: found.branches } : { refusal: new NoAccountError(host).message };
}

/** The checked-out branch's open one, asked of its host. */
export async function findChangeRequest(
  deps: Pick<ChangeRequestDeps, "accounts" | "repositories" | "store">,
  ref: ProjectRef,
): Promise<ChangeRequestFindResult> {
  try {
    const { target } = requireTarget(deps, ref);
    const open = await onHost(deps.accounts, target, (provider, tracker) => provider.changeRequests.find(tracker, target.head));
    return { ok: true, open };
  } catch (error) {
    return failure(error);
  }
}

/** Its title and description, suggested from the commits `into`, the branch it merges into, lacks. */
export async function suggestChangeRequest(
  deps: Pick<ChangeRequestDeps, "repositories" | "settings" | "store">,
  ref: ProjectRef,
  into: string,
): Promise<SuggestionResult> {
  const found = targetOf(deps, ref, into);
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

/** Opens one from the checked-out branch, pushed by then, and approves it and sets it to auto-merge
 *  as asked, through the account that opened it. A write: another account takes over only from one
 *  that does not reach the repository (`WRITE_HANDS_OVER`). */
export async function createChangeRequest(
  deps: Pick<ChangeRequestDeps, "accounts" | "repositories" | "store">,
  ref: ProjectRef,
  { into, title, description, draft, deleteSourceBranch, ...asked }: ChangeRequestInput,
): Promise<ChangeRequestCreateResult> {
  try {
    const { target } = requireTarget(deps, ref, into);
    const created = await onHost(
      deps.accounts,
      target,
      async (provider, tracker) => {
        const opened = await provider.changeRequests.create(tracker, {
          head: target.head,
          base: target.into,
          title,
          body: description,
          draft,
          deleteSourceBranch,
        });
        return { ...opened, ...(await approveAndAutoMerge(provider, tracker, opened.number, asked)) };
      },
      WRITE_HANDS_OVER,
    );
    return { ok: true, ...created };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Approves an open one and sets it to auto-merge, as asked, approving first: the approval may be what
 * the merge waits on. Never throws, as the request stands either way: thrown inside `onHost`'s call,
 * a failure would hand over to the next account, which would open a second one.
 */
export async function approveAndAutoMerge(
  provider: GitProvider,
  tracker: Tracker,
  number: number,
  { approve, autoMerge, squash }: Pick<ChangeRequestInput, "approve" | "autoMerge" | "squash">,
): Promise<ChangeRequestFollowUps> {
  const told: ChangeRequestFollowUps = {};
  if (approve) {
    try {
      await provider.changeRequests.approve(tracker, number);
    } catch (error) {
      told.approveError = errorMessage(error);
    }
  }
  if (autoMerge) {
    try {
      await provider.changeRequests.autoMerge(tracker, number, squash);
    } catch (error) {
      told.autoMergeError = errorMessage(error);
    }
  }
  return told;
}
