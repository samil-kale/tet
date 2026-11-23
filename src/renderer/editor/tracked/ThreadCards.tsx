import { useState } from "react";
import type { ReviewThread, TrackedDetail } from "../../../shared/types/providers";
import { Checkbox } from "../../ui/Field";
import { TextBox, TrackedText } from "./TextBox";
import type { TrackedActions, TextWriting, TextRendering } from "./tracked-actions";
import { agoOf, changeRequestOf, label, listed, login, trackedNoun } from "./tracked-words";
import { IconButton } from "../../ui/IconButton";
import { ChevronIcon, PencilIcon, TrashIcon } from "../../ui/icons";
import { Person } from "./Person";
import { named } from "../../ui/named";
import { ActionLink } from "../../ui/ActionLink";
import type { ThreadEvent } from "./tracked-thread";

export interface CommentBoxProps {
  issue: TrackedDetail;
  /** Offered where the tracker has internal comments. */
  internalNotes: boolean;
  actions: TrackedActions;
  writing: TextWriting;
}

export function CommentBox({ issue, internalNotes, actions, writing }: CommentBoxProps) {
  const { open } = issue;
  const request = changeRequestOf(issue);
  const noun = trackedNoun(issue);
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const typed = text.trim() !== "";
  const written = internal ? "Internal Note" : "Comment";
  const reset = (): void => {
    setText("");
    setInternal(false);
  };
  const submit = async (): Promise<void> => {
    setBusy(true);
    if (await actions.comment(text, internal)) {
      reset();
    }
    setBusy(false);
  };
  /** What was typed goes up first: refused, the state stays as well. */
  const changeState = async (): Promise<void> => {
    setBusy(true);
    if (!typed || (await actions.comment(text, internal))) {
      reset();
      actions.update({ state: open ? "closed" : "open" });
    }
    setBusy(false);
  };
  return (
    <div className="issue-comment">
      <div className="issue-card">
        <div className="issue-card-edit">
          <TextBox label="Add a comment" value={text} onChange={setText} disabled={busy} writing={writing} />
        </div>
      </div>
      <div className="issue-line">
        {internalNotes && <Checkbox label="Make this an internal note" checked={internal} onChange={setInternal} disabled={busy} />}
        {/* A merged change request has no state left to change. */}
        {request?.state !== "merged" && (
          <button type="button" className="button secondary" disabled={busy} onClick={() => void changeState()}>
            {open ? `Close ${noun}` : `Reopen ${noun}`}
            {typed && ` with ${written}`}
          </button>
        )}
        <button type="button" className="button" disabled={busy || !typed} onClick={() => void submit()}>
          {internal ? "Add Internal Note" : "Comment"}
        </button>
      </div>
    </div>
  );
}

export interface TrackedCardProps {
  author: string;
  avatar: string | undefined;
  /** The issue's own text, whose title says it was opened; a comment's names the author and time alone. */
  opened?: boolean;
  at: string;
  /** The Markdown as written. */
  text: string;
  writing: TextWriting;
  /** A comment the project's members alone see: marked as such. */
  internal?: boolean;
  /** Offered where it can be changed; false keeps the box open. */
  onEdit?: (text: string) => Promise<boolean>;
  onDelete?: () => void;
}

export function TrackedCard({ author, avatar, opened, at, text, writing, internal, onEdit, onDelete }: TrackedCardProps) {
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    if (draft !== undefined && (await onEdit?.(draft))) {
      setDraft(undefined);
    }
    setBusy(false);
  };
  return (
    <div className="issue-card">
      <div className="issue-card-header">
        <Person login={author} avatar={avatar} />
        <span className="issue-card-title">
          <span className="issue-card-author">{author}</span> {opened && "opened "}
          {agoOf(at)}
        </span>
        {internal && (
          <span className="issue-label" title="Visible to project members only">
            Internal note
          </span>
        )}
        {onEdit && (
          <IconButton title="Edit" onClick={() => setDraft(text)}>
            <PencilIcon />
          </IconButton>
        )}
        {onDelete && (
          <IconButton title="Delete..." onClick={onDelete}>
            <TrashIcon />
          </IconButton>
        )}
      </div>
      {draft !== undefined ? (
        <div className="issue-comment issue-card-edit">
          <TextBox label="Text" value={draft} onChange={setDraft} disabled={busy} writing={writing} />
          <div className="issue-line">
            <button type="button" className="button secondary" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      ) : text === "" ? (
        <div className="issue-empty">No description provided.</div>
      ) : (
        <TrackedText {...writing.rendering} text={text} />
      )}
    </div>
  );
}

