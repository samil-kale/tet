import { memo, useState } from "react";
import type { Project, RemoteInfo } from "../../shared/types";
import { revealLabel } from "../platform";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { prompt } from "../ui/Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { notify } from "../ui/Notices";
import { CloseIcon, CommentIcon, PlusIcon, QuestionIcon, SpinnerIcon } from "../ui/icons";

/**
 * A type of our own rather than text/plain: a project dragged across a terminal must not end
 * up pasted into it, and the terminal only ever reads dropped files and plain text.
 */
const DRAG_TYPE = "application/x-tet-project";

/**
 * The sessions of one project that are marked, by tab id, oldest first: finished out of sight,
 * waiting on an answer, and starting — the last is what lets the pane a new agent opens in show
 * the bar itself rather than always pane "a" (see `TerminalsPane`'s `startingHere`). `busy` is
 * whether any session is working on a turn, excluding one stopped on a question. Decided in
 * `App`, since the tab in front of the user counts as seen and only `App` knows what's on screen.
 */
export interface ProjectMarks {
  finished: string[];
  waiting: string[];
  starting: string[];
  busy: boolean;
}

/** What a row says about the repository: its HEAD (a branch, or a short commit id), first remote,
 *  and whether it has uncommitted changes. */
export interface ProjectHead {
  head?: string;
  remote?: RemoteInfo;
  dirty?: boolean;
}

interface ProjectListProps {
  projects: Project[];
  activeProjectId: string | null;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
  /** The full list in the order the user dropped it into. */
  onReorder: (projects: Project[]) => void;
  onAdd: () => void;
  /**
   * Both by project id, and — like everything this memoized list takes — by identity only where
   * the answer changed; `App` sees to that. Records rather than lookup callbacks: a callback
   * closing over every project's state was remade on every push, and the memo never held.
   */
  heads: Record<string, ProjectHead>;
  marks: Record<string, ProjectMarks>;
  /** Opens a shell tab in that project, which is what "open in terminal" means here. */
  onOpenTerminal: (projectId: string) => void;
  /** Opens the first session that is working — what the spinner goes to. */
  onShowBusy: (projectId: string) => void;
  /** Opens the oldest of those; pressing the mark again moves on to the next. */
  onShowFinished: (projectId: string) => void;
  /** The same, for the session that has been waiting on an answer the longest. */
  onShowWaiting: (projectId: string) => void;
}

/**
 * The page a remote's git url points at, or null when it is not one a browser can open.
 * Both spellings git uses: "git@host:owner/repo.git" and a real url with a scheme.
 */
function webUrl(remoteUrl: string): string | null {
  // Not a Windows path ("C:\bare\repo.git"): a colon followed by either slash is no host.
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
    // Not a url at all — a local path, say. There is nothing to open.
  }
  return null;
}

