import { memo, useMemo, type ReactNode } from "react";
import type { Project } from "../../shared/types";
import { canDiscardProjectEdits } from "../diff/editor-views";
import type { GitRun } from "../git/run-action";
import { askDeleteWorktree, askNewWorktree, askRenameWorktree, worktreeEntry } from "../git/worktree-questions";
import { revealLabel } from "../platform";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { filled, prompt, singleField } from "../ui/Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { Section } from "../ui/Section";
import { SessionMark } from "../ui/SessionMark";
import { ChangesIcon, CloseIcon, PlusIcon, ShieldIcon } from "../ui/icons";

/** Our own type, so a project dragged over a terminal is not pasted into it. */
const DRAG_TYPE = "application/x-tet-project";

/** One action in a project row; its click must not reach the row, which selects the project. */
function rowButton(title: string, run: () => void, icon: ReactNode) {
  return (
    <button
      className="icon-button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        run();
      }}
    >
      {icon}
    </button>
  );
}

/** A project's marked sessions by tab id, oldest first: finished out of sight, waiting on an
 *  answer, and starting (so the pane a new agent opens in shows the bar, `TerminalsPane`'s
 *  `startingHere`). `busy` excludes a session stopped on a question. Decided in `App`, which alone
 *  knows what is on screen. */
export interface ProjectMarks {
  finished: string[];
  waiting: string[];
  starting: string[];
  busy: boolean;
}

/** A row's repository facts: HEAD, first remote, dirty. */
export interface ProjectHead {
  head?: string;
  /** `head` is a commit, not a branch. */
  detached?: boolean;
  /** `head`'s upstream, e.g. "origin/main". */
  upstream?: string;
  /** For a worktree tet made, the branch it was made from (`WorktreeInfo.base`), and the folder
   *  where that branch is checked out, if anywhere. */
  base?: string;
  baseAt?: string;
  /** Where a new worktree starts, e.g. "origin/main". */
  defaultBranch?: string;
  /** The first remote, by what the row shows of it. */
  remoteName?: string;
  remoteUrl?: string;
  dirty?: boolean;
}

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string | null;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
  /** The full list in the new order. */
  onReorder: (projects: Project[]) => void;
  onAdd: () => void;
  /** By project id, with a new identity only where the answer changed (`App` ensures it). Records,
   *  not lookup callbacks: a callback closing over every project's state changes on every push and
   *  breaks the memo. */
  heads: Record<string, ProjectHead>;
  marks: Record<string, ProjectMarks>;
  /** Which projects run their agents in sbx, keyed and memoized the same way. */
  sandboxed: Record<string, boolean>;
  /** Opens a shell tab in that project ("open in terminal"). */
  onOpenTerminal: (projectId: string) => void;
  /** Opens the first working session. */
  onShowBusy: (projectId: string) => void;
  /** Opens the oldest finished session; pressing again moves to the next. */
  onShowFinished: (projectId: string) => void;
  /** The same, for the longest-waiting session. */
  onShowWaiting: (projectId: string) => void;
  /** Shows the project, toggling the git pane when it is already selected. */
  onShowChanges: (projectId: string) => void;
  /** Opens the sbx-settings dialog, which runs every check itself. */
  onSbxSettings: (projectId: string) => void;
  /** `App.runInProject`: how a command runs in one of these projects — `run` on this list's bar
   *  and failing as a notice, `ask` on the bar of the question that asked for it. */
  runIn: (projectId: string) => GitRun;
  /** A command started here runs, in any project. */
  gitBusy: boolean;
  /** git creates and renames worktrees (Requirements.worktrees); else both entries say why not. */
  worktreesSupported: boolean;
}

/**
 * The stored order with each worktree moved right under its main worktree's row, siblings in stored
 * order. A worktree whose main worktree is not open stands on its own. A drag reorders this list,
 * which is grouped again — a worktree cannot leave its group.
 */
function groupWorktrees(projects: Project[]): Project[] {
  const nested = nestedIds(projects);
  return projects
    .filter((project) => !nested.has(project.id))
    .flatMap((main) => [main, ...projects.filter((project) => nested.has(project.id) && project.mainPath === main.path)]);
}

/** The worktrees whose main worktree is open too — the rows drawn indented under it. One pass,
 *  so the row rendering asks the set instead of scanning the list again per row. */
