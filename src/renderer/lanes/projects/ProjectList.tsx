import { memo, type ReactNode } from "react";
import { projectRef, refKeyOf, worktreeName } from "../../../shared/types/project";
import type { Project, ProjectRef, ProjectWorktree } from "../../../shared/types/project";
import type { ResolvedRef } from "../../resolved-ref";
import type { GitRun } from "../../git/run-action";
import {
  askDeleteWorktree,
  askNewWorktree,
  askRenameWorktree,
  MADE_ELSEWHERE,
  newWorktreeRefusal,
  worktreeEntry,
} from "../../git/worktree-questions";
import { PLATFORM } from "../../platform";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { confirmed, filled, prompt, singleField } from "../../ui/Dialog";
import { reorder, useDragReorder } from "../../ui/drag-reorder";
import { Section } from "../../ui/Section";
import { TabMark } from "../../ui/TabMark";
import { IconButton } from "../../ui/IconButton";
import { ChangesIcon, CloseIcon, PlusIcon, ShieldIcon } from "../../ui/icons";
import type { RefMarks } from "../../tabs/use-tab-marks";

/** Our own type, so a project dragged over a terminal is not pasted into it. */
const DRAG_TYPE = "application/x-tet-project";

/** One action in a row; its click must not reach the row, which makes its repository or
 *  worktree active. */
function rowButton(title: string, run: () => void, icon: ReactNode) {
  return (
    <IconButton title={title} isolated onClick={run}>
      {icon}
    </IconButton>
  );
}

/** A row's repository facts: HEAD, first remote, dirty. */
export interface RefHead {
  head?: string;
  /** `head` is a commit, not a branch. */
  detached?: boolean;
  /** `head`'s upstream, e.g. "origin/main". */
  upstream?: string;
  /** For a worktree TET made, the branch it was made from (`WorktreeInfo.base`), and the folder
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
  /** Every open repository and worktree by `refKey`, identity-stable (resolved-ref.ts's `resolvedByRefKey`). */
  resolvedRefs: Record<string, ResolvedRef>;
  activeRefKey: string | null;
  onActivateRef: (refKey: string) => void;
  /** Removes the project, once this list asked about its worktrees. */
  onRemove: (projectId: string) => Promise<void>;
  /** The full list in the new order. */
  onReorder: (projects: Project[]) => void;
  onAdd: () => void;
  /** By `refKey`, with a new identity only where the answer changed (`App` ensures it).
   *  Records, not lookup callbacks: a callback closing over every repository's and worktree's state
   *  changes on every push and breaks the memo. */
  heads: Record<string, RefHead>;
  marks: Record<string, RefMarks>;
  /** Which projects run their agents in sbx, by project id: a worktree runs as its project does. */
  sandboxed: Record<string, boolean>;
  /** Opens a shell tab in that repository or worktree ("open in terminal"). */
  onOpenShellTab: (ref: ProjectRef) => void;
  /** Opens the next working session, one per press. */
  onShowWorking: (refKey: string) => void;
  /** Opens the oldest finished session; pressing again moves to the next. */
  onShowFinished: (refKey: string) => void;
  /** The same, for the longest-waiting session. */
  onShowWaiting: (refKey: string) => void;
  /** Shows the repository or worktree, toggling the git lane when it is already active. */
  onShowChanges: (refKey: string) => void;
  /** Opens the sbx-settings dialog, which runs every check itself. */
  onSbxSettings: (projectId: string) => void;
  /** `useBranchActions`'s `runIn`: how a command runs in one of these repositories and worktrees — `run` on this
   *  list's bar and failing as a notice, `ask` on the bar of the question that asked for it. */
  runIn: (refKey: string) => GitRun;
  /** A command started here runs, in any repository or worktree. */
  busy: boolean;
  /** git creates worktrees (Requirements.worktrees); else "Add worktree" says why not. */
  worktreesSupported: boolean;
}

