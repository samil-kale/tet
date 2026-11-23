import type { TrackedEvent, TrackedNote, ReviewThread } from "../../../shared/types/providers";

/** One actor's changes of assignees or labels this close together read as one line. */
const CONSOLIDATION_WINDOW_MS = 10 * 60 * 1000;

interface Happened {
  actor: string;
  createdAt: string;
}

/** An event as its line shows it: assignments and labels gathered, each named once. */
export type ThreadEvent =
  | Exclude<TrackedEvent, { kind: "assigned" | "unassigned" | "labeled" | "unlabeled" }>
  | (Happened & { kind: "assignees"; assigned: string[]; unassigned: string[] })
  | (Happened & { kind: "labels"; added: string[]; removed: string[] });

export type ThreadEntry = { note: TrackedNote } | { event: ThreadEvent } | { review: ReviewThread };

function withName(names: string[], name: string): string[] {
  return names.includes(name) ? names : [...names, name];
}

/** `event` gathered into the entry before it, where it continues that one's changes. */
function gathered(last: ThreadEntry | undefined, event: TrackedEvent): ThreadEvent | undefined {
  if (!last || !("event" in last) || last.event.actor !== event.actor) {
    return undefined;
  }
  const previous = last.event;
  if (Date.parse(previous.createdAt) + CONSOLIDATION_WINDOW_MS <= Date.parse(event.createdAt)) {
    return undefined;
  }
  if (previous.kind === "assignees" && event.kind === "assigned") {
    return { ...previous, assigned: withName(previous.assigned, event.login) };
  }
  if (previous.kind === "assignees" && event.kind === "unassigned") {
    return { ...previous, unassigned: withName(previous.unassigned, event.login) };
  }
  if (previous.kind === "labels" && event.kind === "labeled") {
    return { ...previous, added: withName(previous.added, event.label) };
  }
  if (previous.kind === "labels" && event.kind === "unlabeled") {
    return { ...previous, removed: withName(previous.removed, event.label) };
  }
  return undefined;
}

/** `event` as a line of its own. */
function shown(event: TrackedEvent): ThreadEvent {
  const happened = { actor: event.actor, createdAt: event.createdAt };
  switch (event.kind) {
    case "assigned":
      return { ...happened, kind: "assignees", assigned: [event.login], unassigned: [] };
    case "unassigned":
      return { ...happened, kind: "assignees", assigned: [], unassigned: [event.login] };
    case "labeled":
      return { ...happened, kind: "labels", added: [event.label], removed: [] };
    case "unlabeled":
      return { ...happened, kind: "labels", added: [], removed: [event.label] };
    case "closed":
    case "reopened":
    case "milestoned":
    case "demilestoned":
    case "renamed":
    case "linked":
    case "review-requested":
    case "reviewed":
    case "pushed":
    case "merged":
    case "text":
      return event;
  }
}

/** An issue's comments and events, and a change request's review threads at their first comment, in
 *  the order they happened; a comment made with a change, at the same moment, comes first. */
export function trackedThread(notes: TrackedNote[], events: TrackedEvent[], reviews: ReviewThread[] = []): ThreadEntry[] {
  const happened = [
    ...notes.map((note) => ({ at: note.createdAt, note })),
    ...reviews.map((review) => ({ at: review.comments[0].createdAt, review })),
    ...events.map((event) => ({ at: event.createdAt, event })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const thread: ThreadEntry[] = [];
  for (const entry of happened) {
    if ("note" in entry) {
      thread.push({ note: entry.note });
      continue;
    }
    if ("review" in entry) {
      thread.push({ review: entry.review });
      continue;
    }
    const merged = gathered(thread.at(-1), entry.event);
    if (merged) {
      thread[thread.length - 1] = { event: merged };
    } else {
      thread.push({ event: shown(entry.event) });
    }
  }
  return thread;
}
