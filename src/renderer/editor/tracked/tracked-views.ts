import type { ActionResult } from "../../../shared/types/action";
import type { AgentId } from "../../../shared/types/agents";
import {
  isChangeRequest,
  isTimeRemoval,
  type ChangeRequestDetail,
  type ChecksState,
  type TrackedChange,
  type TrackedDetail,
  type TrackedField,
  type TrackedFieldValue,
  type TrackedKind,
  type TrackedRef,
  type TrackedRow,
} from "../../../shared/types/providers";
import { toBase64 } from "../../ui/base64";
import { refusal } from "../../ui/Dialog";
import { notify, notifying } from "../../ui/Notices";
import { isMarkdown } from "../diff-highlight";
import { issueGone, openFile, revealTracked, sendTrackedToAgent, trackedChanged } from "../editor-tab";
import { allViews, disposed, publish, stale, viewOf, type EditorView } from "../editor-views";
import { keepSeen } from "./tracked-seen";

/**
 * What an issue's or change request's tab does, on its view outside React (`editor-views.ts`, which
 * reads it into the tab): reading it again, writing to its host under the tab's bar, and showing a
 * change ahead of the host's answer.
 */

/** An image of the text of tab `tabId`'s issue or change request (`loadProjectTrackedImage`). */
export function loadTrackedImage(tabId: string, source: string): Promise<string | undefined> {
  const view = viewOf(tabId);
  return loadProjectTrackedImage(view?.ref.projectId, view?.snapshot.tracked?.kind ?? "issue", source);
}

/** An image of the text of an issue or change request of project `projectId`, an issue yet to be made
 *  too: through the account where it takes the token, else a web image as a preview's. A text of no
 *  project has web images alone. */
export async function loadProjectTrackedImage(
  projectId: string | undefined,
  kind: TrackedKind,
  source: string,
): Promise<string | undefined> {
  const image = projectId === undefined ? null : await window.tet.tracked.image(projectId, kind, source);
  if (image !== null) {
    return image;
  }
  return /^https:/i.test(source) ? ((await window.tet.shell.fetchImage(source)) ?? undefined) : undefined;
}

/** Any other link of the text of tab `tabId`'s issue (`openProjectIssueLink`); a change request's
 *  opens in the browser, as it saves no upload. */
export function openTrackedLink(tabId: string, url: string): void {
  const view = viewOf(tabId);
  if (view?.snapshot.tracked?.kind === "change-request") {
    void window.tet.shell.openUrl(url);
    return;
  }
  void openProjectIssueLink(view?.ref.projectId, url);
}

/** `openTrackedLink` for the text of an issue of project `projectId`, an issue yet to be made too: an
 *  upload the account reads is saved where the user picks, the rest open in the browser. */
export async function openProjectIssueLink(projectId: string | undefined, url: string): Promise<void> {
  const saved = projectId === undefined ? { upload: false } : await window.tet.issues.saveUpload(projectId, url);
  if (saved.error !== undefined) {
    notify("error", saved.error);
  } else if (!saved.upload) {
    void window.tet.shell.openUrl(url);
  }
}

/** An issue a change request of tab `tabId` is linked to, opened in the repository's or worktree's
 *  preview tab. */
export function openLinkedIssue(tabId: string, number: number): void {
  const view = viewOf(tabId);
  if (view) {
    revealTracked(view.ref, { kind: "issue", number });
  }
}

/** A file of the repository or worktree of tab `tabId`, led to by a link of its issue's text. */
export function openTrackedFile(tabId: string, path: string): void {
  const view = viewOf(tabId);
  if (view) {
    openFile(view.ref, path, isMarkdown(path));
  }
}

/** Runs a write to the tracker under the tab's progress bar, however many overlap. */
export async function underTrackedBar<T>(view: EditorView, work: () => Promise<T>): Promise<T> {
  view.trackedWork = (view.trackedWork ?? 0) + 1;
  publish(view, { saving: true });
  try {
    return await work();
  } finally {
    view.trackedWork -= 1;
    if (view.trackedWork === 0 && !disposed(view)) {
      publish(view, { saving: false });
    }
  }
}