/**
 * A change request's review thread, as the plugin draws one in a pull request's overview: a card headed
 * by the file and line it was written on, its comments below it, none offered to change. A resolved one
 * is folded to its head until opened.
 */
export function ReviewThreadCard({
  thread,
  avatars,
  rendering,
}: {
  thread: ReviewThread;
  avatars: Record<string, string>;
  rendering: TextRendering;
}) {
  const [open, setOpen] = useState(!thread.resolved);
  return (
    <div className={open ? "issue-card" : "issue-card review-thread-folded"} data-review-thread={thread.id}>
      <div className="issue-card-header">
        <IconButton title={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
          <ChevronIcon expanded={open} />
        </IconButton>
        <span className="issue-card-title">
          {named`${thread.path}`}
          {thread.line !== undefined && `, line ${thread.line}`}
        </span>
        {thread.outdated && <span className="issue-label">Outdated</span>}
        {thread.resolved && <span className="issue-label">Resolved</span>}
      </div>
      {open &&
        thread.comments.map((comment) => (
          <div key={comment.id} className="review-thread-comment">
            <div className="review-thread-comment-header">
              <Person login={comment.author} avatar={avatars[comment.author]} />
              <span className="issue-card-title">
                <span className="issue-card-author">{comment.author}</span> {agoOf(comment.createdAt)}
              </span>
            </div>
            <TrackedText {...rendering} text={comment.body} />
          </div>
        ))}
    </div>
  );
}

export function assigneesMessage(actor: string, assigned: string[], unassigned: string[]): React.ReactNode {
  const added = assigned.length === 1 && assigned[0] === actor ? "self-assigned this" : <>assigned {listed(assigned, login)}</>;
  const taken =
    unassigned.length === 1 && unassigned[0] === actor ? "removed their assignment" : <>unassigned {listed(unassigned, login)}</>;
  if (assigned.length > 0 && unassigned.length > 0) {
    return (
      <>
        {added} and {taken}
      </>
    );
  }
  return assigned.length > 0 ? added : taken;
}

export function labelsMessage(added: string[], removed: string[]): React.ReactNode {
  const noun = added.length + removed.length > 1 ? "labels" : "label";
  if (added.length > 0 && removed.length > 0) {
    return (
      <>
        added {listed(added, label)} and removed {listed(removed, label)} {noun}
      </>
    );
  }
  const names = added.length > 0 ? added : removed;
  return (
    <>
      {added.length > 0 ? "added" : "removed"} {names.length === 1 && "the "}
      {listed(names, label)} {noun}
    </>
  );
}

export function eventMessage(event: ThreadEvent, noun: string): React.ReactNode {
  switch (event.kind) {
    case "closed":
      return `closed this ${noun}`;
    case "reopened":
      return `reopened this ${noun}`;
    case "merged":
      return `merged this ${noun}`;
    case "review-requested":
      return <>requested a review from {login(event.login)}</>;
    case "reviewed":
      return event.review === "approved" ? "approved these changes" : "requested changes";
    case "pushed":
      return `pushed ${event.commits === 1 ? "a commit" : `${event.commits} commits`}`;
    case "assignees":
      return assigneesMessage(event.actor, event.assigned, event.unassigned);
    case "labels":
      return labelsMessage(event.added, event.removed);
    case "milestoned":
      return <>added this to the {login(event.milestone)} milestone</>;
    case "demilestoned":
      return <>removed this from the {login(event.milestone)} milestone</>;
    case "renamed":
      return (
        <>
          changed the title <del className="issue-event-old">{event.from}</del> <ins className="issue-event-new">{event.to}</ins>
        </>
      );
    case "linked":
      return (
        <>
          linked <ActionLink onClick={() => void window.tet.shell.openUrl(event.url)}>#{event.number}</ActionLink> {event.title}
        </>
      );
    case "text":
      return event.text;
  }
}

/** A line of the thread saying what happened, as the plugin's timeline draws one. */
export function TrackedEventLine({ event, noun }: { event: ThreadEvent; noun: string }) {
  return (
    <div className="issue-event">
      <span className="issue-event-dot" />
      <span className="issue-event-message">
        {login(event.actor)} {eventMessage(event, noun)} <span className="issue-event-time">{agoOf(event.createdAt)}</span>
      </span>
    </div>
  );
}
