import { filled, prompt } from "../ui/Dialog";
import { SuggestField } from "../ui/Field";
import { addAnnotation, annotationOf, readSelection, setComment } from "./annotate-views";

/** The comment on the marked text, which the title quotes as far as it fits (`.dialog-title` fades);
 *  `current` is the one being edited. */
function askComment(quote: string, current?: string): Promise<string | null> {
  const editing = current !== undefined;
  return prompt({
    title: `${editing ? "Edit Comment" : "Comment"} on "${quote}"`,
    confirmLabel: editing ? "Save" : "Comment",
    value: current ?? "",
    ready: filled,
    render: ({ value, onChange, busy, error, field }) => (
      <SuggestField
        label="Comment"
        value={value}
        onChange={onChange}
        disabled={busy}
        multiline
        sizeKey="annotate-comment"
        ref={field}
        error={error}
      />
    ),
  });
}

/** Asks for the comment before marking, so the selection is read while it still stands. */
export async function commentOnSelection(key: string): Promise<void> {
  const selected = readSelection(key);
  if (!selected) {
    return;
  }
  const comment = await askComment(selected.text);
  if (comment !== null) {
    addAnnotation(key, "comment", selected, comment.trim());
  }
}

export async function editComment(key: string, annotationId: number): Promise<void> {
  const annotation = annotationOf(key, annotationId);
  if (!annotation) {
    return;
  }
  const comment = await askComment(annotation.text, annotation.comment ?? "");
  if (comment !== null) {
    setComment(key, annotationId, comment.trim());
  }
}
