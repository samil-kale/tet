import type { WorktreeInfo } from "./git";

/** A repository TET has open. Stored in `projects.json` as `{id, path, name}`; `worktrees` is read off
 *  the disk and never stored. */
export interface Project {
  /** `tet.id` in the repository's git config (projects.ts's resolveProjectId), shared by its
   *  worktrees. */
  id: string;
  /** Absolute path of the repository. */
  path: string;
  /** The directory's base name. */
  name: string;
  /** Its linked worktrees, by branch (git.ts's readWorktrees). Those TET made carry their `key`;
   *  the others (made elsewhere) are shown greyed and never opened. */
  worktrees: ProjectWorktree[];
}

/** A linked worktree of a project, as the sidebar lists it. */
export type ProjectWorktree = Pick<WorktreeInfo, "path" | "branch" | "key">;

/**
 * Where something runs: a project's repository, or one of the worktrees TET made (`worktree` its
 * key). A worktree has no id of its own — it is always this pair.
 */
export interface ProjectRef {
  projectId: string;
  worktree?: string;
}

/** A ref, the repository's without a `worktree` key at all: two refs of one repository or worktree
 *  then compare, and print, alike. */
export function projectRef(projectId: string, worktree?: string): ProjectRef {
  return worktree === undefined ? { projectId } : { projectId, worktree };
}

/**
 * The pair as one string, for what can hold only one (a map, localStorage, a sandbox's name, a
 * toast): the project id alone for the repository. Never passed on as an address. No space (a
 * project's terminals are disposed by the prefix `${key} `) and no ":" (Monaco's URI authority).
 */
export function projectRefKey(ref: ProjectRef): string {
  return ref.worktree === undefined ? ref.projectId : `${ref.projectId}-${ref.worktree}`;
}

/** The repository first, then the worktrees TET made. */
export function projectRefsOf(project: Project): ProjectRef[] {
  return [
    projectRef(project.id),
    ...project.worktrees.flatMap((worktree) => (worktree.key === undefined ? [] : [projectRef(project.id, worktree.key)]))
  ];
}

/** Two refs of one repository or worktree. */
export function sameProjectRef(a: ProjectRef, b: ProjectRef | undefined): boolean {
  return b !== undefined && projectRefKey(a) === projectRefKey(b);
}

/** The worktree of the project a ref names; undefined for the repository, and for a key the
 *  project does not list. */
export function worktreeOf(project: Project, ref: ProjectRef): ProjectWorktree | undefined {
  return ref.worktree === undefined ? undefined : project.worktrees.find((worktree) => worktree.key === ref.worktree);
}

/** What the window is told of a change to the projects (projects.ts): repositories and worktrees
 *  opened and closed, and the one the user (or tet-ctl) just opened, to bring to the front. */
export interface ProjectsChange {
  added?: ProjectRef[];
  removed?: ProjectRef[];
  show?: ProjectRef;
}

/** A worktree's name: its branch, else (detached) TET's key, else its folder's. */
export function worktreeName(worktree: ProjectWorktree): string {
  return worktree.branch ?? worktree.key ?? worktree.path.split(/[\\/]/).pop() ?? worktree.path;
}

/** What a notice or toast calls a repository or worktree: the project's name, a worktree's with
 *  it. */
export function projectRefName(project: Project, ref: ProjectRef): string {
  const worktree = worktreeOf(project, ref);
  return worktree ? `${worktreeName(worktree)} (${project.name})` : project.name;
}

/** Open/clone/create/new worktree: the project, or git's message. `worktree` names the worktree it
 *  was about, to bring to the front. */
export interface AddRepositoryResult {
  project?: Project;
  worktree?: string;
  error?: string;
  /** The clone wants a login for this url; the dialog asks for one (GitActionResult). */
  loginUrl?: string;
  /** The folder holds no git repository; the dialog offers to initialize one (`initialize`). */
  notRepository?: boolean;
}

/** A command row's color, stored as the ANSI name so a theme change recolors the rows: the row is
 *  drawn in --vscode-terminal-ansiBright<Name>. The six hues only — black, white and the greys are
 *  the terminal's own background or foreground in one theme or another. */
export const COMMAND_COLORS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

export type CommandColor = (typeof COMMAND_COLORS)[number];

/** A project's saved shell command. */
export interface ProjectCommand {
  command: string;
  /** The row's label; the line is what runs. */
  name?: string;
  /** What the row is drawn in; absent is the list's own foreground. See COMMAND_COLORS. */
  color?: CommandColor;
  /** Relative to the project root; absent means the root. */
  cwd?: string;
  /** Its own field because PowerShell reads `PROFILE=x java ...` as a command name. Wins over the
   *  inherited environment. */
  env?: Record<string, string>;
  /** Runs the line in a shell (pipes, redirections); then only works on the platform it was
   *  written for. */
  shell?: boolean;
}
