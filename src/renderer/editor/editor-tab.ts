import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import { sameTracked, trackedFileName, type TrackedKind, type TrackedRef } from "../../shared/types/providers";
import type { TrackedSession } from "../../shared/types/terminals";
import { notify } from "../ui/Notices";

/**
 * The non-terminal tabs: a project's files in monaco, VS Code's preview semantics. One preview tab
 * per repository or worktree, replaced by the next file opened; it is kept (no longer replaced) by an
 * edit, "Keep Open" or an Explorer double-click, and the next file gets a new preview tab. Which tab
 * is the preview is the editor's own state (`editor-views.ts`), decided where an edit lands. A path
 * is open in at most one tab per repository or worktree, a commit's file in one per commit, and an
 * issue or change request in one.
 * Renderer-only: no pty, no session; a restart brings it back under its id (`use-tab-restore.ts`,
 * `serializeLayout`).
 *
 * Ids count up within a run, after a stamp of the run, so the preview tab keeps its id, pane and
 * place when its file changes, and a restored tab's id is never handed out again. The prefix is
 * shaped unlike any session id, which `loadLayout` hands back as tab ids.
 */
const EDITOR_TAB_PREFIX = "tet:editor:";

const RUN_STAMP = Date.now().toString(36);

let editorTabs = 0;

export function nextEditorTabId(): string {
  return `${EDITOR_TAB_PREFIX}${RUN_STAMP}-${++editorTabs}`;
}

/** Where a search result opens its file: the match, 1-based as the editor counts. */
export interface EditorReveal {
  line: number;
  column: number;
  length: number;
}

/** A file as a commit left it, against the commit's first parent: the Graph's diff. */
export interface CommitSide {
  sha: string;
  /** The first parent; absent for a root commit. */
  parent?: string;
  /** A rename's source path, the one the parent has. */
  origPath?: string;
}

/**
 * How a file is opened, named rather than passed as a row of booleans: every view that opens one
 * says the same thing, and the rule for its own kind of click lives at that one call.
 */
export interface OpenEditor {
  /** The side the tab opens on: the changes list opens a change against HEAD, everything else a
   *  plain file, as VS Code shows it. A tab already open only ever has its diff switched on. */
  diff?: boolean;
  /** A tab of its own instead of the project's preview tab. */
  keep?: boolean;
  /** Left behind its pane's active tab (`tet-ctl editor-open --background`). */
  background?: boolean;
  /** A Markdown file with its preview beside the editor, and the default for the ones after. */
  markdownPreview?: boolean;
  /** Brought back by a restart (`use-tab-restore.ts`): its source, diff, Markdown preview and view
   *  as they were left, the default left alone; a file gone meanwhile shows as such, unannounced. */
  restored?: EditorEntry;
  /** A search result's match, selected once the file's text is in the editor. */
  reveal?: EditorReveal;
  /** The file at a commit, read-only, instead of the working tree's. */
  commit?: CommitSide;
  /** The project's issue or change request, as `trackedFileName`: no file of the tree. */
  tracked?: TrackedRef;
}

/** Opens the project's issue or change request in an editor tab as `open` opens a file: by its
 *  `trackedFileName`, what it shows. Answers what `open` does. */
export function openTrackedTab<T>(
  open: (ref: ProjectRef, path: string, how: OpenEditor) => T,
  ref: ProjectRef,
  tracked: TrackedRef,
  how: Omit<OpenEditor, "tracked"> = {},
): T {
  return open(ref, trackedFileName(tracked), { ...how, tracked });
}

/** How a Markdown file shows: the editor alone, the preview beside it, or the preview alone. */
export type MarkdownPreviewMode = "off" | "side" | "only";

export const MARKDOWN_PREVIEW_MODES: readonly MarkdownPreviewMode[] = ["off", "side", "only"];

/** What a restart brings back of an editor tab, its file and the editor as it was left — kept in
 *  the layout (`serializeLayout`), read from the editor (`editorEntry`). */
export interface EditorEntry {
  path: string;
  commit?: CommitSide;
  tracked?: TrackedRef;
  preview: boolean;
  diff: boolean;
  markdownPreview: MarkdownPreviewMode;
  /** Cursor, scroll and folds, in monaco's own shape (`saveViewState`). */
  viewState?: unknown;
}

export interface EditorTab {
  tabId: string;
  ref: ProjectRef;
  /** Repository-relative path of the file shown. */
  path: string;
  /** Set for a Graph diff: a path is then open once per commit. */
  commit?: CommitSide;
  /** Set for an issue or change request, whose `path` is only its `trackedFileName`. */
  tracked?: TrackedRef;
}

/** Closes every tab of an issue that is gone, in the repository and its worktrees. Set by `useEditorOpening`. */
let issueGoneHandler: ((projectId: string, number: number) => void) | undefined;

export function setIssueGoneHandler(handler: (projectId: string, number: number) => void): () => void {
  issueGoneHandler = handler;
  return () => {
    if (issueGoneHandler === handler) {
      issueGoneHandler = undefined;
    }
  };
}

export function issueGone(projectId: string, number: number): void {
  issueGoneHandler?.(projectId, number);
}

/** Shows a tab opened on an issue or change request or linked to one, its repository or worktree made
 *  active. Set by `useEditorOpening`. */
let trackedTabHandler: ((ref: ProjectRef, tabId: string) => void) | undefined;

export function setTrackedTabHandler(handler: (ref: ProjectRef, tabId: string) => void): () => void {
  trackedTabHandler = handler;
  return () => {
    if (trackedTabHandler === handler) {
      trackedTabHandler = undefined;
    }
  };
}

