/* What a row dragged onto a terminal carries, typed there (terminal-views.ts). Types of TET's own,
 * no text: a field or an editor takes nothing of them. */

/** The row's path on this machine (`TreeRow`'s `dragPath`). */
export const PATH_DRAG_TYPE = "application/x-tet-path";
/** What the row names, a `DragName` as JSON. */
export const NAME_DRAG_TYPE = "application/x-tet-name";

/** What a row names, for a tab to be told which one is meant. */
export interface DragName {
  /** What `name` is, as typed before it where the tab's agent reads prose (AgentInfo.labelsDrops):
   *  "branch", "commit", "tet project". */
  kind: string;
  /** As git or TET knows it: a branch with its remote, a commit's full hash, a stash's ref. */
  name: string;
}

/** Carried beside whatever else the row's drag holds, a list's own type to reorder it by. */
export function setDragName(transfer: DataTransfer, name: DragName): void {
  transfer.setData(NAME_DRAG_TYPE, JSON.stringify(name));
}
