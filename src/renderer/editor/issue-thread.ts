import type { IssueEvent, IssueNote } from "../../shared/types/providers";

/** One actor's changes of assignees or labels this close together read as one line. */
const CONSOLIDATION_WINDOW_MS = 10 * 60 * 1000;

interface Happened {
  actor: string;
  createdAt: string;
}

/** An event as its line shows it: assignments and labels gathered, each named once. */
export type ThreadEvent =
  | Exclude<IssueEvent, { kind: "assigned" | "unassigned" | "labeled" | "unlabeled" }>
  | (Happened & { kind: "assignees"; assigned: string[]; unassigned: string[] })
  | (Happened & { kind: "labels"; added: string[]; removed: string[] });

export type ThreadEntry = { note: IssueNote } | { event: ThreadEvent };

function withName(names: string[], name: string): string[] {
  return names.includes(name) ? names : [...names, name];
}

/** `event` gathered into the entry before it, where it continues that one's changes. */
function gathered(last: ThreadEntry | undefined, event: IssueEvent): ThreadEvent | undefined {
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
function shown(event: IssueEvent): ThreadEvent {
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
    case "text":
      return event;
  }
}

/** An issue's comments and events in the order they happened; a comment made with a change, at the
 *  same moment, comes first. */
export function issueThread(notes: IssueNote[], events: IssueEvent[]): ThreadEntry[] {
  const happened = [
    ...notes.map((note) => ({ at: note.createdAt, note })),
    ...events.map((event) => ({ at: event.createdAt, event })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const thread: ThreadEntry[] = [];
  for (const entry of happened) {
    if ("note" in entry) {
      thread.push({ note: entry.note });
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
