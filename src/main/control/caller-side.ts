import * as fs from "node:fs";
import * as path from "node:path";
import type { ControlVerb } from "../../shared/control";
import type { Project } from "../../shared/types";
import { hasSandbox, type AgentDefinition } from "../agents/agent";
import { HOST_TAB, SANDBOX_TAB, type TabSide } from "../terminals/tab-side";
import { relativeInside } from "../util/path-inside";
import type { InspectedTab } from "../terminals/session-manager";
import { ControlError } from "./control-verb";

/**
 * ControlSide with what only the main process does differently for a caller on this machine and
 * one in a sandbox: the variables its tab is started with (TabSide), the tabs and projects it sees,
 * the agents it may open, and what an answer may hand it. Chosen once — by the tab's place for its
 * spawn (TabPlace), by the tab's token for a request (control-server's `handle`) — and nothing
 * else asks which side a caller is on.
 */
export interface CallerSide extends TabSide {
  /** Whether the caller may open a tab of this agent. */
  opens(agent: AgentDefinition): boolean;
  /** Whether a tab the caller opens runs in the sandbox or not at all (TabState.sandboxOnly). */
  readonly holdsTabs: boolean;
  /** Whether the caller may reach into this tab (its output, its session); `own` is its own tab. */
  reachesTab(tab: InspectedTab | undefined, own: boolean): boolean;
  /** The projects `projects-list` shows it. */
  projects(list: Project[], own: { projectId?: string; worktree?: string }): Project[];
  /** Refuses an answer that would hand the caller what its side must not see. */
  checkAnswer(entry: ControlVerb, result: unknown, root: string | undefined): Promise<void>;
}

/** A tab on this machine: its variables, every agent, every tab and project. */
export const HOST_CALLER: CallerSide = {
  ...HOST_TAB,
  opens: () => true,
  holdsTabs: false,
  reachesTab: () => true,
  projects: (list) => list,
  checkAnswer: () => Promise.resolve()
};

/**
 * A tab in an sbx sandbox, with none of TET's stored variables (SANDBOX_TAB). It opens only an agent that runs in a sandbox, held there — a shell would run on this
 * machine. It reaches only its own tab or one running there: a host tab is this machine's, and
 * its output may print the host's control token. It sees its own project only, and of its
 * worktrees only the one it runs in.
 */
export const SANDBOX_CALLER: CallerSide = {
  ...SANDBOX_TAB,
  opens: hasSandbox,
  holdsTabs: true,
  reachesTab: (tab, own) => own || tab?.sandbox !== undefined || tab?.sandboxOnly === true,
  projects: (list, own) =>
    list
      .filter((entry) => entry.id === own.projectId)
      .map((entry) => ({
        ...entry,
        worktrees: entry.worktrees.filter((worktree) => worktree.key !== undefined && worktree.key === own.worktree)
      })),
  checkAnswer: (entry, result, root) =>
    entry.sandboxFile === undefined ? Promise.resolve() : assertSandboxFile(root, result, entry.sandboxFile)
};

/** Both, for the server to try a tab's token against (control-token.ts). */
export const CALLER_SIDES: readonly CallerSide[] = [HOST_CALLER, SANDBOX_CALLER];

/**
 * The file an answer names (`ControlVerb.sandboxFile`), refused where it is missing or resolves,
 * links followed, outside the repository: a link committed or made in the mounted repository would
 * otherwise hand a sandboxed caller a file of this machine through the editor. Missing too, since
 * the editor still holds what it last read. An answer naming none is nothing to refuse.
 */
async function assertSandboxFile(root: string | undefined, result: unknown, key: string): Promise<void> {
  const named = (result as Record<string, unknown> | null | undefined)?.[key];
  if (named === undefined || named === null) {
    return;
  }
  const relative = typeof named === "string" ? named : undefined;
  const resolved =
    root === undefined || relative === undefined
      ? undefined
      : await Promise.all([root, path.join(root, relative)].map((entry) => fs.promises.realpath(path.resolve(entry)))).catch(
          () => undefined
        );
  if (!resolved || relativeInside(resolved[0], resolved[1]) === undefined) {
    throw new ControlError("unauthorized", `${String(named)} is missing or leads outside the repository`);
  }
}
