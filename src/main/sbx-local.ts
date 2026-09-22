import * as fs from "node:fs";
import * as path from "node:path";
import { safeStorage } from "electron";
import writeFileAtomic from "write-file-atomic";
import type { SbxLocalSave, SbxStoredLocal, SbxValueKind } from "../shared/types";

/** What the file holds per project id: each kind's values by env name, encrypted by the OS and
 *  base64-wrapped. */
export type StoredSbxLocal = Record<SbxValueKind, Record<string, string>>;

function emptyLocal(): StoredSbxLocal {
  return { secrets: {}, variables: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): Record<string, string> {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
}

/** A project's entry as read. One written before the variables was its secrets' values alone. */
function toLocal(project: Record<string, unknown>): StoredSbxLocal {
  if (isRecord(project.secrets) || isRecord(project.variables)) {
    return { secrets: stringsOf(project.secrets), variables: stringsOf(project.variables) };
  }
  return { secrets: stringsOf(project), variables: {} };
}

/**
 * The values of the sbx dialog's Secrets and Variables, which tet.json never holds (its rows are
 * only names and hosts). A secret's is kept because sbx cannot give one back and forgets a
 * sandbox's with `sbx rm`, so a rebuilt sandbox is seeded from here (sbx.ts's applySecrets). A value
 * leaves this class only decrypted into `sbx secret set-custom` or a sandboxed tab's `sbx run`
 * (sbx.ts's sandboxEnv); the renderer never sees one.
 */
export class SbxLocalStore {
  private readonly file: string;
  private projects: Record<string, StoredSbxLocal> = {};

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "sbx-local.json");
    // The file's name before it held the variables too; its shape is read by `toLocal`. Read in
    // place where it cannot be renamed, so no value is lost; the next save writes the new file.
    const legacy = path.join(dataRoot, "sbx-secrets.json");
    if (!fs.existsSync(this.file) && fs.existsSync(legacy)) {
      try {
        fs.renameSync(legacy, this.file);
      } catch (error) {
        console.error("[tet] could not rename sbx-secrets.json:", error);
        this.load(legacy);
        return;
      }
    }
    this.load(this.file);
  }

  /** The env names holding a value for the project that can still be decrypted — the ones a spawn
   *  applies, so the dialog asks again for the others. */
  stored(projectId: string): SbxStoredLocal {
    return {
      secrets: [...this.values(projectId, "secrets").keys()],
      variables: [...this.values(projectId, "variables").keys()]
    };
  }

  /**
   * Keeps what the dialog's rows hold: a typed value, else the stored one of the name the row was
   * opened under (`from`), so it follows a rename; a removed row's goes. Throws before changing
   * anything when the OS offers no encryption — on Linux without a keyring, where safeStorage would
   * fall back to a fixed key.
   */
  update(projectId: string, local: SbxLocalSave): void {
    const anyValue = Object.values(local).some((edits) => Object.keys(edits.values).length > 0);
    if (anyValue && !safeStorage.isEncryptionAvailable()) {
      throw new Error("The OS offers no encryption to store a value with (on Linux: no keyring)");
    }
    const current = this.projects[projectId] ?? emptyLocal();
    const next = emptyLocal();
    for (const kind of ["secrets", "variables"] as const) {
      const { values, from } = local[kind];
      for (const [env, name] of Object.entries(from)) {
        const stored = current[kind][name];
        if (stored !== undefined) {
          next[kind][env] = stored;
        }
      }
      for (const [env, value] of Object.entries(values)) {
        next[kind][env] = safeStorage.encryptString(value).toString("base64");
      }
    }
    this.setProject(projectId, next);
  }

  /** The decrypted values by env name; one that cannot be decrypted is left out. */
  values(projectId: string, kind: SbxValueKind): Map<string, string> {
    const values = new Map<string, string>();
    for (const [env, encrypted] of Object.entries(this.projects[projectId]?.[kind] ?? {})) {
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
    this.setProject(projectId, emptyLocal());
  }

  /** The project's values as stored, still encrypted — for `restore` under a project's new id
   *  (a renamed worktree, projects.ts's withWorktreeClosed). */
  encrypted(projectId: string): StoredSbxLocal {
    return structuredClone(this.projects[projectId] ?? emptyLocal());
  }

  restore(projectId: string, local: StoredSbxLocal): void {
    this.setProject(projectId, local);
  }

  /** Written only on a change: every SBX Save passes through `update`. */
  private setProject(projectId: string, local: StoredSbxLocal): void {
    if (JSON.stringify(local) === JSON.stringify(this.projects[projectId] ?? emptyLocal())) {
      return;
    }
    if (Object.keys(local.secrets).length > 0 || Object.keys(local.variables).length > 0) {
      this.projects[projectId] = local;
    } else {
      delete this.projects[projectId];
    }
    this.save();
  }

  private load(file: string): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isRecord(parsed)) {
        for (const [projectId, project] of Object.entries(parsed)) {
          if (isRecord(project)) {
            this.projects[projectId] = toLocal(project);
          }
        }
      }
    } catch {
      // No file yet, or unreadable — no values.
    }
  }

  private save(): void {
    try {
      // Renamed into place: `load` reads a half-written file as none, and the next save would keep that.
      writeFileAtomic.sync(this.file, JSON.stringify(this.projects, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist sbx-local.json:", error);
    }
  }
}
