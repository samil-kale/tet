import type { Notice } from "../../shared/types/app";
import {
  capitalized,
  changeRequestName,
  DEFAULT_CHANGE_REQUEST_FILTER,
  type ChangeRequestKind,
  type ChangeRequestRow,
  type ChangeRequestsLatest,
} from "../../shared/types/providers";
import type { TrackedDeps } from "../issues";
import { NoAccountError, NoRemoteError } from "../providers/tracker";
import { mapLimited } from "../util/async";
import { logError } from "../util/error-log";
import { latestChangeRequests, openChangeRequests } from "./tracker";

/** How often every open project's change requests are read. */
const WATCH_MS = 120_000;
/** How many projects a round reads at once. */
const WATCH_CONCURRENCY = 2;

/** Everything of a project's open change requests a round tells from, in one text: the host's probe
 *  of them (`readLatest`) shows no change when nothing here would. */
export function probeKey(latest: ChangeRequestsLatest): string {
  return `${latest.total}\u0000${latest.updatedAt ?? ""}\u0000${latest.checks}`;
}

/** What the window tells the watch: whether it is out of sight (minimized or hidden), and when it is back. */
export interface WatchWindow {
  outOfSight(): boolean;
  onForeground(listener: () => void): void;
}

/** What a round keeps of an open change request for the next: whether it was a draft, and the head
 *  commit whose failed checks were told. */
interface Watched {
  draft: boolean;
  failedHead?: string;
}

/** What one project's round tells, from what the last one kept (`before`, undefined for its first,
 *  which only keeps): one opened or made ready by someone else, and one of `viewer`'s whose checks failed
 *  on a head commit not told before. Answers what the next round compares with. */
export function compareRound(
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
 * Each project is probed every `WATCH_MS` and its list read only once the probe differs from the last
 * round's (a host whose probe fails is read in full), its first round after the start only kept; a
 * round never overlaps the one before, reads `WATCH_CONCURRENCY` projects at a time and is held back
 * while the window is out of sight, to run once it is back; nothing is read while both
 * notifications are off. A round's failure is logged once until one succeeds again; a
 * project without an account or a remote on a host has nothing to tell.
 */
export class ChangeRequestWatch {
  private readonly kept = new Map<string, Map<number, Watched>>();
  private readonly failing = new Set<string>();
  /** Per project, `probeKey` of what its kept rows were read at. */
  private readonly probed = new Map<string, string>();
  private running = false;
  private skipped = false;

  constructor(
    private readonly deps: Pick<TrackedDeps, "accounts" | "repositories" | "settings" | "store">,
    private readonly notify: (notice: Notice) => void,
    private readonly window?: WatchWindow,
  ) {}

  /** Once, at the app's start. */
  start(): void {
    this.window?.onForeground(() => {
      if (this.skipped) {
        void this.round();
      }
    });
    setInterval(() => void this.round(), WATCH_MS);
    void this.round();
  }

  /** One round over every open project. */
  private async round(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.window?.outOfSight()) {
      this.skipped = true;
      return;
    }
    this.skipped = false;
    this.running = true;
    try {
      const { changeRequestOpened, changeRequestFailed } = this.deps.settings.get().notifications;
      if (!changeRequestOpened && !changeRequestFailed) {
        // Read afresh once one is on again: what was kept is stale by then.
        this.kept.clear();
        this.probed.clear();
        return;
      }
      const projects = this.deps.store.list();
      const open = new Set(projects.map((project) => project.id));
      for (const known of [...this.kept.keys(), ...this.probed.keys(), ...this.failing]) {
        if (!open.has(known)) {
          this.kept.delete(known);
          this.probed.delete(known);
          this.failing.delete(known);
        }
      }
      await mapLimited(projects, WATCH_CONCURRENCY, (project) =>
        this.watch(project.id, project.name, { opened: changeRequestOpened, failed: changeRequestFailed }),
      );
    } finally {
      this.running = false;
    }
  }

  /** The host's probe of the project's open change requests as `probeKey` says it; undefined where
   *  it cannot be read, which makes the round read the list. */
  private async probe(projectId: string): Promise<string | undefined> {
    try {
      return probeKey(await latestChangeRequests(this.deps, projectId, DEFAULT_CHANGE_REQUEST_FILTER));
    } catch {
      return undefined;
    }
  }

  private async watch(projectId: string, name: string, tell: { opened: boolean; failed: boolean }): Promise<void> {
    if (!this.deps.repositories.get({ projectId })) {
      return;
    }
    const probed = await this.probe(projectId);
    if (probed !== undefined && probed === this.probed.get(projectId) && this.kept.has(projectId)) {
      this.failing.delete(projectId);
      return;
    }
    let read: { rows: ChangeRequestRow[]; viewer: string; kind: ChangeRequestKind };
    try {
      read = await openChangeRequests(this.deps, projectId);
      this.failing.delete(projectId);
    } catch (error) {
      this.probed.delete(projectId);
      if (!(error instanceof NoAccountError) && !(error instanceof NoRemoteError) && !this.failing.has(projectId)) {
        this.failing.add(projectId);
        logError(`Could not read the change requests of ${name}`, error);
      }
      return;
    }
    const { rows, viewer, kind } = read;
    const { kept, opened, failed } = compareRound(this.kept.get(projectId), rows, viewer);
    this.kept.set(projectId, kept);
    if (probed === undefined) {
      this.probed.delete(projectId);
    } else {
      this.probed.set(projectId, probed);
    }
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