/** "View on GitHub" where that is where it is, and the host's own name everywhere else. */
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
  onOpenTerminal,
  onShowBusy,
  onShowFinished,
  onShowWaiting
}: ProjectListProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; project: Project } | null>(null);

  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: projects.length,
    // The id, not the position: it still names the same project if the list changed while
    // the drag was in the air.
    payloadOf: (index) => projects[index].id,
    indexOf: (id) => projects.findIndex((project) => project.id === id),
    onMove: (from, to) => onReorder(reorder(projects, from, to))
  });

  const itemClass = (project: Project, index: number): string => {
    const classes = ["project-item", ...rowClasses(index)];
    if (project.id === activeProjectId) {
      classes.push("active");
    }
    return classes.join(" ");
  };

  const askRemoteUrl = async (project: Project, remote: RemoteInfo): Promise<void> => {
    const answer = await prompt({
      title: "Change remote URL",
      label: `URL of ${remote.name}`,
      value: remote.url ?? "",
      confirmLabel: "Change URL"
    });
    if (!answer || answer.value === remote.url) {
      return;
    }
    const result = await window.tet.repository.setRemoteUrl(project.id, remote.name, answer.value);
    if (!result.ok) {
      notify("error", result.error ?? "Could not change the remote URL");
    }
  };

  /**
   * What a repository can be asked for from its own row. Nothing here touches the working
   * tree — those actions live in the git pane, where what they act on is on screen.
   */
  const menuEntries = (project: Project): ContextMenuEntry[] => {
    const remote = heads[project.id]?.remote;
    const web = remote?.url ? webUrl(remote.url) : null;
    return [
      { label: "Open in terminal", run: () => onOpenTerminal(project.id) },
      { label: revealLabel(), run: () => void window.tet.shell.openProject(project.id) },
      { label: "Copy repository path", run: () => void navigator.clipboard.writeText(project.path) },
      SEPARATOR,
      {
        label: web ? `View on ${hostName(web)}` : "View in browser",
        run: web ? () => void window.tet.shell.openUrl(web) : undefined
      },
      {
        label: "Change remote URL...",
        run: remote ? () => void askRemoteUrl(project, remote) : undefined
      },
      SEPARATOR,
      { label: "Close repository", run: () => onClose(project.id) }
    ];
  };

  return (
    <div className="section grows">
      <div className="section-header">
        <span>
          PROJECTS <span className="count-badge">({projects.length})</span>
        </span>
        <button className="icon-button" title="Add repository" onClick={onAdd}>
          <PlusIcon />
        </button>
      </div>
      <div className="project-list" {...listProps}>
        {projects.map((project, index) => (
          <div
            key={project.id}
            className={itemClass(project, index)}
            onClick={() => onSelect(project.id)}
            title={project.path}
            {...rowProps(index)}
            onContextMenu={(event) => {
              event.preventDefault();
              onSelect(project.id);
              setMenu({ x: event.clientX, y: event.clientY, project });
            }}
          >
            <span className="project-main">
              <span className="project-label">{project.name}</span>
              {/* Where the repository stands, next to what a command runs with in the list below
                  and drawn the same way: context for the row, not part of its name. The git pane
                  says it for the project on screen only, and an agent switching a branch in a
                  terminal is exactly what one wants to see on a project that is not. */}
              {heads[project.id]?.head && <span className="project-extra">({heads[project.id].head})</span>}
              {/* Uncommitted changes, read off the same status every refresh already loads
                  (`state.changes`) — no extra git call. The modified-file color, not a new one:
                  the same fact the changes list marks each such file with, just rolled up. */}
              {heads[project.id]?.dirty && (
                <span className="project-dirty" title="Has uncommitted changes" />
              )}
            </span>
            {/* All three states of a project's sessions, and they can hold at once — one tab
                stopped on a question, another working, a third waiting to be read. Each is a
                button and each goes to a session. Unlike on a tab there is no ranking here:
                a row has no single icon to replace, so nothing has to give way to anything.
                A standing question comes first because it is the one costing time. */}
            {(marks[project.id]?.waiting.length ?? 0) > 0 && (
              <button
                className="icon-button"
                title="Open the session waiting for an answer"
                onClick={(event) => {
                  event.stopPropagation();
                  onShowWaiting(project.id);
                }}
              >
                <QuestionIcon className="session-mark" />
              </button>
            )}
            {marks[project.id]?.busy && (
              <button
                className="icon-button"
                title="Open the session that is working"
                onClick={(event) => {
                  event.stopPropagation();
                  onShowBusy(project.id);
                }}
              >
                <SpinnerIcon className="session-mark spinning" />
              </button>
            )}
            {/* A session of this project finished while its terminal was out of sight. Pressing
                it goes there, which is also what takes it away again. */}
            {(marks[project.id]?.finished.length ?? 0) > 0 && (
              <button
                className="icon-button"
                title="Open the session that finished"
                onClick={(event) => {
                  event.stopPropagation();
                  onShowFinished(project.id);
                }}
              >
                <CommentIcon className="session-mark" />
              </button>
            )}
            <button
              className="icon-button"
              title="Close repository"
              onClick={(event) => {
                event.stopPropagation();
                onClose(project.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.project)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
});
