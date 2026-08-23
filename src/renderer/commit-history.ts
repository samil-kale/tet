/**
 * The commit dialog's message history, per project: the last ten messages as they were
 * submitted, newest first, and up to five the user pinned. Kept in `localStorage` under the
 * same `tet.dialog.` namespace the add-repository dialog keeps its last-picked directory in —
 * a fact about how this window's dialogs are used, not about the repository — and per project,
 * since a message names tickets and branches that mean nothing anywhere else.
 */
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

/**
 * Read back defensively, the way a pane layout is: it is the user's `localStorage`, so a shape
 * that does not parse — or one someone edited by hand — is an empty history, never an error.
 * The caps hold on the way in too, so a stored list cannot grow past what the dialog shows.
 */
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

/**
 * Called on submit, whether or not the commit then goes through — a message whose commit
 * failed is exactly one worth having at hand again. A pinned message stays where the user put
 * it; one already recent moves to the front rather than duplicating; the eleventh pushes the
 * oldest out.
 */
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

/**
 * Pins to the end — pin order is display order, like pinned tabs — or unpins to the front of
 * the recents: the unpinned message is the most recently touched, and the oldest recent falls
 * out, the same rotation an eleventh message causes. Pinning past the cap returns the lists
 * unchanged; the dialog disables the pin buttons there, this holds the line for a stale view.
 */
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