function nestedIds(projects: Project[]): Set<string> {
  const mains = new Set(projects.map((project) => project.path));
  return new Set(
    projects.filter((project) => project.mainPath !== undefined && mains.has(project.mainPath)).map((project) => project.id)
  );
}

/** A remote's web page, or null. Takes both git spellings: "git@host:owner/repo.git" and a url
 *  with a scheme. */
function webUrl(remoteUrl: string): string | null {
  // Excludes a Windows path ("C:\bare\repo.git"): a colon followed by a slash is no host.
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?![\\/])(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (scp) {
    return `https://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(remoteUrl);
    if (url.protocol === "ssh:") {
      return `https://${url.hostname}${url.pathname.replace(/\.git\/?$/, "")}`;
    }
    if (url.protocol === "https:" || url.protocol === "http:") {
      return `https://${url.host}${url.pathname.replace(/\.git\/?$/, "")}`;
    }
  } catch {
    // Not a url, e.g. a local path.
  }
  return null;
}

/** A known provider's name ("View on GitHub"), else the hostname. */
function hostName(url: string): string {
  const { hostname } = new URL(url);
  const known = ["GitHub", "GitLab", "Bitbucket"].find((name) => hostname.includes(name.toLowerCase()));
  return known ?? hostname;
}

export const ProjectList = memo(function ProjectList({
  projects,
  activeProjectId,
  onSelect,
  onClose,
  onReorder,
  onAdd,
  heads,
  marks,
  sandboxed,
  onOpenTerminal,
  onShowBusy,
  onShowFinished,
  onShowWaiting,
  onShowChanges,
  onSbxSettings,
  runIn,
  gitBusy,
  worktreesSupported
}: ProjectListProps) {
  const menu = useContextMenu<Project>();
  const rows = useMemo(() => groupWorktrees(projects), [projects]);
  const nested = useMemo(() => nestedIds(rows), [rows]);

  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: rows.length,
    // The id, not the position: it survives a list change mid-drag.
    payloadOf: (index) => rows[index].id,
    indexOf: (id) => rows.findIndex((project) => project.id === id),
    onMove: (from, to) => onReorder(groupWorktrees(reorder(rows, from, to)))
  });

  const itemClass = (project: Project, index: number): string => {
    const classes = ["project-item", ...rowClasses(index)];
    if (nested.has(project.id)) {
      classes.push("worktree");
    }
    if (project.id === activeProjectId) {
      classes.push("active");
    }
    return classes.join(" ");
  };

  const askRemoteUrl = async (project: Project, remote: string, current: string | undefined): Promise<void> => {
    await prompt({
      title: "Change remote URL",
      value: current ?? "",
      confirmLabel: "Change URL",
      ready: filled,
      render: singleField(`URL of ${remote}`),
      submit: async (url) =>
        url.trim() === current
          ? undefined
          : runIn(project.id).ask(`Changing the URL of ${remote}...`, () =>
              window.tet.repository.setRemoteUrl(project.id, remote, url.trim())
            )
    });
  };

  /** Repository-wide actions. Nothing here touches the working tree; that belongs to the git
   *  pane, where its target is on screen — but for a worktree's own row, which is that tree, and
   *  its merge into the base, run where the base is checked out. */
  const menuEntries = (project: Project): ContextMenuEntry[] => {
    const { head, detached, upstream, base, baseAt, defaultBranch, remoteName, remoteUrl } = heads[project.id] ?? {};
    const web = remoteUrl ? webUrl(remoteUrl) : null;
    const run = runIn(project.id);
    // Named by its branch, which is its name; by its folder while detached.
    const name = head && !detached ? head : project.name;
    // Run where the base is checked out, which is a project of its own when it is anywhere. The
    // base is recorded at creation (git.ts's worktreeAdd).
    const baseProject = baseAt === undefined ? undefined : projects.find((entry) => entry.path === baseAt);
    const ref = project.mainPath === undefined ? undefined : { path: project.path, mainPath: project.mainPath };
    // Its unsaved edits have a say before its terminals close.
    const canClose = () => canDiscardProjectEdits(project.id);
    const worktree: ContextMenuEntry[] = ref
      ? [
          {
            label: base ? `Merge into ${base}` : "Merge into its base",
            run:
              base && baseProject && !detached
                ? () =>
                    runIn(baseProject.id).run(`Merging ${name} into ${base}...`, () =>
                      window.tet.repository.merge(baseProject.id, name)
                    )
                : undefined
          },
          SEPARATOR,
          worktreeEntry("Rename worktree", worktreesSupported, () => void askRenameWorktree(ref, name, run, canClose)),
          { label: "Delete worktree...", run: () => void askDeleteWorktree(ref, name, upstream, run, canClose) }
        ]
      : [];
    // The repository's, offered on its main worktree's row only.
    const repository: ContextMenuEntry[] = ref
      ? []
      : [
          {
            label: web ? `View on ${hostName(web)}` : "View in browser",
            run: web ? () => void window.tet.shell.openUrl(web) : undefined
          },
          {
            label: "Change remote URL...",
            run: remoteName ? () => void askRemoteUrl(project, remoteName, remoteUrl) : undefined
          },
          SEPARATOR,
          worktreeEntry("New worktree", worktreesSupported, defaultBranch ? () => void askNewWorktree(project.id, run, defaultBranch) : undefined)
        ];
    // A worktree takes its main worktree's (tet-json.ts's configRoot).
    const sbx: ContextMenuEntry[] = project.mainPath ? [] : [{ label: "SBX Settings", run: () => onSbxSettings(project.id) }, SEPARATOR];
    return [
      { label: "Open in terminal", run: () => onOpenTerminal(project.id) },
      { label: revealLabel(), run: () => void window.tet.shell.openProject(project.id) },
      { label: "Copy repository path", run: () => void navigator.clipboard.writeText(project.path) },
      SEPARATOR,
      ...repository,
      ...worktree,
      SEPARATOR,
      ...sbx,
      { label: ref ? "Close worktree" : "Close repository", run: () => onClose(project.id) }
    ];
  };

  return (
    <Section
      title="PROJECTS"
      count={projects.length}
      busy={gitBusy}
      actions={
        <button className="icon-button" title="Add repository" onClick={onAdd}>
          <PlusIcon />
        </button>
      }
    >
      <div className="project-list" {...listProps}>
        {rows.map((project, index) => {
          const extra = heads[project.id]?.base ?? heads[project.id]?.head;
          return (
            <div
              key={project.id}
              className={itemClass(project, index)}
              onClick={() => onSelect(project.id)}
              title={project.path}
              {...rowProps(index)}
              onContextMenu={(event) => menu.open(event, project)}
            >
              <span className="project-main">
                <span className="project-label">{project.name}</span>
                {/* HEAD, as context rather than name; for a worktree, whose branch is its name, the
                    branch it was made from. */}
                {extra && <span className="project-extra">({extra})</span>}
              </span>
              {/* All three session states can hold at once, each a button to a session. No ranking as
                  on a tab: a row has no single icon to replace. */}
              {(marks[project.id]?.waiting.length ?? 0) > 0 &&
                rowButton(
                  "Open the session waiting for an answer",
                  () => onShowWaiting(project.id),
                  <SessionMark kind="waiting" />
                )}
              {marks[project.id]?.busy &&
                rowButton(
                  "Open the session that is working",
                  () => onShowBusy(project.id),
                  <SessionMark kind="working" />
                )}
              {/* Going to the session clears the mark. */}
              {(marks[project.id]?.finished.length ?? 0) > 0 &&
                rowButton(
                  "Open the session that finished",
                  () => onShowFinished(project.id),
                  <SessionMark kind="finished" />
                )}
              {/* From the status every refresh loads — no extra git call. */}
              {heads[project.id]?.dirty &&
                rowButton("Uncommitted changes", () => onShowChanges(project.id), <ChangesIcon />)}
              {/* The switch is on, not that a tab got a sandbox: when sbx is unavailable a tab stays in
                  error rather than running on the host (resolveSbxRun). */}
              {sandboxed[project.id] &&
                (project.mainPath ? (
                  // A worktree's are its main worktree's, set there.
                  <button className="icon-button" title="SBX enabled" disabled>
                    <ShieldIcon />
                  </button>
                ) : (
                  rowButton("SBX enabled", () => onSbxSettings(project.id), <ShieldIcon />)
                ))}
              {rowButton(project.mainPath ? "Close worktree" : "Close repository", () => onClose(project.id), <CloseIcon />)}
            </div>
          );
        })}
      </div>

      {menu.render(menuEntries)}
    </Section>
  );
});
