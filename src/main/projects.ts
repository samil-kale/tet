import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { AddRepositoryResult, Project } from "../shared/types";
import type { ControlRecords } from "./control/control-records";
import { git } from "./git/git-client";
import type { RepositoryManager } from "./git/repository";
import type { SessionManagerRegistry } from "./terminals/session-manager";

/** What opening and closing a project takes — the same singletons ipc.ts holds. */
export interface ProjectDeps {
  store: ProjectStore;
  repositories: RepositoryManager;
  sessions: SessionManagerRegistry;
  records: ControlRecords;
  openProject: (project: Project) => void;
}

/**
 * Opens a folder as a project, shared by the add-repository dialog (`projects:open-path`) and the
 * control channel. A stored project whose folder is gone watches and spawns nothing, with a notice
 * per action.
 */
export async function addProject({ store, openProject }: ProjectDeps, directory: string): Promise<AddRepositoryResult> {
  if (!(await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false))) {
    return { error: `${directory} is not a folder` };
  }
  // Picking a subdirectory opens the repository itself: git reports paths relative to the root.
  const project = store.add((await git.resolveRoot(directory).catch(() => undefined)) ?? directory);
  openProject(project);
  return { project };
}

export function removeProject({ store, repositories, sessions, records }: ProjectDeps, projectId: string): void {
  // Not awaited: the project leaves the window either way; its sessions still end by themselves
  // (TerminalSession.stop). Its records go once they have: a stopping tab still prints.
  void sessions.close(projectId).finally(() => records.forgetProject(projectId));
  repositories.close(projectId);
  store.remove(projectId);
}

/** The open repositories, persisted so the window comes back with the same project tabs. */
export class ProjectStore {
  private readonly file: string;
  private projects: Project[] = [];

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "projects.json");
    this.load();
  }

  list(): Project[] {
    return this.projects;
  }

  get(projectId: string): Project | undefined {
    return this.projects.find((project) => project.id === projectId);
  }

  /** Adds the folder, or returns the existing project when it is already open. */
  add(directory: string): Project {
    const normalized = path.resolve(directory);
    const existing = this.projects.find((project) => project.path === normalized);
    if (existing) {
      return existing;
    }
    const project: Project = {
      id: randomUUID(),
      path: normalized,
      name: path.basename(normalized)
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  remove(projectId: string): void {
    this.projects = this.projects.filter((project) => project.id !== projectId);
    this.save();
  }

  /** Unknown ids are dropped, missing ones kept at the end: the renderer's list may lag behind. */
  reorder(projectIds: string[]): void {
    const known = new Map(this.projects.map((project) => [project.id, project]));
    const ordered = projectIds
      .map((projectId) => known.get(projectId))
      .filter((project): project is Project => project !== undefined);
    const seen = new Set(ordered.map((project) => project.id));
    this.projects = [...ordered, ...this.projects.filter((project) => !seen.has(project.id))];
    this.save();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.projects = parsed.filter(
          (entry): entry is Project =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as Project).id === "string" &&
            typeof (entry as Project).path === "string" &&
            typeof (entry as Project).name === "string"
        );
      }
    } catch {
      // No file yet, or unreadable.
      this.projects = [];
    }
  }

  private save(): void {
    try {
      // Renamed into place: `load` reads a half-written file as none, and the next save would keep that.
      writeFileAtomic.sync(this.file, JSON.stringify(this.projects, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist projects:", error);
    }
  }
}
