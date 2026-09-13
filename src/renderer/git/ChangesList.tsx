import { useEffect, useMemo, useState } from "react";
import type { ChangeStatus, FileChange, GitActionResult, Project, RepositoryState } from "../../shared/types";
import { absolutePath, revealLabel } from "../platform";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, prompt } from "../ui/Dialog";
import {
  MAX_PINNED,
  deleteCommitMessage,
  loadCommitHistory,
  recordCommitMessage,
  toggleCommitPin
} from "./commit-history";

/** Runs a file action against the repository; the owner shows it running on its own bar. */
export type FileAct = (action: () => Promise<GitActionResult>) => void;

interface ChangesListProps {
  project: Project;
  /** Its changes are the list; the rest is what a commit from the menu asks with. */
  state: RepositoryState;
  act: FileAct;
  /** A file to look at, on a double-click. */
  onOpenDiff: (path: string) => void;
}

const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "C"
};

/** Asks before throwing work away; untracked files go to the trash. */
export async function confirmDiscard(projectId: string, paths: string[], act: FileAct): Promise<void> {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  const answer = await confirm({
    title: "Discard changes",
    message: `Are you sure you want to discard all changes to ${what}?`,
    detail: "Files git does not track go to the trash and can be restored from there.",
    confirmLabel: "Discard changes"
  });
  if (answer.confirmed) {
    act(() => window.tet.repository.discard(projectId, paths));
  }
}

/** Stages and commits everything the changes list shows, or only `paths`, with an optional push
 *  in the same action: one message asked, `add` then `commit`. */
export async function askCommit(
  project: Project,
  state: RepositoryState,
  paths: string[] | undefined,
  act: FileAct
): Promise<void> {
  const remote = state.remotes[0]?.name;
  const canSync = remote !== undefined && !state.detached;
  const answer = await prompt({
    title: !paths ? "Commit all changes" : paths.length === 1 ? "Commit changes" : `Commit ${paths.length} selected changes`,
    label: "Message",
    detail: !paths
      ? `Stages and commits all ${state.changes.length} changed files, untracked ones included.`
      : paths.length === 1
        ? `Stages and commits ${paths[0]}; the other changes stay as they are.`
        : `Stages and commits the ${paths.length} selected files; the other changes stay as they are.`,
    value: "",
    confirmLabel: "Commit",
    // The saved commands' width: 420px shows too little of the suggest row and the history list.
    wide: true,
    suggestion: {
      title: "Suggest a commit message",
      run: () => window.tet.repository.suggestCommitMessage(project.id, paths)
    },
    // No remote or a detached HEAD: nothing to offer, so no checkbox either.
    checkboxLabel: canSync
      ? state.upstream === undefined
        ? `Also push ${state.head} to ${remote} and track it`
        : `Also push to ${state.upstream}`
      : undefined,
    history: {
      ...loadCommitHistory(project.id),
      maxPinned: MAX_PINNED,
      onDelete: (text) => deleteCommitMessage(project.id, text),
      onTogglePin: (text) => toggleCommitPin(project.id, text)
    }
  });
  if (answer) {
    // On submit, not on success: a message whose commit then fails is one worth having again.
    recordCommitMessage(project.id, answer.value);
    // The push only runs when the commit went through.
    act(async () => {
      const committed = await (paths
        ? window.tet.repository.commitPaths(project.id, answer.value, paths)
        : window.tet.repository.commitAll(project.id, answer.value));
      return committed.ok && answer.checked ? window.tet.repository.push(project.id) : committed;
    });
  }
}

/** The changed files with a filter and a per-file menu, under LOCAL CHANGES in the git pane. The
 *  owner hands in its `act`, so an action runs on that section's bar. */
