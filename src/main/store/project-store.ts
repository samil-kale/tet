import * as path from "node:path";
import type { Project, ProjectWorktree } from "../../shared/types";
import { readRows, writeJson } from "../util/json-file";
import { readHeadBranch } from "../util/linked-git-dir";
import { ownedWorktreeKeys, worktreeDir } from "./project-dirs";

/** Finding a project, all either transport needs to answer *about* one; the store's own edits
 *  are the window's (`ipc/projects.ts`). Taken by `ControlDeps`. */
export interface ProjectLookup {
  list(): Project[];
  get(projectId: string): Project | undefined;
}

/** The open repositories, persisted so the window comes back with the same projects. */
export class ProjectStore implements ProjectLookup {
  private readonly file: string;
  private projects: Project[] = [];
  /** Left closed this run, their tet.json broken at opening (openStoredProjects): stored with all
   *  TET keeps of them, worktrees and sessions alike, but listed nowhere until added again. */
  private readonly held = new Set<string>();

  constructor(private readonly dataRoot: string) {
    this.file = path.join(dataRoot, "projects.json");
    this.load();
  }

  list(): Project[] {
    return this.projects.filter((project) => !this.held.has(project.id));
  }

  get(projectId: string): Project | undefined {
    return this.list().find((project) => project.id === projectId);
  }

  /** Every stored project, held ones too: an id is taken by either. */
  all(): Project[] {
    return this.projects;
  }

  hold(projectId: string): void {
    this.held.add(projectId);
  }

  /** The held project at `mainPath`, listed again (addProject). */
  release(mainPath: string): Project | undefined {
    const project = this.projects.find((entry) => entry.path === mainPath && this.held.has(entry.id));
    if (project) {
      this.held.delete(project.id);
    }
    return project;
  }

  /** Adds the repository at `mainPath` (in on-disk spelling) under `id`, with the worktrees TET
   *  made for it. */
  add(mainPath: string, id: string): Project {
    const project: Project = { id, path: mainPath, name: path.basename(mainPath), worktrees: this.ownWorktrees(id) };
    this.save([...this.projects, project]);
    return project;
  }

  /** The project's id as its repository now says (resolveStoredIds); its worktrees read for that id. */
  setId(projectId: string, id: string): void {
    const project = this.get(projectId);
    if (!project || project.id === id) {
      return;
    }
    this.save(this.projects.map((entry) => (entry === project ? { ...project, id, worktrees: this.ownWorktrees(id) } : entry)));
  }

  /** Replaces the project's worktrees; whether anything changed. Never stored. */
  setWorktrees(projectId: string, worktrees: ProjectWorktree[]): boolean {
    const project = this.get(projectId);
    if (!project || JSON.stringify(project.worktrees) === JSON.stringify(worktrees)) {
      return false;
    }
    this.projects = this.projects.map((entry) => (entry === project ? { ...project, worktrees } : entry));
    return true;
  }

  remove(projectId: string): void {
    this.save(this.projects.filter((project) => project.id !== projectId));
  }

  /** Unknown ids are dropped, missing ones kept at the end: the renderer's list may lag behind. */
  reorder(projectIds: string[]): void {
    const known = new Map(this.projects.map((project) => [project.id, project]));
    const ordered = projectIds
      .map((projectId) => known.get(projectId))
      .filter((project): project is Project => project !== undefined);
    const seen = new Set(ordered.map((project) => project.id));
    this.save([...ordered, ...this.projects.filter((project) => !seen.has(project.id))]);
  }

  /** The worktrees TET made for the project, off the disk without git: the first frame has their
   *  rows, and the first state corrects them (syncWorktrees). */
  private ownWorktrees(projectId: string): ProjectWorktree[] {
    return ownedWorktreeKeys(this.dataRoot, projectId).map((key) => {
      const folder = worktreeDir(this.dataRoot, projectId, key);
      return { key, path: folder, branch: readHeadBranch(folder) };
    });
  }

  private load(): void {
    this.projects = readRows<{ id: string; path: string; name: string }>(this.file, ["id", "path", "name"]).map(
      ({ id, path: mainPath, name }) => ({ id, path: mainPath, name, worktrees: this.ownWorktrees(id) })
    );
  }

  /** Throws when the file cannot be written, the projects unchanged. */
  private save(projects: Project[]): void {
    // Renamed into place: `load` reads a half-written file as none, and the next save would keep that.
    writeJson(
      this.file,
      projects.map(({ id, path: mainPath, name }) => ({ id, path: mainPath, name }))
    );
    this.projects = projects;
  }
}
