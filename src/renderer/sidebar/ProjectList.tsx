import { memo, useState, type ReactNode } from "react";
import type { Project, RemoteInfo } from "../../shared/types";
import { revealLabel } from "../platform";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { prompt } from "../ui/Dialog";
import { reorder, useDragReorder } from "./drag-reorder";
import { notify } from "../ui/Notices";
import { ChangesIcon, CloseIcon, CommentIcon, PlusIcon, QuestionIcon, ShieldIcon, SpinnerIcon } from "../ui/icons";

/** A type of our own: a project dragged across a terminal must not end up pasted into it. */
const DRAG_TYPE = "application/x-tet-project";

/** One action in a project row: the same 24px box around one 13px icon, and every one must keep
 *  its click from reaching the row, whose own job is to select the project. */
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

/** The marked sessions of one project, by tab id, oldest first: finished out of sight, waiting
 *  on an answer, and starting — the last lets the pane a new agent opens in show the bar itself
 *  (`TerminalsPane`'s `startingHere`). `busy` excludes a session stopped on a question. Decided
 *  in `App`, which alone knows what is on screen. */
export interface ProjectMarks {
  finished: string[];
  waiting: string[];
  starting: string[];
  busy: boolean;
}

/** What a row says about the repository: HEAD, first remote, whether it is dirty. */
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
  /** By project id, and by identity only where the answer changed; `App` sees to that. Records
   *  rather than lookup callbacks: a callback closing over every project's state was remade on
   *  every push, and the memo never held. */
  heads: Record<string, ProjectHead>;
  marks: Record<string, ProjectMarks>;
  /** Which projects run their agents in an sbx sandbox, keyed and memoized the same way. */
  sandboxed: Record<string, boolean>;
  /** Opens a shell tab in that project, which is what "open in terminal" means here. */
  onOpenTerminal: (projectId: string) => void;
  /** Opens the first session that is working — what the spinner goes to. */
  onShowBusy: (projectId: string) => void;
  /** Opens the oldest of those; pressing the mark again moves on to the next. */
  onShowFinished: (projectId: string) => void;
  /** The same, for the session that has been waiting on an answer the longest. */
  onShowWaiting: (projectId: string) => void;
  /** Puts the project on screen and toggles the git pane when it is already selected. */
  onShowChanges: (projectId: string) => void;
  /** "SBX Settings" — opens the project's sbx-settings dialog, which runs every check itself. */
  onSbxSettings: (projectId: string) => void;
}

/** The page a remote's git url points at, or null when a browser cannot open it. Both spellings
 *  git uses: "git@host:owner/repo.git" and a real url with a scheme. */
function webUrl(remoteUrl: string): string | null {
  // Excludes a Windows path ("C:\bare\repo.git"): a colon followed by either slash is no host.
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
    // Not a url at all — a local path, say.
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
  sandboxed,
  onOpenTerminal,
  onShowBusy,
  onShowFinished,
  onShowWaiting,
  onShowChanges,
  onSbxSettings
}: ProjectListProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; project: Project } | null>(null);

  const { rowProps, listProps, rowClasses } = useDragReorder({
    dragType: DRAG_TYPE,
    count: projects.length,
    // The id, not the position: it still names the same project if the list changed mid-drag.
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

  /** What a repository can be asked for from its own row. Nothing here touches the working tree;
   *  those actions live in the git pane, where what they act on is on screen. */
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
      { label: "SBX Settings", run: () => onSbxSettings(project.id) },
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
              setMenu({ x: event.clientX, y: event.clientY, project });
            }}
          >
            <span className="project-main">
              <span className="project-label">{project.name}</span>
              {/* Where the repository stands: context for the row, not part of its name. */}
              {heads[project.id]?.head && <span className="project-extra">({heads[project.id].head})</span>}
            </span>
            {/* All three states of a project's sessions, which can hold at once, each a button going to a
                session. No ranking, unlike on a tab: a row has no single icon to replace. */}
            {(marks[project.id]?.waiting.length ?? 0) > 0 &&
              rowButton(
                "Open the session waiting for an answer",
                () => onShowWaiting(project.id),
                <QuestionIcon className="session-mark" />
              )}
            {marks[project.id]?.busy &&
              rowButton(
                "Open the session that is working",
                () => onShowBusy(project.id),
                <SpinnerIcon className="session-mark spinning" />
              )}
            {/* Pressing it goes to the session, which is also what takes the mark away. */}
            {(marks[project.id]?.finished.length ?? 0) > 0 &&
              rowButton(
                "Open the session that finished",
                () => onShowFinished(project.id),
                <CommentIcon className="session-mark" />
              )}
            {/* Uncommitted changes, read off the status every refresh loads — no extra git call. */}
            {heads[project.id]?.dirty &&
              rowButton("Uncommitted changes", () => onShowChanges(project.id), <ChangesIcon />)}
            {/* A standing property of the repository, so outside the mark ranking above. It says the
                switch is on, not that this tab got a sandbox: sbx can be away, and resolveSbxRun then
                runs that one spawn on the host. */}
            {sandboxed[project.id] && rowButton("SBX enabled", () => onSbxSettings(project.id), <ShieldIcon />)}
            {rowButton("Close repository", () => onClose(project.id), <CloseIcon />)}
          </div>
        ))}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.project)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
});
