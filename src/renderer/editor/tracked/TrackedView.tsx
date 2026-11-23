import type { TrackedDetail } from "../../../shared/types/providers";
import type { TrackedSession } from "../../../shared/types/terminals";
import { sectionsOf } from "./tracked-fields";
import { trackedThread } from "./tracked-thread";
import { changeRequestOf, trackedNoun } from "./tracked-words";
import { FieldSection, GroupSection, SessionSection } from "./SideColumn";
import type { TextWriting, TrackedActions } from "./tracked-actions";
import { CommentBox, ReviewThreadCard, TrackedCard, TrackedEventLine } from "./ThreadCards";
import { confirmDeleteOnTracker, TrackedBar } from "./TrackedBar";
import { ChangeRequestCard } from "./ChangeRequestCard";

/**
 * An issue's tab: a bar as a file's, with its actions, title and state, then, as VS Code's GitHub Pull
 * Requests and Issues draws them, the description and comments with a box for one more, and beside
 * them the session linked to it and the fields the tracker keeps of it. Only the viewer's own comments
 * offer to change: what is read of the tracker says nothing of who else may, and a description it
 * refuses says so in a notice, a title in the dialog that asked.
 */
export function TrackedView({
  issue,
  session,
  actions,
}: {
  issue: TrackedDetail;
  session: TrackedSession | undefined;
  actions: TrackedActions;
}) {
  const writing: TextWriting = {
    rendering: {
      provider: issue.provider,
      issueUrl: issue.url,
      loadImage: actions.loadImage,
      openFile: actions.openFile,
      openLink: actions.openLink,
    },
    upload: issue.uploads ? actions.upload : undefined,
    accept: issue.uploads?.extensions?.map((extension) => `.${extension}`).join(","),
  };
  const { viewer } = issue;
  const request = changeRequestOf(issue);
  const noun = trackedNoun(issue).toLowerCase();
  return (
    <>
      <TrackedBar issue={issue} session={session} actions={actions} />
      <div className="issue-view">
        <div className="issue-columns">
          <div className="issue-thread">
            {request && <ChangeRequestCard request={request} viewer={viewer} actions={actions} />}
            <TrackedCard
              author={issue.author}
              avatar={issue.avatars[issue.author]}
              opened
              at={issue.createdAt}
              text={issue.body}
              writing={writing}
              onEdit={(body) => {
                actions.update({ body });
                return Promise.resolve(true);
              }}
            />
            {trackedThread(issue.notes, issue.events, request?.reviewThreads).map((entry, index) => {
              if ("event" in entry) {
                return <TrackedEventLine key={`event${index}`} event={entry.event} noun={noun} />;
              }
              if ("review" in entry) {
                return (
                  <ReviewThreadCard key={entry.review.id} thread={entry.review} avatars={issue.avatars} rendering={writing.rendering} />
                );
              }
              const { note } = entry;
              return (
                <TrackedCard
                  key={note.id}
                  author={note.author}
                  avatar={issue.avatars[note.author]}
                  at={note.createdAt}
                  text={note.body}
                  writing={writing}
                  internal={note.internal}
                  onEdit={note.author === viewer && !note.fixed ? (body) => actions.editComment(note.id, body) : undefined}
                  onDelete={
                    note.author === viewer && !note.fixed
                      ? () => void confirmDeleteOnTracker("comment").then((answer) => (answer ? actions.deleteComment(note.id) : undefined))
                      : undefined
                  }
                />
              );
            })}
            <CommentBox issue={issue} internalNotes={issue.internalNotes === true} actions={actions} writing={writing} />
          </div>
          <div className="issue-side">
            <SessionSection issue={issue} session={session} />
            {sectionsOf(issue.fields).map((section) =>
              "group" in section ? (
                <GroupSection key={section.group} title={section.group} fields={section.fields} avatars={issue.avatars} actions={actions} />
              ) : (
                <FieldSection key={section.field.id} field={section.field} issue={issue} actions={actions} />
              ),
            )}
          </div>
        </div>
      </div>
    </>
  );
}
