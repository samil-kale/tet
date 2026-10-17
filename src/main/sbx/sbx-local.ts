import * as path from "node:path";
import { EMPTY_SBX_SKILLS, SBX_ACCESS } from "../../shared/types/sbx";
import type { SbxAccess, SbxSkillsSettings, SbxLocalSave, SbxStoredLocal } from "../../shared/types/sbx";
import { isRecord, logFailure, readJson, writeJson } from "../util/json-file";
import { seal, unseal } from "../util/sealed";

/** What the file holds per project id: the Environment's values by env name, encrypted by the OS and
 *  base64-wrapped, and the skills unless it is all off (EMPTY_SBX_SKILLS). */
interface StoredSbxLocal {
  environment: Record<string, string>;
  skills?: SbxSkillsSettings;
}

function emptyLocal(): StoredSbxLocal {
  return { environment: {} };
}

function stringsOf(value: unknown): Record<string, string> {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
}

/** A malformed kind reads as off, a malformed folder as each agent's own. */
function toSkills(value: unknown): SbxSkillsSettings | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const toAccess = (field: unknown): SbxAccess | false => SBX_ACCESS.find((access) => access === field) ?? false;
  const skills: SbxSkillsSettings = {
    skills: toAccess(value.skills),
    instructions: toAccess(value.instructions),
  };
  if (typeof value.skillsFolder === "string" && value.skillsFolder !== "") {
    skills.skillsFolder = value.skillsFolder;
  }
  return isEmptySkills(skills) ? undefined : skills;
}

function isEmptySkills(skills: SbxSkillsSettings): boolean {
  return JSON.stringify(skills) === JSON.stringify(EMPTY_SBX_SKILLS);
}

/** A project's entry as read. */
function toLocal(project: Record<string, unknown>): StoredSbxLocal {
  const local: StoredSbxLocal = {
    // Legacy: the key was `variables`. Remove this fallback after 2026-11-17.
    environment: stringsOf(project.environment ?? project.variables),
  };
  const skills = toSkills(project.skills);
  if (skills) {
    local.skills = skills;
  }
  return local;
}

/**
 * The values of the SBX Settings' Environment, which tet.json never holds (its rows are only names),
 * and its Skills, which names this machine's folders. A value leaves this class only decrypted into
 * a sandboxed tab's `sbx run` (sbx.ts's sandboxEnv); the renderer never sees one.
 */
export class SbxLocalStore {
  private readonly file: string;
  private projects: Record<string, StoredSbxLocal> = {};

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "sbx-local.json");
    this.load();
  }

  /** The env names holding a value for the project that can still be decrypted — the ones a spawn
   *  applies, so the dialog asks again for the others. */
  stored(projectId: string): SbxStoredLocal {
    return {
      environment: [...this.variableValues(projectId).keys()],
      skills: this.skills(projectId),
    };
  }

  /** What a sandboxed tab of the project mounts of this machine's skills (sbx.ts's prepareSbxRun). */
  skills(projectId: string): SbxSkillsSettings {
    return structuredClone(this.projects[projectId]?.skills ?? EMPTY_SBX_SKILLS);
  }

  /**
   * Keeps what the dialog's rows hold: a typed value, else the stored one of the name the row was
   * opened under (`from`), so it follows a rename; a removed row's goes. And the skills as
   * given. Throws before changing anything when the OS offers no encryption (`seal`).
   */
  update(projectId: string, local: SbxLocalSave): void {
    const current = this.projects[projectId] ?? emptyLocal();
    const next = emptyLocal();
    const { values, from } = local.environment;
    for (const [env, name] of Object.entries(from)) {
      const stored = current.environment[name];
      if (stored !== undefined) {
        next.environment[env] = stored;
      }
    }
    for (const [env, value] of Object.entries(values)) {
      next.environment[env] = seal(value);
    }
    const skills = toSkills(local.skills);
    if (skills) {
      next.skills = skills;
    }
    this.setProject(projectId, next);
  }

  /** The decrypted values by env name; one that cannot be decrypted is left out. */
  variableValues(projectId: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const [env, encrypted] of Object.entries(this.projects[projectId]?.environment ?? {})) {
      const value = unseal(encrypted);
      if (value !== undefined) {
        values.set(env, value);
      }
    }
    return values;
  }

  /** A removed project's values: its sandboxes' names (sbx.ts's sandboxName) never come back. Left
   *  behind, they are only unused, so a failure is logged: the removal is not undone for it. */
  forgetProject(projectId: string): void {
    logFailure("forget the project's SBX settings", () => this.setProject(projectId, emptyLocal()));
  }

  /** The project's values as stored, still encrypted — for `restore` when a Save fails
   *  (sbx-settings.ts's saveProjectSbx). */
  encrypted(projectId: string): StoredSbxLocal {
    return structuredClone(this.projects[projectId] ?? emptyLocal());
  }

  restore(projectId: string, local: StoredSbxLocal): void {
    this.setProject(projectId, local);
  }

  /** Written only on a change: every SBX Save passes through `update`. Throws when the file cannot
   *  be written, nothing changed. */
  private setProject(projectId: string, local: StoredSbxLocal): void {
    if (JSON.stringify(local) === JSON.stringify(this.projects[projectId] ?? emptyLocal())) {
      return;
    }
    const next = { ...this.projects, [projectId]: local };
    if (Object.keys(local.environment).length === 0 && !local.skills) {
      delete next[projectId];
    }
    // Renamed into place: `load` reads a half-written file as none, and the next save would keep that.
    writeJson(this.file, next);
    this.projects = next;
  }

  private load(): void {
    const parsed = readJson(this.file);
    if (isRecord(parsed)) {
      for (const [projectId, project] of Object.entries(parsed)) {
        if (isRecord(project)) {
          this.projects[projectId] = toLocal(project);
        }
      }
    }
  }
}
