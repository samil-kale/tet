import type { Notice } from "../../shared/types/app";
import { capitalized, changeRequestName, type ChangeRequestKind, type ChangeRequestRow } from "../../shared/types/providers";
import type { IssueDeps } from "../issues";
import { NoAccountError, NoRemoteError } from "../providers/issues";
import { logError } from "../util/error-log";
import { openChangeRequests } from "./tracker";

/** How often every open project's change requests are read. */
const WATCH_MS = 120_000;

/** What a round keeps of an open change request for the next: whether it was a draft, and the head
 *  commit whose failed checks were told. */
interface Watched {
  draft: boolean;
  failedHead?: string;
}

/** What one project's round tells, from what the last one kept (`before`, undefined for its first,
 *  which only keeps): one opened or made ready by someone else, and one of `viewer`'s whose checks failed
 *  on a head commit not told before. Answers what the next round compares with. */
function compareRound(
  before: ReadonlyMap<number, Watched> | undefined,
  rows: readonly ChangeRequestRow[],
  viewer: string,
): { kept: Map<number, Watched>; opened: ChangeRequestRow[]; failed: ChangeRequestRow[] } {
  const kept = new Map<number, Watched>();
  const opened: ChangeRequestRow[] = [];
  const failed: ChangeRequestRow[] = [];
  for (const row of rows) {
    const was = before?.get(row.number);
    const failedNow = row.checks === "failed" && row.headSha !== undefined;
    const told = was?.failedHead === row.headSha;
    kept.set(row.number, { draft: row.draft, failedHead: failedNow ? row.headSha : was?.failedHead });
    if (before === undefined) {
      continue;
    }
    if (row.author !== viewer && !row.draft && (was === undefined || was.draft)) {
      opened.push(row);
    }
    if (row.author === viewer && failedNow && !told) {
      failed.push(row);
    }
  }
  return { kept, opened, failed };
}

/**
 * Tells in the window of the change requests of every open project that need the user: one opened or
 * made ready by someone else, and one of the account's whose checks failed, once for each head commit.
 * Each project is read every `WATCH_MS`, its first round after the start only kept; nothing is read
 * while both notifications are off. A round's failure is logged once until one succeeds again; a
 * project without an account or a remote on a host has nothing to tell.
 */
export class ChangeRequestWatch {
  private readonly kept = new Map<string, Map<number, Watched>>();
  private readonly failing = new Set<string>();

  constructor(
    private readonly deps: Pick<IssueDeps, "accounts" | "repositories" | "settings" | "store">,
    private readonly notify: (notice: Notice) => void,
  ) {}

  /** Once, at the app's start. */
  start(): void {
    setInterval(() => void this.round(), WATCH_MS);
    void this.round();
  }

  /** One round over every open project. */
  private async round(): Promise<void> {
    const { changeRequestOpened, changeRequestFailed } = this.deps.settings.get().notifications;
    if (!changeRequestOpened && !changeRequestFailed) {
      // Read afresh once one is on again: what was kept is stale by then.
      this.kept.clear();
      return;
    }
    await Promise.all(
      this.deps.store
        .list()
        .map((project) => this.watch(project.id, project.name, { opened: changeRequestOpened, failed: changeRequestFailed })),
    );
  }

  private async watch(projectId: string, name: string, tell: { opened: boolean; failed: boolean }): Promise<void> {
    if (!this.deps.repositories.get({ projectId })) {
      return;
    }
    let read: { rows: ChangeRequestRow[]; viewer: string; kind: ChangeRequestKind };
    try {
      read = await openChangeRequests(this.deps, projectId);
      this.failing.delete(projectId);
    } catch (error) {
      if (!(error instanceof NoAccountError) && !(error instanceof NoRemoteError) && !this.failing.has(projectId)) {
        this.failing.add(projectId);
        logError(`Could not read the change requests of ${name}`, error);
      }
      return;
    }
    const { rows, viewer, kind } = read;
    const { kept, opened, failed } = compareRound(this.kept.get(projectId), rows, viewer);
    this.kept.set(projectId, kept);
    const opens = (row: ChangeRequestRow) => ({ projectId, tracked: { kind: "change-request" as const, number: row.number } });
    if (tell.opened) {
      for (const row of opened) {
        this.notify({
          severity: "info",
          title: `${name}: new ${kind.noun}`,
          message: `${changeRequestName(kind, row.number)} ${row.title}, by ${row.author}`,
          opens: opens(row),
        });
      }
    }
    if (tell.failed) {
      for (const row of failed) {
        this.notify({
          severity: "warning",
          title: `${name}: ${capitalized(kind.checks)} failed`,
          message: `${changeRequestName(kind, row.number)} ${row.title}`,
          opens: opens(row),
        });
      }
    }
  }
}