export function ChangesList({ project, state, act, onOpenDiff }: ChangesListProps) {
  const { changes } = state;
  const [filter, setFilter] = useState("");
  /** Ctrl- and shift-click extend it, so one discard can cover several files. */
  const [selected, setSelected] = useState<string[]>([]);
  /** Where a shift-click measures its range from: the row that was clicked plainly last. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; change: FileChange } | null>(null);

  const query = filter.trim().toLowerCase();
  const visible = useMemo(
    () => changes.filter((change) => change.path.toLowerCase().includes(query)),
    [changes, query]
  );

  // Another project's files: nothing chosen yet. Compared in render, so the previous project's
  // selection never paints.
  const [projectId, setProjectId] = useState(project.id);
  if (projectId !== project.id) {
    setProjectId(project.id);
    setSelected([]);
    setAnchor(null);
  }

  // A file that stopped being changed leaves the list; keeping it would let a later change
  // reappear pre-selected.
  useEffect(() => {
    setSelected((current) => {
      const kept = current.filter((path) => changes.some((change) => change.path === path));
      return kept.length === current.length ? current : kept;
    });
  }, [changes]);

  /** VS Code's list selection: plain replaces, ctrl toggles, shift takes the range. */
  const select = (event: React.MouseEvent, path: string): void => {
    if (event.shiftKey && anchor) {
      const from = visible.findIndex((change) => change.path === anchor);
      const to = visible.findIndex((change) => change.path === path);
      if (from >= 0 && to >= 0) {
        const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelected(range.map((change) => change.path));
        return;
      }
    }
    setAnchor(path);
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) =>
        current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]
      );
      return;
    }
    setSelected([path]);
  };

  /** The changed-file menu. It acts on the whole selection where that makes sense and on the one
   *  file where it does not — a diff and a file manager each show exactly one thing. */
  const menuEntries = (change: FileChange): ContextMenuEntry[] => {
    // A right-click inside the selection keeps it; one outside has already replaced it.
    const paths = selected.includes(change.path) ? selected : [change.path];
    const one = paths.length === 1;
    const extension = /\.[^./]+$/.exec(change.path)?.[0];
    const discard = (targets: string[]) => () => void confirmDiscard(project.id, targets, act);
    const ignore = (scope: "file" | "extension") => () =>
      act(() => window.tet.repository.ignore(project.id, change.path, scope));

    const entries: ContextMenuEntry[] = [
      { label: "Open diff", run: one ? () => onOpenDiff(change.path) : undefined },
      {
        label: "Open in external editor",
        run: one ? () => void window.tet.shell.openFileExternally(project.id, change.path) : undefined
      },
      SEPARATOR,
      {
        label: one ? "Commit changes..." : `Commit ${paths.length} selected changes...`,
        // git refuses a commit of some paths while a merge is being concluded.
        run: state.operation === undefined ? () => void askCommit(project, state, paths, act) : undefined
      },
      { label: one ? "Discard changes..." : `Discard ${paths.length} selected changes...`, run: discard(paths) },
      {
        label: "Discard all changes...",
        // With nothing but the selection changed it would be the entry above under another name.
        run: changes.length > paths.length ? discard(changes.map((entry) => entry.path)) : undefined
      },
      SEPARATOR,
      {
        label: revealLabel(),
        run: one ? () => void window.tet.shell.revealFile(project.id, change.path) : undefined
      },
      {
        label: one ? "Copy file path" : "Copy file paths",
        run: () => void navigator.clipboard.writeText(paths.map((entry) => absolutePath(project.path, entry)).join("\n"))
      },
      {
        label: one ? "Copy relative file path" : "Copy relative file paths",
        run: () => void navigator.clipboard.writeText(paths.join("\n"))
      }
    ];
    if (one && change.status === "untracked") {
      entries.push(SEPARATOR, { label: "Ignore file (add to .gitignore)", run: ignore("file") });
      if (extension) {
        entries.push({ label: `Ignore all ${extension} files (add to .gitignore)`, run: ignore("extension") });
      }
    }
    return entries;
  };

  return (
    <div className="changes-list">
      <input
        className="changes-filter"
        type="text"
        placeholder="Filter changes..."
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="changes-list-items">
        {visible.map((change) => (
          <button
            key={change.path}
            className={`change-item${selected.includes(change.path) ? " selected" : ""}`}
            onClick={(event) => select(event, change.path)}
            onDoubleClick={() => onOpenDiff(change.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!selected.includes(change.path)) {
                setSelected([change.path]);
                setAnchor(change.path);
              }
              setMenu({ x: event.clientX, y: event.clientY, change });
            }}
            title={`${change.origPath ? `${change.origPath} → ${change.path}` : change.path}\nDouble-click to see the diff`}
          >
            <span className={`change-status ${change.status}`}>{STATUS_LETTER[change.status]}</span>
            <span className="change-path">{change.path}</span>
          </button>
        ))}
        {changes.length === 0 && <div className="placeholder">No local changes.</div>}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.change)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