/** Tab `tabId`'s view and the issue or change request it shows, where it shows one. */
export function trackedTab(tabId: string): { view: EditorView; tracked: TrackedRef } | undefined {
  const view = viewOf(tabId);
  const tracked = view?.snapshot.tracked;
  return view && tracked ? { view, tracked } : undefined;
}

/** The issue's tab read afresh from the tracker, what it shows standing until the answer lands. It
 *  reads once the changes on their way are through, and again if one overtakes the answer, or it
 *  would take back what the tab already shows. Never awaited from within `trackedWrites`, which it
 *  waits for. */
export async function reloadTracked(tabId: string): Promise<void> {
  const tab = trackedTab(tabId);
  if (!tab) {
    return;
  }
  const { view, tracked } = tab;
  const seq = view.readSeq;
  publish(view, { loading: true });
  await view.trackedWrites;
  if (stale(view, seq)) {
    return;
  }
  const edits = view.trackedEdits;
  const { detail, markdown, error } = await window.tet.tracked.read(view.ref.projectId, tracked);
  if (stale(view, seq)) {
    return;
  }
  if (view.trackedEdits !== edits) {
    await view.trackedWrites;
    return reloadTracked(tabId);
  }
  const file = view.snapshot.file;
  publish(view, {
    loading: false,
    trackedDetail: detail ?? view.snapshot.trackedDetail,
    // A read that came takes back what an earlier one failed with: the tab shows it again.
    file: file && detail ? { ...file, content: markdown ?? file.content, error: undefined } : file,
  });
  if (!detail) {
    notify("error", error ?? `Could not read ${tracked.kind} ${tracked.number}`);
  }
}

/** How the checks of a change request the tab read stand; undefined for an issue's. */
export function checksOf(read: TrackedDetail): ChecksState | undefined {
  return isChangeRequest(read) ? read.checks : undefined;
}

/** The tab's issue or change request is on screen as the tab has read it, a change request's checks
 *  with it (`keepSeen`). */
export function markTrackedSeen(tabId: string): void {
  const tab = trackedTab(tabId);
  const read = tab?.view.snapshot.trackedDetail;
  if (tab && read) {
    keepSeen(tab.view.ref.projectId, tab.tracked, read.updatedAt, checksOf(read) === "failed");
  }
}

/** The project of the issue or change request the tab shows: whose session its side column shows. */
export function trackedProjectOf(tabId: string): string | undefined {
  return trackedTab(tabId)?.view.ref.projectId;
}

/** The tab's issue or change request sent to a new tab of the agent, beside it. */
export function sendTabTrackedToAgent(tabId: string, agentId: AgentId): void {
  const tab = trackedTab(tabId);
  if (tab) {
    void sendTrackedToAgent(tab.view.ref, tab.tracked, agentId);
  }
}

/** The tabs of the project open on one of the kind, with its number and what the tab has read of it. */
export function trackedTabsOf(kind: TrackedKind, projectId: string): { tabId: string; number: number; read: TrackedDetail | undefined }[] {
  return allViews().flatMap(({ tabId, ref, snapshot }) => {
    const { tracked } = snapshot;
    return ref.projectId === projectId && tracked?.kind === kind ? [{ tabId, number: tracked.number, read: snapshot.trackedDetail }] : [];
  });
}

/** Every tab of the project open on one of the kind reads it again. */
export function reloadTrackedTabs(kind: TrackedKind, projectId: string): void {
  for (const { tabId } of trackedTabsOf(kind, projectId)) {
    void reloadTracked(tabId);
  }
}

/** Every tab of the project whose issue or change request `rows` lists as changed since the tab read
 *  it, or with its checks standing otherwise, reads it again. A tab whose one is not listed stays as
 *  it is. */
export function reloadChangedTabs(kind: TrackedKind, projectId: string, rows: (TrackedRow & { checks?: ChecksState })[]): void {
  for (const { tabId, number, read } of trackedTabsOf(kind, projectId)) {
    const listed = rows.find((candidate) => candidate.number === number);
    if (read && listed && (listed.updatedAt !== read.updatedAt || listed.checks !== checksOf(read))) {
      void reloadTracked(tabId);
    }
  }
}

