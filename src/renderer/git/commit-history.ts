/** The commit dialog's message history, per project: the last ten messages as submitted, newest
 *  first, and up to five pinned. Kept in `localStorage` under the `tet.dialog.` namespace — a
 *  fact about this window's dialogs, not about the repository. */
export interface CommitHistory {
  /** Pin order is display order. */
  pinned: string[];
  /** Newest first. */
  recent: string[];
}

export const MAX_PINNED = 5;
const MAX_RECENT = 10;

function storageKey(projectId: string): string {
  return `tet.dialog.commitHistory.${projectId}`;
}

/** Only the strings, only up to the cap — whatever shape the stored value turned out to be. */
function readList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, cap);
}

/** Read back defensively: a shape that does not parse is an empty history, never an error. The
 *  caps hold on the way in too. */
export function loadCommitHistory(projectId: string): CommitHistory {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (raw === null) {
      return { pinned: [], recent: [] };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { pinned: [], recent: [] };
    }
    const { pinned, recent } = parsed as Record<string, unknown>;
    return { pinned: readList(pinned, MAX_PINNED), recent: readList(recent, MAX_RECENT) };
  } catch {
    return { pinned: [], recent: [] };
  }
}

function save(projectId: string, history: CommitHistory): void {
  localStorage.setItem(storageKey(projectId), JSON.stringify(history));
}

/** Called on submit, whether or not the commit then goes through. A pinned message stays put;
 *  one already recent moves to the front; the eleventh pushes the oldest out. */
export function recordCommitMessage(projectId: string, message: string): void {
  const history = loadCommitHistory(projectId);
  if (history.pinned.includes(message)) {
    return;
  }
  save(projectId, {
    pinned: history.pinned,
    recent: [message, ...history.recent.filter((entry) => entry !== message)].slice(0, MAX_RECENT)
  });
}

/** Removes the message from whichever list holds it. */
export function deleteCommitMessage(projectId: string, text: string): CommitHistory {
  const history = loadCommitHistory(projectId);
  const next = {
    pinned: history.pinned.filter((entry) => entry !== text),
    recent: history.recent.filter((entry) => entry !== text)
  };
  save(projectId, next);
  return next;
}

/** Pins to the end (pin order is display order) or unpins to the front of the recents, pushing
 *  the oldest out. Pinning past the cap returns the lists unchanged, for a stale view whose pin
 *  buttons the dialog has not yet disabled. */
export function toggleCommitPin(projectId: string, text: string): CommitHistory {
  const history = loadCommitHistory(projectId);
  let next: CommitHistory;
  if (history.pinned.includes(text)) {
    next = {
      pinned: history.pinned.filter((entry) => entry !== text),
      recent: [text, ...history.recent.filter((entry) => entry !== text)].slice(0, MAX_RECENT)
    };
  } else {
    if (history.pinned.length >= MAX_PINNED) {
      return history;
    }
    next = {
      pinned: [...history.pinned, text],
      recent: history.recent.filter((entry) => entry !== text)
    };
  }
  save(projectId, next);
  return next;
}
