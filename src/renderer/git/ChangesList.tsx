import { memo, useMemo, useState } from "react";
import { syncRemote } from "../../shared/types";
import type { ChangeStatus, FileChange, GitActionResult, Project, RepositoryState } from "../../shared/types";
import type { OpenEditor } from "../terminal/editor-tab";
import type { FileAct, FileAsk } from "./run-action";
import { baseName } from "../files/explorer-tree";
import { openEntries, pathEntries } from "../files/file-menu";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, filled, prompt } from "../ui/Dialog";
import { askLogin } from "./GitLogin";
import { Checkbox, SuggestField } from "../ui/Field";
import { FilterField } from "../ui/FilterField";

interface ChangesListProps {
  project: Project;
  /** The changes are the list; the rest feeds a commit from the menu. */
  state: RepositoryState;
  /** The owner shows it running on its own bar. */
  act: FileAct;
  /** For the commit, whose question stays up to show what git refused. */
  ask: FileAsk;
  /** On a double-click; a Markdown file with its preview from the menu. */
  onOpenDiff: (path: string, how?: OpenEditor) => void;
}

const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "C"
};

/** The files go to the trash; where the trash fails, a second question offers to delete them.
 *  Asked although the trash can give them back: a discard is GitHub Desktop's one confirmed
 *  action, and a click on a row's × would otherwise empty the list. */
export async function confirmDiscard(projectId: string, paths: string[], act: FileAct): Promise<void> {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  const answer = await confirm({
    title: "Discard changes",
    message: `Are you sure you want to discard all changes to ${what}?`,
    detail: "The changed files go to the trash and can be restored from there.",
    confirmLabel: "Discard changes"
  });
  if (answer.confirmed) {
    act(async () => {
      const result = await window.tet.repository.discard(projectId, paths, false);
      if (result.needsConfirmation !== "trash-failed") {
        return result;
      }
      void confirmDiscardPermanently(projectId, paths, result.error, act);
      return { ok: true };
    });
  }
}

async function confirmDiscardPermanently(
  projectId: string,
  paths: string[],
  reason: string | undefined,
  act: FileAct
): Promise<void> {
  const answer = await confirm({
    title: "Discard changes permanently",
    message: "The files could not be moved to the trash. Discard the changes permanently?",
    detail: reason,
    confirmLabel: "Discard permanently"
  });
  if (answer.confirmed) {
    act(() => window.tet.repository.discard(projectId, paths, true));
  }
}

/** One message, then `add` and `commit` of all changes or only `paths`, optionally pushing. No
 *  staging area: the selection is what one commit takes. */
export async function askCommit(
  project: Project,
  state: RepositoryState,
  paths: string[] | undefined,
  ask: FileAsk
): Promise<void> {
  const { remote, canSync } = syncRemote(state);
  // No checkbox without a remote or on a detached HEAD.
  const pushLabel = canSync
    ? state.upstream === undefined
      ? `Also push ${state.head} to ${remote} and track it`
      : `Also push to ${state.upstream}`
    : undefined;
  /** What Commit ran, held to ask for the push's login once the commit's question is gone — only
   *  one question is up at a time, and Escape may have closed it while the push still ran. */
  const running: { submitted?: Promise<GitActionResult> } = {};
  const commitAndPush = async (message: string, push: boolean): Promise<GitActionResult> => {
    const committed = await (paths
      ? window.tet.repository.commitPaths(project.id, message, paths)
      : window.tet.repository.commitAll(project.id, message));
    return committed.ok && push ? window.tet.repository.push(project.id) : committed;
  };
  await prompt({
    title: !paths ? "Commit all changes" : paths.length === 1 ? "Commit changes" : `Commit ${paths.length} selected changes`,
    detail: !paths
      ? `Stages and commits all ${state.changes.length} changed files, untracked ones included.`
      : paths.length === 1
        ? `Stages and commits ${paths[0]}; the other changes stay as they are.`
        : `Stages and commits the ${paths.length} selected files; the other changes stay as they are.`,
    value: { message: "", push: false },
    confirmLabel: "Commit",
    ready: ({ message }) => filled(message),
    render: ({ value, onChange, error, busy, field, hold }) => (
      <>
        <SuggestField
          label="Message"
          value={value.message}
          onChange={(message) => onChange({ ...value, message })}
          suggestion={{
            title: "Suggest a commit message",
            run: () => window.tet.repository.suggestCommitMessage(project.id, paths)
          }}
          disabled={busy}
          ref={field}
          error={error}
          onSuggesting={hold}
        />
        {pushLabel && (
          <Checkbox label={pushLabel} checked={value.push} disabled={busy} onChange={(push) => onChange({ ...value, push })} />
        )}
      </>
    ),
    // What git refused — an empty commit, a hook's veto — at the message it was typed for. Not a
    // push wanting a login: the commit stands, and the login is asked for next.
    submit: ({ message, push }) => {
      running.submitted = commitAndPush(message.trim(), push);
      return ask(async () => {
        const result = await running.submitted!;
        return result.loginUrl === undefined ? result : { ok: true };
      });
    }
  });
  const result = await running.submitted;
  if (result?.loginUrl !== undefined) {
    await askLogin(result.loginUrl, result.error ?? "Push failed", (login) =>
      ask(() => window.tet.repository.push(project.id, login))
    );
  }
}