/** A write to the tab's issue or change request under its bar, the tab reading it again once it went
 *  through; false, with a notice, when refused. Nothing its section's rows show changes by it. */
export async function writeTracked(
  tabId: string,
  write: (projectId: string, tracked: TrackedRef) => Promise<ActionResult>,
): Promise<boolean> {
  const tab = trackedTab(tabId);
  if (!tab) {
    return false;
  }
  const result = await underTrackedBar(tab.view, () => write(tab.view.ref.projectId, tab.tracked));
  if (!result.ok) {
    notify("error", result.error);
    return false;
  }
  await reloadTracked(tabId);
  return true;
}

/** A comment on the tab's issue, which shows once it is up (`writeTracked`). */
export function commentOnTracked(tabId: string, body: string, internal: boolean): Promise<boolean> {
  return writeTracked(tabId, (projectId, tracked) => window.tet.tracked.comment(projectId, tracked, body, internal));
}

/** A comment of the tab's issue changed (`writeTracked`). */
export function editTrackedComment(tabId: string, id: string, body: string): Promise<boolean> {
  return writeTracked(tabId, (projectId, { kind }) => window.tet.tracked.editComment(projectId, kind, id, body));
}

/** A comment of the tab's issue deleted (`writeTracked`). */
export async function deleteTrackedComment(tabId: string, id: string): Promise<void> {
  await writeTracked(tabId, (projectId, { kind }) => window.tet.tracked.deleteComment(projectId, kind, id));
}

/** The tab's change request approved as the account's user (`writeTracked`). */
export async function approveChangeRequest(tabId: string): Promise<void> {
  await writeTracked(tabId, (projectId, { number }) => window.tet.changeRequests.approve(projectId, number));
}

/** The tab's change request merged by the repository's own method, or set to be once its checks
 *  passed (`writeTracked`); its section reads it again. */
export async function mergeChangeRequest(tabId: string, whenChecksPass: boolean): Promise<void> {
  const projectId = trackedTab(tabId)?.view.ref.projectId;
  const merged = await writeTracked(tabId, (project, { number }) => window.tet.changeRequests.merge(project, number, whenChecksPass));
  if (merged && projectId !== undefined) {
    trackedChanged("change-request", projectId);
  }
}

/** The tab's issue deleted on the tracker, its tabs closed with it, or a notice when refused. */
export async function deleteIssue(tabId: string): Promise<void> {
  const tab = trackedTab(tabId);
  if (!tab) {
    return;
  }
  const { projectId } = tab.view.ref;
  const result = await underTrackedBar(tab.view, () => window.tet.issues.delete(projectId, tab.tracked.number));
  if (!result.ok) {
    notify("error", result.error);
    return;
  }
  trackedChanged("issue", projectId);
  issueGone(projectId, tab.tracked.number);
}

/** What a pick field of the tab's issue can be set to; undefined, with a notice, when the tracker
 *  cannot say. */
export async function trackedFieldOptions(tabId: string, fieldId: string): Promise<string[] | undefined> {
  const tab = trackedTab(tabId);
  if (!tab) {
    return undefined;
  }
  const { options, error } = await window.tet.tracked.fieldOptions(tab.view.ref.projectId, tab.tracked, fieldId);
  if (options === undefined) {
    notify("error", error ?? "Could not read the options");
  }
  return options;
}

/** A file up on the tab's tracker, answered as the Markdown that shows it; undefined, with a notice,
 *  when refused. */
export async function uploadIssueFile(tabId: string, file: File): Promise<string | undefined> {
  const view = viewOf(tabId);
  if (!view) {
    return undefined;
  }
  // A pasted image comes without a name of its own.
  const name = file.name || `pasted-${Date.now()}.${file.type.split("/")[1] ?? "bin"}`;
  const data = toBase64(await file.arrayBuffer());
  const { markdown, error } = await underTrackedBar(view, () => window.tet.issues.upload(view.ref.projectId, name, data));
  if (markdown === undefined) {
    notify("error", error ?? `Could not upload ${name}`);
  }
  return markdown;
}

