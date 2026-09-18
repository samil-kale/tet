import * as fs from "node:fs";
import * as path from "node:path";
import { safeStorage } from "electron";
import writeFileAtomic from "write-file-atomic";

/** What the file holds: per project id, each secret's value by env name, encrypted by the OS and
 *  base64-wrapped. */
type StoredSecrets = Record<string, Record<string, string>>;

/**
 * The values of the sbx dialog's Secrets, which tet.json never holds (its rows are only names and
 * hosts). Kept here because sbx cannot give one back and forgets a sandbox's with `sbx rm`, so a
 * rebuilt sandbox is seeded from here (sbx.ts's applySecrets). A value leaves this class only
 * decrypted into `sbx secret set-custom`; the renderer never sees one.
 */
export class SbxSecretStore {
  private readonly file: string;
  private secrets: StoredSecrets = {};

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "sbx-secrets.json");
    this.load();
  }

  /** The env names holding a value for the project that can still be decrypted — the ones a spawn
   *  applies, so the dialog asks again for the others. */
  stored(projectId: string): string[] {
    return [...this.values(projectId).keys()];
  }

  /**
   * Stores the values and drops those of every env name not in `keep` (rows removed in the
   * dialog). Throws before changing anything when the OS offers no encryption — on Linux without a
   * keyring, where safeStorage would fall back to a fixed key.
   */
  update(projectId: string, values: Record<string, string>, keep: string[]): void {
    if (Object.keys(values).length > 0 && !safeStorage.isEncryptionAvailable()) {
      throw new Error("The OS offers no encryption to store a secret with (on Linux: no keyring)");
    }
    const project = Object.fromEntries(Object.entries(this.secrets[projectId] ?? {}).filter(([env]) => keep.includes(env)));
    for (const [env, value] of Object.entries(values)) {
      project[env] = safeStorage.encryptString(value).toString("base64");
    }
    this.setProject(projectId, project);
  }

  /** The decrypted values by env name; one that cannot be decrypted is left out. */
  values(projectId: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const [env, encrypted] of Object.entries(this.secrets[projectId] ?? {})) {
      try {
        values.set(env, safeStorage.decryptString(Buffer.from(encrypted, "base64")));
      } catch {
        // Encrypted under a keychain this machine no longer has; the value must be re-entered.
      }
    }
    return values;
  }

  /** A removed project's values: its sandboxes' names (sbx.ts's sandboxName) never come back. */
  forgetProject(projectId: string): void {
    this.setProject(projectId, {});
  }

  /** The project's values as stored, still encrypted — for `restore` under a project's new id
   *  (a renamed worktree, projects.ts's withWorktreeClosed). */
  encrypted(projectId: string): Record<string, string> {
    return { ...(this.secrets[projectId] ?? {}) };
  }

  restore(projectId: string, encrypted: Record<string, string>): void {
    this.setProject(projectId, encrypted);
  }

  /** Written only on a change: every SBX Save passes through `update`. */
  private setProject(projectId: string, project: Record<string, string>): void {
    if (JSON.stringify(project) === JSON.stringify(this.secrets[projectId] ?? {})) {
      return;
    }
    if (Object.keys(project).length > 0) {
      this.secrets[projectId] = project;
    } else {
      delete this.secrets[projectId];
    }
    this.save();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [projectId, project] of Object.entries(parsed)) {
          if (typeof project !== "object" || project === null || Array.isArray(project)) {
            continue;
          }
          const values = Object.entries(project).filter((entry): entry is [string, string] => typeof entry[1] === "string");
          if (values.length > 0) {
            this.secrets[projectId] = Object.fromEntries(values);
          }
        }
      }
    } catch {
      // No file yet, or unreadable — no secrets.
    }
  }

  private save(): void {
    try {
      // Renamed into place: `load` reads a half-written file as none, and the next save would keep that.
      writeFileAtomic.sync(this.file, JSON.stringify(this.secrets, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist sbx secrets:", error);
    }
  }
}