/** LOCAL CHANGES: the changed files with a filter and a per-file menu, run on the owner's `act`. */
export const ChangesList = memo(function ChangesList({ project, state, act, ask, onOpenDiff }: ChangesListProps) {
  const { changes } = state;
  const [filter, setFilter] = useState("");
  /** Ctrl- and shift-click extend it, so one action can cover several files. */
  const [selected, setSelected] = useState<string[]>([]);
  /** A shift-click range starts here: the last row clicked without shift. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const menu = useContextMenu<FileChange>();

  const query = filter.trim().toLowerCase();
  const visible = useMemo(
    () => changes.filter((change) => change.path.toLowerCase().includes(query)),
    [changes, query]
  );

  // Reset on a project switch, in render, so the previous selection never paints.
  const [projectId, setProjectId] = useState(project.id);
  if (projectId !== project.id) {
    setProjectId(project.id);
    setSelected([]);
    setAnchor(null);
  }

  // Drop files no longer changed, or a later change reappears pre-selected. In render as well, and
  // as an updater, so it queues behind the reset above.
  const [prunedFor, setPrunedFor] = useState(changes);
  if (prunedFor !== changes) {
    setPrunedFor(changes);
    setSelected((current) => {
      const kept = current.filter((path) => changes.some((change) => change.path === path));
      return kept.length === current.length ? current : kept;
    });
  }

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

  /** Acts on the selection, except where only one file makes sense (a diff, the file manager). */
  const menuEntries = (change: FileChange): ContextMenuEntry[] => {
    // A right-click outside the selection has already replaced it. Only what the filter shows: a
    // selected file it hides would be committed or discarded unseen.
    const paths = selected.includes(change.path)
      ? selected.filter((path) => visible.some((entry) => entry.path === path))
      : [change.path];
    const one = paths.length === 1;
    // path.extname's rule, as git.ts's ignorePath applies it: a dotfile has none.
    const name = baseName(change.path);
    const extension = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")) : undefined;
    const discard = (targets: string[]) => () => void confirmDiscard(project.id, targets, act);
    const ignore = (scope: "file" | "extension") => () =>
      act(() => window.tet.repository.ignore(project.id, change.path, scope));

    const entries: ContextMenuEntry[] = [
      { label: "Open diff", run: one ? () => onOpenDiff(change.path) : undefined },
      ...openEntries(project.id, change.path, one, (how) => onOpenDiff(change.path, how)),
      SEPARATOR,
      {
        label: one ? "Commit changes..." : `Commit ${paths.length} selected changes...`,
        // git refuses a commit of some paths while a merge is being concluded.
        run: state.operation === undefined ? () => void askCommit(project, state, paths, ask) : undefined
      },
      { label: one ? "Discard changes..." : `Discard ${paths.length} selected changes...`, run: discard(paths) },
      {
        label: "Discard all changes...",
        // When the selection is everything, the entry above already does this.
        run: changes.length > paths.length ? discard(changes.map((entry) => entry.path)) : undefined
      },
      ...pathEntries(project, paths, "file path")
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
      <FilterField placeholder="Filter changes..." value={filter} onChange={setFilter} />
      <div className="changes-list-items">
        {visible.map((change) => (
          <button
            key={change.path}
            className={`tree-item change-item${selected.includes(change.path) ? " selected" : ""}`}
            onClick={(event) => select(event, change.path)}
            onDoubleClick={() => onOpenDiff(change.path)}
            onContextMenu={(event) => {
              if (!selected.includes(change.path)) {
                setSelected([change.path]);
                setAnchor(change.path);
              }
              menu.open(event, change);
            }}
            title={`${change.origPath ? `${change.origPath} → ${change.path}` : change.path}\nDouble-click to see the diff`}
          >
            <span className={`change-status ${change.status}`}>{STATUS_LETTER[change.status]}</span>
            <span className="tree-label">{change.path}</span>
          </button>
        ))}
        {changes.length === 0 && <div className="placeholder">No local changes.</div>}
      </div>

      {menu.render(menuEntries)}
    </div>
  );
});
