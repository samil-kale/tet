import { memo, type ReactNode } from "react";
import { checkoutKey, checkoutRef, worktreeName } from "../../shared/types";
import type { CheckoutRef, Project, ProjectWorktree } from "../../shared/types";
import type { Checkout } from "../checkout";
import type { GitRun } from "../git/run-action";
import {
  askDeleteWorktree,
  askNewWorktree,
  askRenameWorktree,
  newWorktreeRefusal,
  NOT_MADE_BY_TET,
  worktreeEntry
} from "../git/worktree-questions";
import { revealLabel } from "../platform";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, filled, prompt, singleField } from "../ui/Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { Section } from "../ui/Section";
import { SessionMark } from "../ui/SessionMark";
import { ChangesIcon, CloseIcon, PlusIcon, ShieldIcon } from "../ui/icons";

/** Our own type, so a project dragged over a terminal is not pasted into it. */
const DRAG_TYPE = "application/x-tet-project";

/** One action in a row; its click must not reach the row, which selects its checkout. */
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

/** A checkout's marked sessions by tab id, oldest first: finished out of sight, waiting on an
 *  answer, and starting (so the pane a new agent opens in shows the bar, `TerminalsPane`'s
 *  `startingHere`). `busy` excludes a session stopped on a question. Decided in `App`, which alone
 *  knows what is on screen. */
export interface CheckoutMarks {
  finished: string[];
  waiting: string[];
  starting: string[];
  busy: boolean;
}

/** A row's repository facts: HEAD, first remote, dirty. */
export interface CheckoutHead {
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
  /** Every open checkout by key, identity-stable (App's `checkoutsByKey`). */
  checkouts: Record<string, Checkout>;
  activeKey: string | null;
  onSelect: (key: string) => void;
  /** Removes the project, once this list asked about its worktrees. */
  onRemove: (projectId: string) => void;
  /** The full list in the new order. */
  onReorder: (projects: Project[]) => void;
  onAdd: () => void;
  /** By checkout key, with a new identity only where the answer changed (`App` ensures it).
   *  Records, not lookup callbacks: a callback closing over every checkout's state changes on every
   *  push and breaks the memo. */
  heads: Record<string, CheckoutHead>;
  marks: Record<string, CheckoutMarks>;
  /** Which projects run their agents in sbx, by project id: a worktree runs as its project does. */
  sandboxed: Record<string, boolean>;
  /** Opens a shell tab in that checkout ("open in terminal"). */
  onOpenTerminal: (checkout: CheckoutRef) => void;
  /** Opens the first working session. */
  onShowBusy: (key: string) => void;
  /** Opens the oldest finished session; pressing again moves to the next. */
  onShowFinished: (key: string) => void;
  /** The same, for the longest-waiting session. */
  onShowWaiting: (key: string) => void;
  /** Shows the checkout, toggling the git pane when it is already selected. */
  onShowChanges: (key: string) => void;
  /** Opens the sbx-settings dialog, which runs every check itself. */
  onSbxSettings: (projectId: string) => void;
  /** `App.runIn`: how a command runs in one of these checkouts — `run` on this list's bar and
   *  failing as a notice, `ask` on the bar of the question that asked for it. */
  runIn: (key: string) => GitRun;
  /** A command started here runs, in any checkout. */
  gitBusy: boolean;
  /** git creates worktrees (Requirements.worktrees); else "New worktree" says why not. */
  worktreesSupported: boolean;
}