/** The row a menu was opened on: the repository or a worktree TET made, or one made elsewhere. */
type RowTarget = { kind: "ref"; resolved: ResolvedRef } | { kind: "madeElsewhere"; worktree: ProjectWorktree };

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
  resolvedRefs,
  activeRefKey,
  onActivateRef,
  onRemove,
  onReorder,
  onAdd,
  heads,
  marks,
  sandboxed,
  onOpenShellTab,
  onShowWorking,
  onShowFinished,
  onShowWaiting,
  onShowChanges,
  onSbxSettings,
  runIn,
  busy,
  worktreesSupported,
}: ProjectListProps) {
  const menu = useContextMenu<RowTarget>();

  // A project's group moves as one: its worktrees never leave it.
  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: projects.length,
    // The id, not the position: it survives a list change mid-drag.
    payloadOf: (index) => projects[index].id,
    indexOf: (id) => projects.findIndex((project) => project.id === id),
    onMove: (from, to) => onReorder(reorder(projects, from, to)),
  });

  const askRemoteUrl = async (resolved: ResolvedRef, remote: string, current: string | undefined): Promise<void> => {
    await prompt({
      title: "Change remote URL",
      value: current ?? "",
      confirmLabel: "Change URL",
      ready: filled,
      render: singleField(`URL of ${remote}`),
      submit: async (url) =>
        url.trim() === current
          ? undefined
          : runIn(resolved.refKey).ask(`Changing the URL of ${remote}...`, () =>
              window.tet.repository.setRemoteUrl(resolved.ref, remote, url.trim()),
            ),
    });
  };

  /** Removing a project deletes the worktrees TET made, with their branches: said first. */
  const remove = async (project: Project): Promise<void> => {
    const count = project.worktrees.filter((worktree) => worktree.key !== undefined).length;
    if (count > 0) {
      const answer = await confirmed({
        title: "Remove project",
        message: `Remove ${project.name}?`,
        detail:
          count === 1
            ? "Its worktree is deleted with its branch: uncommitted changes and commits only there are lost. The repository's folder stays."
            : `Its ${count} worktrees are deleted with their branches: uncommitted changes and commits only there are lost. The repository's folder stays.`,
        confirmLabel: "Remove project",
      });
      if (!answer) {
        return;
      }
    }
    void onRemove(project.id);
  };

  /** A row's close: a repository is removed, a worktree deleted — asked first (askDeleteWorktree). */
  const close = (resolved: ResolvedRef): void => {
    if (resolved.worktree === undefined) {
      const project = projects.find((entry) => entry.id === resolved.ref.projectId);
      if (project) {
        void remove(project);
      }
      return;
    }
    const { upstream } = heads[resolved.refKey] ?? {};
    void askDeleteWorktree(resolved.ref, worktreeName(resolved.worktree), upstream, runIn(resolved.refKey));
  };

  /** Repository-wide actions. Nothing here touches the working tree; that belongs to the git
   *  lane, where its target is on screen — but for a worktree's own row, which is that tree, and
   *  its merge into the base, run where the base is checked out. */
  const refEntries = (resolved: ResolvedRef): ContextMenuEntry[] => {
    const { worktree } = resolved;
    const { projectId } = resolved.ref;
    const { detached, base, baseAt, defaultBranch, remoteName, remoteUrl } = heads[resolved.refKey] ?? {};
    const web = remoteUrl ? webUrl(remoteUrl) : null;
    // The base is recorded at creation (git.ts's worktreeAdd); run where it is checked out.
    const baseResolved =
      baseAt === undefined
        ? undefined
        : Object.values(resolvedRefs).find((entry) => entry.ref.projectId === projectId && entry.path === baseAt);
    const branch = worktree?.branch;
    const own: ContextMenuEntry[] = worktree
      ? [
          {
            label: base ? `Merge into ${base}` : "Merge into its base",
            run:
              base && baseResolved && branch && !detached
                ? () =>
                    runIn(baseResolved.refKey).run(`Merging ${branch} into ${base}...`, () =>
                      window.tet.repository.merge(baseResolved.ref, branch),
                    )
                : undefined,
          },
          SEPARATOR,
          // Run in the repository, whose state lists the worktrees.
          worktreeEntry(
            "Rename worktree",
            undefined,
            branch ? () => void askRenameWorktree(projectId, branch, runIn(refKeyOf(projectRef(projectId)))) : undefined,
          ),
        ]
      : [];
    // The repository's, offered on its own row only.
    const repository: ContextMenuEntry[] = worktree
      ? []
      : [
          {
            label: web ? `View on ${hostName(web)}` : "View in browser",
            run: web ? () => void window.tet.shell.openUrl(web) : undefined,
          },
          {
            label: "Change remote URL...",
            run: remoteName ? () => void askRemoteUrl(resolved, remoteName, remoteUrl) : undefined,
          },
          SEPARATOR,
          worktreeEntry(
            "Add worktree",
            newWorktreeRefusal(worktreesSupported),
            defaultBranch ? () => void askNewWorktree(projectId, runIn(resolved.refKey), defaultBranch) : undefined,
          ),
        ];
    // A worktree takes its project's (tet-json.ts's configRoot).
    const sbx: ContextMenuEntry[] = worktree ? [] : [{ label: "SBX Settings", run: () => onSbxSettings(projectId) }, SEPARATOR];
    return [
      { label: "New shell tab", run: () => onOpenShellTab(resolved.ref) },
      { label: PLATFORM.revealLabel, run: () => void window.tet.shell.openProject(resolved.ref) },
      { label: worktree ? "Copy path" : "Copy repository path", run: () => void navigator.clipboard.writeText(resolved.path) },
      SEPARATOR,
      ...repository,
      ...own,
      SEPARATOR,
      ...sbx,
      { label: worktree ? "Delete worktree..." : "Remove project", run: () => close(resolved) },
    ];
  };

  const menuEntries = (target: RowTarget): ContextMenuEntry[] =>
    target.kind === "ref"
      ? refEntries(target.resolved)
      : [{ label: "Copy path", run: () => void navigator.clipboard.writeText(target.worktree.path) }];

  const refRow = (resolved: ResolvedRef): ReactNode => {
    const { refKey, worktree } = resolved;
    const { projectId } = resolved.ref;
    // HEAD, as context rather than name; for a worktree, whose branch is its name, the branch it
    // was made from.
    const extra = worktree ? heads[refKey]?.base : heads[refKey]?.head;
    const classes = [worktree ? "worktree-row" : "project-row", ...(refKey === activeRefKey ? ["active"] : [])];
    return (
      <div
        key={refKey}
        className={classes.join(" ")}
        onClick={() => onActivateRef(refKey)}
        title={resolved.path}
        onContextMenu={(event) => menu.open(event, { kind: "ref", resolved })}
      >
        <span className="project-main">
          <span className="project-label">{worktree ? worktreeName(worktree) : resolved.name}</span>
          {extra && <span className="project-extra">({extra})</span>}
        </span>
        {/* All three session states can hold at once, each a button to a session. No ranking as
            on a tab: a row has no single icon to replace. */}
        {(marks[refKey]?.waiting.length ?? 0) > 0 &&
          rowButton("Open the tab waiting for an answer", () => onShowWaiting(refKey), <TabMark kind="waiting" />)}
        {marks[refKey]?.working && rowButton("Open the tab that is working", () => onShowWorking(refKey), <TabMark kind="working" />)}
        {/* Going to the session clears the mark. */}
        {(marks[refKey]?.finished.length ?? 0) > 0 &&
          rowButton("Open the tab that finished", () => onShowFinished(refKey), <TabMark kind="finished" />)}
        {/* From the status every refresh loads — no extra git call. */}
        {heads[refKey]?.dirty && rowButton("Uncommitted changes", () => onShowChanges(refKey), <ChangesIcon />)}
        {/* The switch is on, not that a tab got a sandbox: when sbx is unavailable a tab stays in
            error rather than running on the host (resolvePlace). */}
        {sandboxed[projectId] &&
          (worktree ? (
            // A worktree's are its project's, set there: a mark, no button.
            <span className="status-icon" title="SBX enabled">
              <ShieldIcon />
            </span>
          ) : (
            rowButton("SBX enabled", () => onSbxSettings(projectId), <ShieldIcon />)
          ))}
        {rowButton(worktree ? "Delete worktree" : "Remove project", () => close(resolved), <CloseIcon />)}
      </div>
    );
  };

  /** A worktree git lists that was made elsewhere: shown, never opened. */
  const madeElsewhereRow = (worktree: ProjectWorktree): ReactNode => (
    <div
      key={worktree.path}
      className="worktree-row made-elsewhere"
      title={`${worktree.path}\nA worktree ${MADE_ELSEWHERE}`}
      onContextMenu={(event) => menu.open(event, { kind: "madeElsewhere", worktree })}
    >
      <span className="project-main">
        <span className="project-label">{worktreeName(worktree)}</span>
      </span>
    </div>
  );

  return (
    <Section
      title="PROJECTS"
      count={projects.length}
      busy={busy}
      actions={
        <IconButton title="Add repository" onClick={onAdd}>
          <PlusIcon />
        </IconButton>
      }
    >
      <div className="project-list" {...listProps}>
        {projects.map((project, index) => {
          const main = resolvedRefs[refKeyOf(projectRef(project.id))];
          return (
            <div key={project.id} className={["project-group", ...rowClasses(index)].join(" ")} {...rowProps(index)}>
              {main && refRow(main)}
              {project.worktrees.map((worktree) => {
                const own = worktree.key === undefined ? undefined : resolvedRefs[refKeyOf(projectRef(project.id, worktree.key))];
                return own ? refRow(own) : madeElsewhereRow(worktree);
              })}
            </div>
          );
        })}
      </div>

      {menu.render(menuEntries)}
    </Section>
  );
});
