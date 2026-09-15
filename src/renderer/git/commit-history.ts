import type { PromptHistoryLists } from "../ui/Dialog";

/** The commit dialog's per-project history: the last ten messages, newest first, and up to five
 *  pinned. In `localStorage` under `tet.dialog.` — about this window's dialogs, not the repository. */
export type CommitHistory = PromptHistoryLists;

export const MAX_PINNED = 5;
const MAX_RECENT = 10;

function storageKey(projectId: string): string {
  return `tet.dialog.commitHistory.${projectId}`;
}

/** Only strings, up to the cap, whatever was stored. */
function readList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, cap);
}

/** Defensive: an unparseable shape is an empty history, never an error. Caps apply on read too. */
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

/** On submit, whether or not the commit succeeds. A pinned message stays put; a recent one moves
 *  to the front; the eleventh pushes the oldest out. */
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

export function deleteCommitMessage(projectId: string, text: string): CommitHistory {
  const history = loadCommitHistory(projectId);
  const next = {
    pinned: history.pinned.filter((entry) => entry !== text),
    recent: history.recent.filter((entry) => entry !== text)
  };
  save(projectId, next);
  return next;
}

/** Pins to the end (pin order is display order) or unpins to the front of the recents. Past the
 *  cap it changes nothing — a stale view may not have disabled its pin buttons yet. */
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
