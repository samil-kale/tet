import { failure } from "../shared/errors";
import { effectivePrompt } from "../shared/prompts";
import type { AgentId } from "../shared/types/agents";
import type { ProjectRef } from "../shared/types/project";
import { DEFAULT_ISSUE_FILTER, isUnread, issueFileName, type Issue } from "../shared/types/providers";
import type { HandoverResult } from "../shared/types/terminals";
import {
  issueMarkdown,
  onTracker,
  readIssueTracker,
  setIssueSource,
  type IssueAccounts,
  type IssueRepository,
  type IssueTrackerInfo,
} from "./providers/issues";
import { forgetAllIssuesSeen, markAllIssuesSeen, readIssuesSeen, setIssueSeen } from "./store/issues-seen";
import type { ProjectStore } from "./store/project-store";
import { notOpenMessage, PROJECT_NOT_FOUND } from "./store/resolved-ref";
import type { SettingsAccess } from "./store/settings";
import { readIssueSource } from "./store/tet-json";
import type { SessionManagerRegistry } from "./terminals/session-registry";

/**
 * What the ISSUES section and `tet-ctl`'s issue verbs share, built once in main.ts like
 * `ProjectDeps`. A project's tracker is read through its repository, never a worktree's: the
 * repository and its worktrees share one.
 */
export interface IssueDeps {
  accounts: IssueAccounts;
  dataRoot: string;
  repositories: { get(ref: ProjectRef): IssueRepository | undefined };
  settings: SettingsAccess;
  store: ProjectStore;
  tabManagers: SessionManagerRegistry;
}

/** The project's repository, which its tracker is read through. */
export function issueRepository({ repositories }: Pick<IssueDeps, "repositories">, projectId: string): IssueRepository {
  const repository = repositories.get({ projectId });
  if (!repository) {
    throw new Error(PROJECT_NOT_FOUND);
  }
  return repository;
}

/** Where the project's issues are read from (`readIssueTracker`). */
export async function issueTrackerOf(deps: Pick<IssueDeps, "accounts" | "repositories">, projectId: string): Promise<IssueTrackerInfo> {
  return readIssueTracker(deps.accounts, issueRepository(deps, projectId));
}

/**
 * Saves the project's issue source (`setIssueSource`). What its issue tabs showed (`IssuesSeen`) is
 * forgotten once the source changed: its entries are the old source's issue numbers.
 */
export async function changeIssueSource(
  deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">,
  projectId: string,
  source: string,
): Promise<string | undefined> {
  const repository = issueRepository(deps, projectId);
  const before = await readIssueSource(repository.at.path);
  const saved = await setIssueSource(deps.accounts, repository, source);
  if (saved !== before) {
    forgetAllIssuesSeen(deps.dataRoot, projectId);
  }
  return saved;
}

/** The project's issues the tracker created or changed since their tab last showed them (`isUnread`),
 *  among those the ISSUES section lists until its filter is changed. */
export async function unreadIssues(deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">, projectId: string): Promise<Issue[]> {
  const issues = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.listIssues(tracker, DEFAULT_ISSUE_FILTER),
  );
  const seen = readIssuesSeen(deps.dataRoot, projectId);
  return issues.filter((issue) => isUnread(issue, seen));
}

/**
 * Counts the issue as its tab shows it, at the update the tracker has now; without a number, every
 * issue created or changed until now.
 */
export async function markIssuesSeen(
  deps: Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">,
  projectId: string,
  number?: number,
): Promise<void> {
  if (number === undefined) {
    markAllIssuesSeen(deps.dataRoot, projectId);
    return;
  }
  const { updatedAt } = await onTracker(deps.accounts, issueRepository(deps, projectId), (provider, tracker) =>
    provider.readIssue(tracker, number),
  );
  setIssueSeen(deps.dataRoot, projectId, number, updatedAt);
}

/** The first prompt of a tab opened on an issue: the settings' text, then which issue it is, ended
 *  by its file's path. */
function issuePrompt(text: string, number: number): string {
  return `${text}\n\nThe issue: #${number}. The file:`;
}

/**
 * A new tab of the agent in the repository or worktree, read from the tracker, the issue its first
 * prompt; the tab shows it as a file. The caller checks that the agent takes a prompt. `sandboxOnly`:
 * opened from a sandbox, so it never runs on this machine (`TabSessionManager.createTab`).
 */
export async function openIssueInAgent(
  deps: Pick<IssueDeps, "accounts" | "repositories" | "settings" | "store" | "tabManagers">,
  ref: ProjectRef,
  number: number,
  agentId: AgentId,
  sandboxOnly = false,
): Promise<HandoverResult> {
  try {
    const manager = deps.tabManagers.get(ref);
    if (!manager) {
      throw new Error(notOpenMessage(deps.store, ref));
    }
    const issue = await onTracker(deps.accounts, issueRepository(deps, ref.projectId), (provider, tracker) =>
      provider.readIssue(tracker, number),
    );
    const file = {
      name: issueFileName(number),
      content: issueMarkdown(issue),
      prompt: issuePrompt(effectivePrompt(deps.settings.get().prompts.texts, "issue"), number),
    };
    return { ok: true, tab: manager.createTabOnFile(agentId, file, sandboxOnly) };
  } catch (error) {
    return failure(error);
  }
}
