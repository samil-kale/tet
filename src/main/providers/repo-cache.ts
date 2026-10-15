import * as path from "node:path";
import type { RemoteRepository } from "../../shared/types/providers";
import { hasStrings, isRecord, logFailure, readJson, writeJson } from "../util/json-file";

/** The last repository listing of each account, shown at once while the next one is fetched. Holds
 *  no secret; a stale list is only ever shown until the fresh one replaces it. */
export class RepoCache {
  private readonly file: string;
  private lists: Record<string, RemoteRepository[]> = {};

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "repos-cache.json");
    this.load();
  }

  get(accountId: string): RemoteRepository[] | undefined {
    return this.lists[accountId];
  }

  /** Nobody waits on the write: a failure is logged and the cache keeps what the disk has. */
  set(accountId: string, repos: RemoteRepository[]): void {
    this.keep({ ...this.lists, [accountId]: repos });
  }

  remove(accountId: string): void {
    if (accountId in this.lists) {
      const rest = { ...this.lists };
      delete rest[accountId];
      this.keep(rest);
    }
  }

  private keep(lists: Record<string, RemoteRepository[]>): void {
    logFailure("keep the repositories cache", () => {
      writeJson(this.file, lists);
      this.lists = lists;
    });
  }

  private load(): void {
    const parsed = readJson(this.file);
    if (!isRecord(parsed)) {
      return;
    }
    for (const [accountId, rows] of Object.entries(parsed)) {
      if (Array.isArray(rows)) {
        this.lists[accountId] = rows.filter((row): row is RemoteRepository => hasStrings(row, "fullName", "name", "cloneUrl"));
      }
    }
  }
}