/** The row a menu was opened on: a checkout, or a worktree made elsewhere. */
type RowTarget = { kind: "checkout"; checkout: Checkout } | { kind: "foreign"; worktree: ProjectWorktree };

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
  checkouts,
  activeKey,
  onSelect,
  onRemove,
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
  const menu = useContextMenu<RowTarget>();

  // A project's group moves as one: its worktrees never leave it.
  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: projects.length,
    // The id, not the position: it survives a list change mid-drag.
    payloadOf: (index) => projects[index].id,
    indexOf: (id) => projects.findIndex((project) => project.id === id),
    onMove: (from, to) => onReorder(reorder(projects, from, to))
  });

  const askRemoteUrl = async (checkout: Checkout, remote: string, current: string | undefined): Promise<void> => {
    await prompt({
      title: "Change remote URL",
      value: current ?? "",
      confirmLabel: "Change URL",
      ready: filled,
      render: singleField(`URL of ${remote}`),
      submit: async (url) =>
        url.trim() === current
          ? undefined
          : runIn(checkout.key).ask(`Changing the URL of ${remote}...`, () =>
              window.tet.repository.setRemoteUrl(checkout.ref, remote, url.trim())
            )
    });
  };

  /** Removing a project deletes the worktrees TET made, with their branches: said first. */
  const remove = async (project: Project): Promise<void> => {
    const count = project.worktrees.filter((worktree) => worktree.key !== undefined).length;
    if (count > 0) {
      const answer = await confirm({
        title: "Remove repository",
        message: `Remove ${project.name}?`,
        detail:
          count === 1
            ? "Its worktree is deleted with its branch: uncommitted changes and commits only there are lost. The repository's folder stays."
            : `Its ${count} worktrees are deleted with their branches: uncommitted changes and commits only there are lost. The repository's folder stays.`,
        confirmLabel: "Remove repository"
      });
      if (!answer.confirmed) {
        return;
      }
    }
    onRemove(project.id);
  };

  /** A row's close: a repository is removed, a worktree deleted — asked first (askDeleteWorktree). */
  const close = (checkout: Checkout): void => {
    if (checkout.worktree === undefined) {
      const project = projects.find((entry) => entry.id === checkout.ref.projectId);
      if (project) {
        void remove(project);
      }
      return;
    }
    const { upstream } = heads[checkout.key] ?? {};
    void askDeleteWorktree(checkout.ref, worktreeName(checkout.worktree), upstream, runIn(checkout.key));
  };

  /** Repository-wide actions. Nothing here touches the working tree; that belongs to the git
   *  pane, where its target is on screen — but for a worktree's own row, which is that tree, and
   *  its merge into the base, run where the base is checked out. */
  const checkoutEntries = (checkout: Checkout): ContextMenuEntry[] => {
    const { worktree } = checkout;
    const { projectId } = checkout.ref;
    const { detached, base, baseAt, defaultBranch, remoteName, remoteUrl } = heads[checkout.key] ?? {};
    const web = remoteUrl ? webUrl(remoteUrl) : null;
    // The base is recorded at creation (git.ts's worktreeAdd); run where it is checked out.
    const baseCheckout =
      baseAt === undefined
        ? undefined
        : Object.values(checkouts).find((entry) => entry.ref.projectId === projectId && entry.path === baseAt);
    const branch = worktree?.branch;
    const own: ContextMenuEntry[] = worktree
      ? [
          {
            label: base ? `Merge into ${base}` : "Merge into its base",
            run:
              base && baseCheckout && branch && !detached
                ? () =>
                    runIn(baseCheckout.key).run(`Merging ${branch} into ${base}...`, () =>
                      window.tet.repository.merge(baseCheckout.ref, branch)
                    )
                : undefined
          },
          SEPARATOR,
          // Run in the main worktree, whose state lists the worktrees.
          worktreeEntry(
            "Rename worktree",
            undefined,
            branch ? () => void askRenameWorktree(projectId, branch, runIn(checkoutKey(checkoutRef(projectId)))) : undefined
          )
        ]
      : [];
    // The repository's, offered on its main worktree's row only.
    const repository: ContextMenuEntry[] = worktree
      ? []
      : [
          {
            label: web ? `View on ${hostName(web)}` : "View in browser",
            run: web ? () => void window.tet.shell.openUrl(web) : undefined
          },
          {
            label: "Change remote URL...",
            run: remoteName ? () => void askRemoteUrl(checkout, remoteName, remoteUrl) : undefined
          },
          SEPARATOR,
          worktreeEntry(
            "New worktree",
            newWorktreeRefusal(worktreesSupported),
            defaultBranch ? () => void askNewWorktree(projectId, runIn(checkout.key), defaultBranch) : undefined
          )
        ];
    // A worktree takes its project's (tet-json.ts's configRoot).
    const sbx: ContextMenuEntry[] = worktree ? [] : [{ label: "SBX Settings", run: () => onSbxSettings(projectId) }, SEPARATOR];
    return [
      { label: "Open in terminal", run: () => onOpenTerminal(checkout.ref) },
      { label: revealLabel(), run: () => void window.tet.shell.openProject(checkout.ref) },
      { label: worktree ? "Copy path" : "Copy repository path", run: () => void navigator.clipboard.writeText(checkout.path) },
      SEPARATOR,
      ...repository,
      ...own,
      SEPARATOR,
      ...sbx,
      { label: worktree ? "Delete worktree..." : "Remove repository", run: () => close(checkout) }
    ];
  };

  const menuEntries = (target: RowTarget): ContextMenuEntry[] =>
    target.kind === "checkout"
      ? checkoutEntries(target.checkout)
      : [{ label: "Copy path", run: () => void navigator.clipboard.writeText(target.worktree.path) }];

  const checkoutRow = (checkout: Checkout): ReactNode => {
    const { key, worktree } = checkout;
    const { projectId } = checkout.ref;
    // HEAD, as context rather than name; for a worktree, whose branch is its name, the branch it
    // was made from.
    const extra = worktree ? heads[key]?.base : heads[key]?.head;
    const classes = ["project-item", ...(worktree ? ["worktree"] : []), ...(key === activeKey ? ["active"] : [])];
    return (
      <div
        key={key}
        className={classes.join(" ")}
        onClick={() => onSelect(key)}
        title={checkout.path}
        onContextMenu={(event) => menu.open(event, { kind: "checkout", checkout })}
      >
        <span className="project-main">
          <span className="project-label">{worktree ? worktreeName(worktree) : checkout.name}</span>
          {extra && <span className="project-extra">({extra})</span>}
        </span>
        {/* All three session states can hold at once, each a button to a session. No ranking as
            on a tab: a row has no single icon to replace. */}
        {(marks[key]?.waiting.length ?? 0) > 0 &&
          rowButton("Open the session waiting for an answer", () => onShowWaiting(key), <SessionMark kind="waiting" />)}
        {marks[key]?.busy &&
          rowButton("Open the session that is working", () => onShowBusy(key), <SessionMark kind="working" />)}
        {/* Going to the session clears the mark. */}
        {(marks[key]?.finished.length ?? 0) > 0 &&
          rowButton("Open the session that finished", () => onShowFinished(key), <SessionMark kind="finished" />)}
        {/* From the status every refresh loads — no extra git call. */}
        {heads[key]?.dirty && rowButton("Uncommitted changes", () => onShowChanges(key), <ChangesIcon />)}
        {/* The switch is on, not that a tab got a sandbox: when sbx is unavailable a tab stays in
            error rather than running on the host (resolveSbxRun). */}
        {sandboxed[projectId] &&
          (worktree ? (
            // A worktree's are its project's, set there: a mark, no button.
            <span className="icon-button" title="SBX enabled">
              <ShieldIcon />
            </span>
          ) : (
            rowButton("SBX enabled", () => onSbxSettings(projectId), <ShieldIcon />)
          ))}
        {rowButton(worktree ? "Delete worktree" : "Remove repository", () => close(checkout), <CloseIcon />)}
      </div>
    );
  };

  /** A worktree git lists that TET did not make: shown, never opened. */
  const foreignRow = (worktree: ProjectWorktree): ReactNode => (
    <div
      key={worktree.path}
      className="project-item worktree foreign"
      title={`${worktree.path}\nA worktree ${NOT_MADE_BY_TET}`}
      onContextMenu={(event) => menu.open(event, { kind: "foreign", worktree })}
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
      busy={gitBusy}
      actions={
        <button className="icon-button" title="Add repository" onClick={onAdd}>
          <PlusIcon />
        </button>
      }
    >
      <div className="project-list" {...listProps}>
        {projects.map((project, index) => {
          const main = checkouts[checkoutKey(checkoutRef(project.id))];
          return (
            <div key={project.id} className={["project-group", ...rowClasses(index)].join(" ")} {...rowProps(index)}>
              {main && checkoutRow(main)}
              {project.worktrees.map((worktree) => {
                const own =
                  worktree.key === undefined ? undefined : checkouts[checkoutKey(checkoutRef(project.id, worktree.key))];
                return own ? checkoutRow(own) : foreignRow(worktree);
              })}
            </div>
          );
        })}
      </div>

      {menu.render(menuEntries)}
    </Section>
  );
});