/** Changes the tab's issue: `show` shown at once, `write` run in turn after the writes before it, and
 *  the issue read back from the tracker once the last of them is through. Answers what the tracker
 *  refused. */
export async function changeTracked(
  tabId: string,
  show: (detail: TrackedDetail) => TrackedDetail,
  write: (projectId: string, tracked: TrackedRef) => Promise<ActionResult>,
): Promise<string | undefined> {
  const tab = trackedTab(tabId);
  const detail = tab?.view.snapshot.trackedDetail;
  if (!tab || !detail) {
    return undefined;
  }
  const { view, tracked } = tab;
  publish(view, { trackedDetail: show(detail) });
  const edit = (view.trackedEdits ?? 0) + 1;
  view.trackedEdits = edit;
  const { projectId } = view.ref;
  const previous = view.trackedWrites ?? Promise.resolve();
  const written = underTrackedBar(view, async () => {
    await previous;
    const result = await write(projectId, tracked);
    if (result.ok) {
      trackedChanged(tracked.kind, projectId);
    }
    if (view.trackedEdits === edit) {
      void reloadTracked(tabId);
    }
    return refusal(result);
  });
  view.trackedWrites = written;
  return await written;
}

/** The issue or change request with a change of its own parts shown; a change request's state, beside
 *  `open`, takes it too. */
export function withChange(detail: TrackedDetail, change: TrackedChange): TrackedDetail {
  const changed = {
    ...detail,
    title: change.title ?? detail.title,
    body: change.body ?? detail.body,
    open: change.state === undefined ? detail.open : change.state === "open",
  };
  if (!isChangeRequest(changed) || change.state === undefined) {
    return changed;
  }
  const request: ChangeRequestDetail = { ...changed, state: change.state };
  return request;
}

/** The field as it reads once set to `value`; a timelog's new entry and total are left to the read
 *  back. */
export function withValue(field: TrackedField, value: TrackedFieldValue): TrackedField {
  switch (field.kind) {
    case "pick":
      return { ...field, value: value as string[] };
    case "flag":
      return { ...field, value: value as boolean };
    case "timelog":
      return isTimeRemoval(value) ? { ...field, entries: field.entries.filter((entry) => entry.id !== value.remove) } : field;
    case "text":
    case "date":
    case "duration":
      return { ...field, value: (value as string | null) ?? undefined };
    case "number":
      return { ...field, value: (value as number | null) ?? undefined };
  }
}

/** Changes the tab's issue's own parts, answering what the tracker refused (`changeTracked`). */
export function changeParts(tabId: string, change: TrackedChange): Promise<string | undefined> {
  return changeTracked(
    tabId,
    (detail) => withChange(detail, change),
    (projectId, tracked) => window.tet.tracked.update(projectId, tracked, change),
  );
}

/** Changes the tab's issue, with a notice if the tracker refuses (`changeParts`). */
export function updateTracked(tabId: string, change: TrackedChange): void {
  notifying(changeParts)(tabId, change);
}

/** The tab's issue under a new title, answering what the tracker refused (`changeParts`). */
export function renameTracked(tabId: string, title: string): Promise<string | undefined> {
  return changeParts(tabId, { title });
}

/** Sets a field of the tab's issue, answering what the tracker refused (`changeTracked`). */
export function editTrackedField(tabId: string, fieldId: string, value: TrackedFieldValue): Promise<string | undefined> {
  return changeTracked(
    tabId,
    (detail) => ({ ...detail, fields: detail.fields.map((field) => (field.id === fieldId ? withValue(field, value) : field)) }),
    (projectId, tracked) => window.tet.tracked.setField(projectId, tracked, fieldId, value),
  );
}

/** Sets a field of the tab's issue, with a notice if the tracker refuses (`changeTracked`). */
export function setTrackedField(tabId: string, fieldId: string, value: TrackedFieldValue): void {
  notifying(editTrackedField)(tabId, fieldId, value);
}
