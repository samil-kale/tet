import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddRepositoryResult, Project } from "../shared/types";
import { git } from "./git-client";
import type { RepositoryManager } from "./repository";
import type { SessionManagerRegistry } from "./session-manager";

/** What opening and closing a project takes — the same singletons ipc.ts holds. */
export interface ProjectDeps {
  store: ProjectStore;
  repositories: RepositoryManager;
  sessions: SessionManagerRegistry;
  openProject: (project: Project) => void;
}

/**
 * Opens a folder as a project. Shared by the add-repository dialog (`projects:open-path`) and
 * the control channel, so both answer a typed path the same way: the folder may not exist —
 * and a project that does not would watch nothing and spawn nothing, with only a notice per
 * action to say why.
 */
export async function addProject({ store, openProject }: ProjectDeps, directory: string): Promise<AddRepositoryResult> {
  if (!(await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false))) {
    return { error: `${directory} is not a folder` };
  }
  // Picking a subdirectory of a repository opens the repository itself: git reports every
  // path relative to the root, and the root is what branches and status describe.
  const project = store.add((await git.resolveRoot(directory).catch(() => undefined)) ?? directory);
  openProject(project);
  return { project };
}

/** Closes a project: its terminals, its repository, then the stored entry. */
export function removeProject({ store, repositories, sessions }: ProjectDeps, projectId: string): void {
  // Not awaited: the project is gone from the window either way, and its sessions are given a
  // moment to end by themselves (see TerminalSession.stop) rather than holding the removal up.
  void sessions.close(projectId);
  repositories.close(projectId);
  store.remove(projectId);
}

/** The open repositories, persisted so the window comes back with the same project tabs. */
export class ProjectStore {
  private readonly file: string;
  private projects: Project[] = [];

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "projects.json");
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

  /**
   * Puts the projects in the given order. Ids the store does not know are dropped, and ones the
   * caller left out keep their place at the end: the renderer sends the list it had on screen,
   * which can be a moment behind one added or closed elsewhere.
   */
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
      // No file yet (first start) or unreadable — start with an empty workspace.
      this.projects = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.projects, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist projects:", error);
    }
  }
}
