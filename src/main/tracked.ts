import { failure } from "../shared/errors";
import { effectivePrompt } from "../shared/prompts";
import type { AgentId } from "../shared/types/agents";
import { worktreeName, worktreeOf, type ProjectRef } from "../shared/types/project";
import { capitalized, trackedFileName, type TrackedKind, type TrackedRef } from "../shared/types/providers";
import type { HandoverResult, TabDescriptor, TrackedSession } from "../shared/types/terminals";
import {
  changeRequestFieldOptions,
  changeRequestImage,
  changeRequestMarkdown,
  changeRequestPrompt,
  commentChangeRequest,
  deleteChangeRequestComment,
  editChangeRequestComment,
  markChangeRequestsSeen,
  readChangeRequest,
  setChangeRequestField,
  updateChangeRequest,
} from "./change-requests/tracker";
import type { TrackedOps } from "./ctl/ctl-verb";
import {
  commentIssue,
  deleteIssueComment,
  editIssueComment,
  issueFieldOptions,
  issueImage,
  issuePrompt,
  markIssuesSeen,
  readIssue,
  setIssueField,
  updateIssue,
  type TrackedDeps,
} from "./issues";
import { issueMarkdown } from "./providers/tracker";
import { notOpenMessage, PROJECT_NOT_FOUND } from "./store/resolved-ref";

/**
 * What an issue and a change request do alike, by kind: the tab of either, the session linked to it
 * and the `tet-ctl` verbs of both. An issue goes to the Issues section's tracker (issues.ts), a change
 * request to the repository's own remote (change-requests/tracker.ts).
 */
export function trackedOps(deps: TrackedDeps): Record<TrackedKind, TrackedOps> {
  return {
    issue: {
      nameOf: (number) => `issue #${number}`,
      read: async (projectId, number) => {
        const detail = await readIssue(deps, projectId, number);
        return { detail, markdown: issueMarkdown(detail) };
      },
      agentFile: async (ref, number) => ({
        content: issueMarkdown(await readIssue(deps, ref.projectId, number)),
        prompt: issuePrompt(effectivePrompt(deps.settings.get().prompts.texts, "issue"), number),
      }),
      image: (projectId, source) => issueImage(deps, projectId, source),
      fieldOptions: (projectId, number, fieldId) => issueFieldOptions(deps, projectId, number, fieldId),
      setField: (projectId, number, fieldId, value) => setIssueField(deps, projectId, number, fieldId, value),
      update: (projectId, number, change) => updateIssue(deps, projectId, number, change),
      comment: (projectId, number, body, internal) => commentIssue(deps, projectId, number, body, internal),
      editComment: (projectId, id, body) => editIssueComment(deps, projectId, id, body),
      deleteComment: (projectId, id) => deleteIssueComment(deps, projectId, id),
      markSeen: (projectId, number) => markIssuesSeen(deps, projectId, number),
    },
    "change-request": {
      nameOf: (number) => `change request ${number}`,
      read: async (projectId, number) => {
        const detail = await readChangeRequest(deps, projectId, number);
        return { detail, markdown: changeRequestMarkdown(detail) };
      },
      agentFile: async (ref, number) => {
        const request = await readChangeRequest(deps, ref.projectId, number);
        return { content: changeRequestMarkdown(request), prompt: changeRequestPrompt(deps, ref, request) };
      },
      image: (projectId, source) => changeRequestImage(deps, projectId, source),
      fieldOptions: (projectId, number, fieldId) => changeRequestFieldOptions(deps, projectId, number, fieldId),
      setField: (projectId, number, fieldId, value) => setChangeRequestField(deps, projectId, number, fieldId, value),
      update: (projectId, number, change) => updateChangeRequest(deps, projectId, number, change),
      // Neither host keeps internal comments of a change request.
      comment: (projectId, number, body) => commentChangeRequest(deps, projectId, number, body),
      editComment: (projectId, id, body) => editChangeRequestComment(deps, projectId, id, body),
      deleteComment: (projectId, id) => deleteChangeRequestComment(deps, projectId, id),
      markSeen: (projectId, number) => markChangeRequestsSeen(deps, projectId, number),
    },
  };
}

/**
 * The session linked to each of the project's issues or change requests, as its repository or
 * worktrees show it, on the strip or archived: read off its tab's descriptor (`TabDescriptor.linked`),
 * so a rename or archive shows at once, and a tab waiting to link its session stands in for it
 * (tracked-links.ts). One no tab shows (a worktree closed, a session gone) is left out.
 */
export function trackedSessions(
  deps: Pick<TrackedDeps, "store" | "tabManagers">,
  projectId: string,
  kind: TrackedKind,
): Record<number, TrackedSession> {
  const project = deps.store.get(projectId);
  if (!project) {
    throw new Error(PROJECT_NOT_FOUND);
  }
  const sessions: Record<number, TrackedSession> = {};
  for (const manager of deps.tabManagers.forProject(projectId)) {
    const { ref } = manager.at;
    const worktree = worktreeOf(project, ref);
    const shown = (tabs: TabDescriptor[], archived: boolean): void => {
      for (const { linked, tabId, agentId, title } of tabs) {
        const number = linked?.[kind];
        if (number !== undefined) {
          sessions[number] = { ref, ...(worktree && { worktree: worktreeName(worktree) }), tabId, agentId, title, archived };
        }
      }
    };
    shown(manager.snapshot(), false);
    shown(manager.archivedSnapshot(), true);
  }
  return sessions;
}

/**
 * A new tab of the agent in the repository or worktree, read from its host, the issue or change
 * request its first prompt; the tab shows it as a file, and its session is linked to it once it has
 * one. Refused for one that has a session: it has one. The caller checks that the agent takes a
 * prompt. `sandboxOnly`: opened from a sandbox, so it never runs on this machine
 * (`TabSessionManager.createTab`).
 */
export async function sendTrackedToAgent(
  deps: Pick<TrackedDeps, "store" | "tabManagers">,
  ops: Record<TrackedKind, TrackedOps>,
  ref: ProjectRef,
  tracked: TrackedRef,
  agentId: AgentId,
  sandboxOnly = false,
): Promise<HandoverResult> {
  try {
    const manager = deps.tabManagers.get(ref);
    if (!manager) {
      throw new Error(notOpenMessage(deps.store, ref));
    }
    const op = ops[tracked.kind];
    if (tracked.number in trackedSessions(deps, ref.projectId, tracked.kind)) {
      throw new Error(`${capitalized(op.nameOf(tracked.number))} has a session already`);
    }
    const { content, prompt } = await op.agentFile(ref, tracked.number);
    const tab = manager.createTabOnFile(agentId, { name: trackedFileName(tracked), content, prompt }, sandboxOnly);
    // A fresh tab has no session yet, so this only notes it on the tab.
    manager.link(tab.tabId, tracked);
    return { ok: true, tab };
  } catch (error) {
    return failure(error);
  }
}