/** A new tab of the agent in the repository or worktree, shown, the issue or change request its first
 *  prompt; a notice when it cannot be read. */
export async function sendTrackedToAgent(ref: ProjectRef, tracked: TrackedRef, agentId: AgentId): Promise<void> {
  const result = await window.tet.tracked.sendToAgent(ref, tracked, agentId);
  if (result.ok) {
    trackedTabHandler?.(ref, result.tab.tabId);
  } else {
    notify("error", result.error);
  }
}

/** A session linked to an issue or change request brought to the front, an archived one reopened
 *  first; a notice when it cannot be. */
export async function openTrackedSession({ ref, tabId, archived }: TrackedSession): Promise<void> {
  if (archived) {
    const result = await window.tet.archive.reopen(ref, tabId);
    if (!result.ok) {
      notify("error", result.error);
      return;
    }
  }
  trackedTabHandler?.(ref, tabId);
}

/** A session taken off the issue or change request; a notice when it cannot be. */
export async function unlinkTrackedSession({ ref, tabId }: TrackedSession, tracked: TrackedRef): Promise<void> {
  const result = await window.tet.tabs.unlink(ref, tabId, tracked);
  if (!result.ok) {
    notify("error", result.error);
  }
}

/** The tab's session linked to the issue or change request it was dropped on; a notice says what
 *  that changed, named as `nameOf` names one of its kind, or what refused it. */
export async function linkTrackedSession(
  ref: ProjectRef,
  tabId: string,
  tracked: TrackedRef,
  nameOf: (number: number) => string,
): Promise<void> {
  const result = await window.tet.tabs.link(ref, tabId, tracked);
  if (!result.ok) {
    notify("error", result.error);
    return;
  }
  const { movedFrom, replacedSession } = result;
  const linked =
    movedFrom === undefined
      ? `Session linked to ${nameOf(tracked.number)}`
      : `Session moved from ${nameOf(movedFrom)} to ${nameOf(tracked.number)}`;
  notify("info", replacedSession ? `${linked} in place of its previous one` : linked);
}

const trackedListeners = new Set<(projectId: string, kind: TrackedKind) => void>();

/** A project's issue or change request changed through its tab, for its section to read again. */
export function trackedChanged(kind: TrackedKind, projectId: string): void {
  for (const listener of trackedListeners) {
    listener(projectId, kind);
  }
}

/** `listener` hears of changes of the kind alone. */
export function subscribeTracked(kind: TrackedKind, listener: (projectId: string) => void): () => void {
  const heard = (projectId: string, changed: TrackedKind): void => {
    if (changed === kind) {
      listener(projectId);
    }
  };
  trackedListeners.add(heard);
  return () => trackedListeners.delete(heard);
}

/** What an editor tab shows, beside its path. */
type EditorSource = Pick<EditorTab, "commit" | "tracked">;

/** Whether an editor tab shows the working tree's file: a commit's file, an issue and a change request
 *  are not in it. */
export function inWorkingTree({ commit, tracked }: EditorSource): boolean {
  return !commit && tracked === undefined;
}

/** Whether `tab` shows what `wanted` names: a path is open once per repository or worktree, a
 *  commit's file once per commit, an issue or change request once. */
export function showsSame(tab: EditorTab, wanted: EditorSource & { path: string }): boolean {
  return tab.path === wanted.path && tab.commit?.sha === wanted.commit?.sha && sameTracked(tab.tracked, wanted.tracked);
}

/** The path of tab `tabId` where it shows the working tree's file, the one the Explorer marks open. */
export function workingTreePathOf(tabs: EditorTab[] | undefined, tabId: string | undefined): string | null {
  const tab = tabs?.find((candidate) => candidate.tabId === tabId);
  return tab && inWorkingTree(tab) ? tab.path : null;
}

/** The number of the issue or change request of the kind tab `tabId` shows, the one its section marks
 *  open. */
export function trackedNumberOf(kind: TrackedKind, tabs: EditorTab[] | undefined, tabId: string | undefined): number | null {
  const { tracked } = tabs?.find((candidate) => candidate.tabId === tabId) ?? {};
  return tracked?.kind === kind ? tracked.number : null;
}

export function isEditorTabId(tabId: string): boolean {
  return tabId.startsWith(EDITOR_TAB_PREFIX);
}

/** Opens a file of the repository or worktree in its preview tab, a Markdown file with its preview
 *  beside the editor if asked. Set by `useEditorOpening`. */
let revealHandler: ((ref: ProjectRef, path: string, how: OpenEditor) => void) | undefined;

export function setRevealHandler(handler: (ref: ProjectRef, path: string, how: OpenEditor) => void): () => void {
  revealHandler = handler;
  return () => {
    if (revealHandler === handler) {
      revealHandler = undefined;
    }
  };
}

/** The project's issue or change request opened in the preview tab of the repository or worktree, as
 *  a file is: a change request's linked issue. */
export function revealTracked(ref: ProjectRef, tracked: TrackedRef): void {
  if (revealHandler) {
    openTrackedTab(revealHandler, ref, tracked);
  }
}

/** A ctrl-clicked path or a Markdown preview's link: main finds it, opens one outside the
 *  repository itself, and says when there is none. */
export function openFile(ref: ProjectRef, filePath: string, markdownPreview = false): void {
  void window.tet.shell.openFile(ref, filePath).then((repoPath) => {
    if (repoPath) {
      revealHandler?.(ref, repoPath, { markdownPreview });
    }
  });
}
